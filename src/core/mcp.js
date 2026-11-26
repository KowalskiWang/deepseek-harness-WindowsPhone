// MCP client over Streamable HTTP (JSON-RPC 2.0). Phones cannot spawn stdio
// servers, so only remote (HTTP) MCP servers are supported. Tools surface as
// mcp__<server>__<tool>, plus the resource tools of upstream dsh-mcp-resources.
import { safeJsonParse, makeError, errorMessage } from './util.js'
import { createSseParser } from './llm/sse.js'
import { textOutput } from './tools/runtime.js'

const PROTOCOL_VERSION = '2025-06-18'

export class McpClient {
  constructor(net, server) {
    this.net = net
    this.server = server // {id, name, url, headers, enabled}
    this.sessionId = null
    this.seq = 0
    this.tools = []
    this.instructions = ''
    this.state = 'idle'
    this.error = null
  }

  async rpc(method, params, signal) {
    const id = ++this.seq
    const headers = Object.assign({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION }, this.server.headers || {})
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    const res = await this.net.request({ method: 'POST', url: this.server.url, headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }), signal, timeoutMs: 120000 })
    if (res.headers['mcp-session-id']) this.sessionId = res.headers['mcp-session-id']
    if (res.status >= 400) throw makeError('MCP_HTTP', `MCP server ${this.server.id} returned HTTP ${res.status}: ${String(res.text).slice(0, 200)}`)
    let message = null
    if (/text\/event-stream/.test(res.headers['content-type'] || '')) {
      const parser = createSseParser((ev) => {
        const m = safeJsonParse(ev.data, null)
        if (m && m.id === id) message = m
      })
      parser.push(res.text)
      parser.end()
    } else message = safeJsonParse(res.text, null)
    if (!message) throw makeError('MCP_PROTOCOL', `MCP server ${this.server.id} sent no response to ${method}`)
    if (message.error) throw makeError('MCP_ERROR', `${method}: ${message.error.message || JSON.stringify(message.error)}`)
    return message.result
  }

  async notify(method) {
    const headers = Object.assign({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION }, this.server.headers || {})
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    try { await this.net.request({ method: 'POST', url: this.server.url, headers, body: JSON.stringify({ jsonrpc: '2.0', method }), timeoutMs: 15000 }) } catch (e) { /* best effort */ }
  }

  async connect() {
    this.state = 'connecting'
    try {
      const init = await this.rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'dsh-mobile', version: typeof __DSH_VERSION__ !== 'undefined' ? __DSH_VERSION__ : 'dev' } })
      this.instructions = (init && init.instructions) || ''
      this.capabilities = (init && init.capabilities) || {}
      await this.notify('notifications/initialized')
      const tools = []
      let cursor
      do {
        const r = await this.rpc('tools/list', cursor ? { cursor } : {})
        for (const t of (r && r.tools) || []) tools.push(t)
        cursor = r && r.nextCursor
      } while (cursor)
      this.tools = tools
      this.state = 'ready'
      this.error = null
    } catch (e) {
      this.state = 'error'
      this.error = errorMessage(e)
    }
    return this
  }

  async callTool(name, args, signal) {
    return this.rpc('tools/call', { name, arguments: args || {} }, signal)
  }
}

