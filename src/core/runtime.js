// Runtime: wires storage, settings, network, models, sessions, agents, tools,
// skills, MCP and the scheduler. The UI talks only to this object.
import { Emitter, shortId, makeError, errorMessage, clone } from './util.js'
import { SettingsStore } from './settings.js'
import { WorkspaceStore } from './workspaces.js'
import { SessionStore, textOfBlocks } from './session.js'
import { createNet } from './net.js'
import { LlmService } from './llm/index.js'
import { Agent, PERMISSION_PRESETS } from './agent.js'
import { FS_TOOLS, sandboxAware, readTool, writeTool, editTool, applyPatchTool, readImageTool, globTool, grepTool } from './tools/fs-tools.js'
import { todoWriteTool, exitPlanModeTool, askUserQuestionTool, presentTool } from './tools/basic-tools.js'
import { createWebSearchTool, createWebFetchTool } from './tools/web-tools.js'
import { createCodeTool } from './tools/code-tool.js'
import { createSubagentTools } from './tools/subagent-tools.js'
import { createWorkflowTool } from './tools/workflow-tool.js'
import { createGoalTools } from './goal.js'
import { ScheduleService, createScheduleTools } from './schedule.js'
import { createSkillTool, discoverSkills, skillRoots, installBundledSkills, renderSkillContent } from './skills.js'
import { findProjectRoot } from './instructions.js'
import { McpManager } from './mcp.js'
import { splitCommand, findCommand } from './commands.js'
import { presetOf } from './prompt.js'
import { DshRemote } from './remote-dsh.js'

void FS_TOOLS

export class Runtime extends Emitter {
  /**
   * platform: {
   *   kind, hint ('wp81' | 'w10m' | 'web' | 'node'),
   *   vfs (with /app, /workspaces, /tmp mounted), http, credentials,
   *   codeRunner?, images?, mountDeviceFolder?, forgetDeviceFolder?, notify?
   * }
   */
  constructor(platform) {
    super()
    this.platform = platform
    this.vfs = platform.vfs
    this.settings = new SettingsStore(this.vfs, platform.credentials)
    this.workspaces = new WorkspaceStore(this.vfs, platform)
    this.sessions = new SessionStore(this.vfs)
    this.net = createNet(platform.http, () => this.gateway())
    this.llm = new LlmService({
      net: this.net,
      getSettings: () => this.settings.get().models,
      getCredential: id => this.settings.getCredential(id),
      gatewayInjectsKey: () => !!(this.gatewayInfo && this.gatewayInfo.injectsKey && this.gateway()),
    })
    this.mcp = new McpManager(this.net, () => this.settings.get().mcp.servers)
    this.schedule = new ScheduleService({ vfs: this.vfs, deliver: task => this.deliverScheduled(task) })
    // desktop dsh behind the gateway's --dsh bridge (sessions that run on the computer)
    this.remote = new DshRemote({ http: platform.http, vfs: this.vfs, gateway: () => { const g = this.settings.get().gateway || {}; return g.url ? { url: g.url.replace(/\/+$/, ''), code: g.code || '' } : null } })
    this.agents = {}
    this.activeSessionId = null
    this.gatewayInfo = null
    this._skills = { at: 0, key: '', list: [] }
    this.env = {
      llm: this.llm,
      net: this.net,
      settings: () => this.settings.get(),
      getCredential: id => this.settings.getCredential(id),
      codeRunner: platform.codeRunner,
      platformHint: () => platform.hint,
      /** Operational diagnostics (run_code outcomes…); the UI forwards them to the gateway log. */
      diagnostic: (kind, data) => this.emit('diagnostic', { kind, data }),
    }
    this.tools = {
      web: [createWebSearchTool(this.env), createWebFetchTool(this.env)],
      code: createCodeTool(this.env),
      goal: createGoalTools(),
      schedule: createScheduleTools(this.schedule),
      subagent: createSubagentTools(this),
      skill: createSkillTool(exec => this.skillsFor(exec.agent)),
      workflow: createWorkflowTool(this),
    }
  }

  async init() {
    await this.vfs.mkdirp('/app')
    await this.vfs.mkdirp('/tmp')
    await this.settings.init()
    await this.workspaces.init()
    await this.sessions.init()
    await this.schedule.init()
    await installBundledSkills(this.vfs).catch(() => {})
    await this.remote.init().catch(() => {})
    if (this.remote.running().length) this.remote.start()
    // sessions that were running when the app closed are idle now
    for (const m of this.sessions.list()) if (m.status && m.status !== 'idle' && m.status !== 'failed') this.sessions.updateMeta(m.id, { status: 'idle' })
    this.settings.on('change', () => { this._skills.at = 0; this.emit('settings') })
    this.schedule.on('change', () => this.emit('schedule'))
    this.sessions.on('index', () => this.emit('sessions'))
    this.workspaces.on('change', () => this.emit('workspaces'))
    this.probeGateway().catch(() => {})
    this.schedule.start()
  }

  // ------------------------------------------------------------------ gateway

  /** Effective gateway: {url, code, route} or null. */
  gateway() {
    const g = this.settings.get().gateway || {}
    if (!g.url) return null
    let route = g.route
    if (route === 'auto') route = this.platform.hint === 'wp81' || this.platform.servedByGateway ? 'https' : 'off'
    return { url: g.url.replace(/\/+$/, ''), code: g.code || '', route }
  }

  async probeGateway() {
    const g = this.settings.get().gateway || {}
    if (!g.url) { this.gatewayInfo = null; return null }
    try {
      const res = await this.platform.http.request({ method: 'GET', url: g.url.replace(/\/+$/, '') + '/gateway/info', headers: g.code ? { 'x-dsh-gateway-code': g.code } : {}, timeoutMs: 6000 })
      this.gatewayInfo = res.status === 200 ? JSON.parse(res.text) : { error: 'HTTP ' + res.status }
    } catch (e) { this.gatewayInfo = { error: errorMessage(e) } }
    this.emit('gateway', this.gatewayInfo)
    return this.gatewayInfo
  }

  // ------------------------------------------------------------------ models

  defaultSelection() {
    const s = this.settings.get().models.defaultSelection
    return { provider: s.provider, model: s.model, effort: s.effort }
  }

  hasUsableModel() {
    try { this.llm.resolve(this.defaultSelection()); return true } catch (e) { return false }
  }

  // ------------------------------------------------------------------ sessions & agents

  async agentFor(sessionId) {
    if (this.agents[sessionId]) return this.agents[sessionId]
    const session = await this.sessions.open(sessionId)
    if (this.agents[sessionId]) return this.agents[sessionId]
    const agent = new Agent(this, session, { name: session.meta.agentName || 'lead' })
    this._attach(agent)
    return agent
  }

  getAgent(sessionId) { return this.agents[sessionId] }

  _attach(agent) {
    this.agents[agent.session.id] = agent
    agent.on('change', () => this.emit('agent', agent))
    agent.on('status', () => this.emit('sessions'))
  }

  /** New Session in a workspace: each workspace reuses one blank session. */
  async newSession(opts = {}) {
    const ws = this.workspaces.get(opts.workspaceId) || this.workspaces.mostRecent()
    if (!ws) throw makeError('NO_WORKSPACE', 'choose a workspace first')
    const blank = this.sessions.list().find(m => m.blank && !m.isSubagent && m.workspaceId === ws.id && !m.archived)
    if (blank) return this.agentFor(blank.id)
    const s = this.settings.get()
    const session = await this.sessions.create({
      workspaceId: ws.id, cwd: ws.path, preset: opts.preset || s.general.defaultPreset || 'standard',
      permission: s.general.defaultPermission, model: this.defaultSelection(),
    })
    this.workspaces.touch(ws.id)
    const agent = new Agent(this, session, {})
    this._attach(agent)
    return agent
  }

  async forkSession(sessionId) {
    const child = await this.sessions.fork(sessionId)
    return this.agentFor(child.id)
  }

  async spawnSubagent(parent, { shortName, name, description, fork, selection }) {
    let session
    if (fork) {
      session = await this.sessions.fork(parent.session.id)
      this.sessions.updateMeta(session.id, { isSubagent: true, parentId: parent.session.id, agentName: name, title: description, titleSource: 'subagent', blank: false })
    } else {
      session = await this.sessions.create({
        isSubagent: true, parentId: parent.session.id, agentName: name, title: description, titleSource: 'subagent',
        workspaceId: parent.meta.workspaceId, cwd: parent.cwd(), preset: parent.meta.preset, blank: false,
        permission: parent.permissionPreset(),
      })
    }
    this.sessions.updateMeta(session.id, { model: selection })
    session.append('model/selection', selection)
    const child = new Agent(this, session, { name, parent, depth: parent.depth + 1, description })
    child.shortName = shortName
    parent.children[shortName] = { agent: child, description, startedAt: Date.now() }
    parent.session.append('subagent/started', { name, sessionId: session.id, description, fork: !!fork })
    this._attach(child)
    return child
  }