function toolName(serverId, name) {
  return ('mcp__' + serverId + '__' + name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

function renderContent(result) {
  const content = []
  for (const c of (result && result.content) || []) {
    if (c.type === 'text') content.push({ type: 'text', text: c.text })
    else if (c.type === 'image') content.push({ type: 'image', mime: c.mimeType || 'image/png', data: c.data })
    else if (c.type === 'resource') content.push({ type: 'text', text: c.resource && (c.resource.text || `[resource ${c.resource.uri}]`) })
    else if (c.type === 'resource_link') content.push({ type: 'text', text: `[${c.name || c.uri}](${c.uri})` })
    else content.push({ type: 'text', text: JSON.stringify(c) })
  }
  if (result && result.structuredContent && !content.length) content.push({ type: 'text', text: JSON.stringify(result.structuredContent) })
  if (!content.length) content.push({ type: 'text', text: '(empty result)' })
  return content
}

export class McpManager {
  constructor(net, getServers) {
    this.net = net
    this.getServers = getServers
    this.clients = {}
    this.signature = ''
  }

  async refresh(force) {
    const servers = (this.getServers() || []).filter(s => s.enabled !== false && s.url)
    const sig = JSON.stringify(servers)
    if (!force && sig === this.signature) return
    this.signature = sig
    const next = {}
    await Promise.all(servers.map(async (s) => {
      const c = new McpClient(this.net, s)
      next[s.id] = c
      await c.connect()
    }))
    this.clients = next
  }

  status() {
    return Object.keys(this.clients).map(id => ({ id, state: this.clients[id].state, error: this.clients[id].error, tools: this.clients[id].tools.length }))
  }

  instructionsSection() {
    const parts = []
    for (const id in this.clients) {
      const c = this.clients[id]
      if (c.state === 'ready' && c.instructions) parts.push(`## ${c.server.name || id}\n${c.instructions}`)
    }
    return parts.length ? '# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n' + parts.join('\n\n') : ''
  }

  tools() {
    const defs = []
    for (const id in this.clients) {
      const c = this.clients[id]
      if (c.state !== 'ready') continue
      for (const t of c.tools) {
        defs.push({
          name: toolName(id, t.name),
          description: t.description || `MCP tool ${t.name} from ${id}`,
          parameters: t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} },
          readOnly: !!(t.annotations && t.annotations.readOnlyHint),
          isConcurrencySafe: () => !!(t.annotations && t.annotations.readOnlyHint),
          timeoutMs: 120000,
          async execute(args, exec) {
            const r = await c.callTool(t.name, args, exec.signal)
            return { content: renderContent(r), isError: !!(r && r.isError), display: { kind: 'mcp', server: id, tool: t.name } }
          },
        })
      }
    }
    if (Object.keys(this.clients).some(id => this.clients[id].state === 'ready')) defs.push(...this.resourceTools())
    return defs
  }

  resourceTools() {
    const client = (server) => {
      const c = this.clients[server]
      if (!c || c.state !== 'ready') throw makeError('MCP_UNKNOWN_SERVER', `unknown or unavailable MCP server: ${server}`)
      return c
    }
    return [
      {
        name: 'list_mcp_resources',
        description: 'List resources provided by an MCP server.',
        parameters: { type: 'object', properties: { server: { type: 'string', description: 'MCP server id.' }, cursor: { type: 'string', description: 'Pagination cursor from a previous result.' } }, required: ['server'] },
        readOnly: true, isConcurrencySafe: () => true,
        async execute(args, exec) { return textOutput(JSON.stringify(await client(args.server).rpc('resources/list', args.cursor ? { cursor: args.cursor } : {}, exec.signal), null, 1)) },
      },
      {
        name: 'list_mcp_resource_templates',
        description: 'List resource templates provided by an MCP server.',
        parameters: { type: 'object', properties: { server: { type: 'string', description: 'MCP server id.' }, cursor: { type: 'string', description: 'Pagination cursor from a previous result.' } }, required: ['server'] },
        readOnly: true, isConcurrencySafe: () => true,
        async execute(args, exec) { return textOutput(JSON.stringify(await client(args.server).rpc('resources/templates/list', args.cursor ? { cursor: args.cursor } : {}, exec.signal), null, 1)) },
      },
      {
        name: 'read_mcp_resource',
        description: 'Read one resource from an MCP server by URI.',
        parameters: { type: 'object', properties: { server: { type: 'string', description: 'MCP server id.' }, uri: { type: 'string', description: 'Resource URI.' } }, required: ['server', 'uri'] },
        readOnly: true, isConcurrencySafe: () => true,
        async execute(args, exec) {
          const r = await client(args.server).rpc('resources/read', { uri: args.uri }, exec.signal)
          const parts = ((r && r.contents) || []).map(c => c.text != null ? c.text : `[${c.mimeType || 'binary'} ${c.uri}]`)
          return textOutput(parts.join('\n\n') || '(empty resource)')
        },
      },
    ]
  }
}