  // ------------------------------------------------------------------ tools & skills

  toolsFor(agent, ctx) {
    const s = this.settings.get()
    const preset = presetOf(agent.meta.preset)
    const all = [
      readTool, sandboxAware(writeTool), sandboxAware(editTool),
    ]
    if (s.agent.applyPatch) all.push(sandboxAware(applyPatchTool))
    all.push(readImageTool, globTool, grepTool, todoWriteTool, exitPlanModeTool, askUserQuestionTool, presentTool)
    all.push(...this.tools.web, this.tools.skill, ...this.tools.goal, ...this.tools.schedule, ...this.tools.subagent, this.tools.workflow, this.tools.code)
    all.push(...this.mcp.tools())
    const list = preset.tools === 'all' ? all : all.filter(t => preset.tools.indexOf(t.name) >= 0)
    return list.filter(t => !t.when || t.when(Object.assign({ agent }, ctx)))
  }

  async skillsFor(agent) {
    const root = agent.projectRoot || await findProjectRoot(this.vfs, agent.cwd(), agent.workspaceRoot()).catch(() => agent.workspaceRoot())
    const key = root + '|' + JSON.stringify(this.settings.get().skills)
    if (this._skills.key === key && Date.now() - this._skills.at < 15000) return this._skills.list
    const { skills } = await discoverSkills(this.vfs, skillRoots(root, this.settings.get().skills))
    this._skills = { at: Date.now(), key, list: skills }
    return skills
  }

  // ------------------------------------------------------------------ sending & commands

  /**
   * Send composer input. input: {text, images:[{mime,data,name,width,height}], mode:'queue'|'steer'}
   * Returns {ok} or {command, result}.
   */
  async send(agent, input) {
    const text = String(input.text || '')
    const images = input.images || []
    const cmd = splitCommand(text)
    if (cmd) {
      const def = findCommand(cmd.name)
      if (def) {
        if (images.length && !def.attachments) throw makeError('COMMAND_NO_ATTACHMENTS', `/${def.name} does not accept attachments`)
        return { command: def.name, result: await this.runCommand(agent, def.name, cmd.args, images) }
      }
      const skills = await this.skillsFor(agent).catch(() => [])
      const skill = skills.find(sk => sk.name === cmd.name && sk.userInvocable)
      if (skill) {
        const content = [{ type: 'text', text: renderSkillContent(skill) }]
        if (cmd.args) content.push({ type: 'text', text: cmd.args })
        for (const im of images) content.push(Object.assign({ type: 'image' }, im))
        agent.prompt({ content, source: { kind: 'human', skill: skill.name }, displayText: text }, input.mode)
        return { ok: true, skill: skill.name }
      }
    }
    if (!text.trim() && !images.length) return { ok: false }
    const content = []
    if (text.trim()) content.push({ type: 'text', text })
    for (const im of images) content.push(Object.assign({ type: 'image' }, im))
    agent.prompt({ content, source: { kind: 'human' } }, input.mode)
    if (agent.meta.workspaceId) this.workspaces.touch(agent.meta.workspaceId)
    return { ok: true }
  }

  async runCommand(agent, name, args, images) {
    switch (name) {
      case 'compact': {
        if (agent.running) throw makeError('BUSY', 'wait for the current turn to finish before compacting')
        agent.session.append('command/run', { name: 'compact' })
        const r = await agent.compact({ reason: 'command' })
        return r
      }
      case 'plan': {
        if (args === 'off') { agent.setPlanMode(false, 'user'); return { planMode: false } }
        agent.setPlanMode(true, 'user')
        if (args || (images && images.length)) {
          const content = args ? [{ type: 'text', text: args }] : []
          for (const im of images || []) content.push(Object.assign({ type: 'image' }, im))
          agent.prompt({ content, source: { kind: 'human' } }, agent.running ? 'steer' : 'queue')
        }
        return { planMode: true }
      }
      case 'goal': {
        const g = agent.goal
        const a = String(args || '').trim()
        if (!a) return { goal: g.get(), armed: g.armed }
        if (a === 'clear') { g.clear(); return { goal: null } }
        if (a === 'pause') return { goal: g.pause() }
        if (a === 'resume') { const r = g.resume(); if (!agent.running) g.maybeContinue(); return { goal: r } }
        if (a.indexOf('edit ') === 0) return { goal: g.update({ objective: a.slice(5).trim() }, 'edit') }
        agent.session.append('user/command', { name: 'goal', text: a })
        const goal = g.create(a, undefined, 'human')
        if (!agent.running) g.maybeContinue()
        return { goal }
      }
      case 'permission': {
        if (!args) return { preset: agent.permissionPreset(), presets: Object.keys(PERMISSION_PRESETS) }
        const map = { readonly: 'read-only', 'read-only': 'read-only', workspace: 'workspace-write', 'workspace-write': 'workspace-write', full: 'danger-full-access', 'danger-full-access': 'danger-full-access' }
        const preset = map[args] || args
        if (!PERMISSION_PRESETS[preset]) throw makeError('UNKNOWN_PRESET', `unknown permission preset: ${args}`)
        agent.setPermission(preset)
        return { preset }
      }
      case 'feedback': {
        agent.session.append('feedback', { text: args, rating: null })
        return { recorded: !!args }
      }
      case 'export':
        return { jsonl: await this.sessions.exportJsonl(agent.session.id) }
      default:
        return { clientOnly: true }
    }
  }

  continueGeneration(agent) {
    agent.session.append('user/continue', {})
    agent.prompt({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'continue' } }, 'queue')
  }

  // ------------------------------------------------------------------ schedule delivery

  async deliverScheduled(task) {
    let agent
    if (task.target === 'this_session' && task.sessionId && this.sessions.getMeta(task.sessionId)) agent = await this.agentFor(task.sessionId)
    else if (task.target === 'new_once' && task.sessionId && this.sessions.getMeta(task.sessionId)) agent = await this.agentFor(task.sessionId)
    else {
      const ws = this.workspaces.get(task.workspaceId) || this.workspaces.mostRecent()
      const session = await this.sessions.create({ workspaceId: ws && ws.id, cwd: task.cwd || (ws && ws.path) || '/', preset: task.preset || 'standard', model: this.defaultSelection(), permission: this.settings.get().general.defaultPermission, title: task.title, titleSource: 'schedule', blank: false })
      agent = new Agent(this, session, {})
      this._attach(agent)
    }
    agent.prompt({ content: [{ type: 'text', text: task.prompt }], source: { kind: 'schedule', taskId: task.id, title: task.title } }, 'queue')
    this.notify('schedule', agent, { title: task.title })
    return { sessionId: agent.session.id }
  }

  // ------------------------------------------------------------------ hooks from agents

  onAgentIdle(agent) { this.emit('agent', agent) }

  noteFileChanged(agent, path) { this.emit('file-changed', { sessionId: agent.session.id, path }) }

  notify(kind, agent, data) {
    this.emit('notify', { kind, sessionId: agent.session.id, title: agent.meta.title, data })
    if (this.platform.notify && this.settings.get().general.notifications) {
      try { this.platform.notify(kind, agent, data) } catch (e) { /* toast failures are cosmetic */ }
    }
  }

  async exportMarkdown(sessionId) {
    const s = await this.sessions.open(sessionId)
    const lines = [`# ${s.meta.title || 'Untitled'}`, '']
    for (const ev of s.events) {
      if (ev.type === 'user/message' && (!ev.data.source || ev.data.source.kind === 'human')) lines.push('**User:** ' + (ev.data.displayText || textOfBlocks(ev.data.content)), '')
      else if (ev.type === 'assistant/message') {
        const t = textOfBlocks(ev.data.content)
        if (t) lines.push('**Assistant:** ' + t, '')
        for (const b of ev.data.content || []) if (b.type === 'tool-call') lines.push(`> tool \`${b.name}\` ${b.arguments ? b.arguments.slice(0, 200) : ''}`, '')
      }
    }
    return lines.join('\n')
  }

  async flush() {
    this.settings.flush()
    await this.sessions.flushAll()
  }
}

export { clone, shortId }
