// Phone ↔ gateway ↔ ACP agent, end to end: the real gateway runs the ACP mock
// (tests/acp-mock.mjs) in place of `dsh --profile acp`, and the phone-side
// client (src/core/remote-dsh.js) drives it over HTTP.
// Usage: node --test tests/remote-dsh.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNodeHttp } from '../src/platform/http-node.js'
import { Vfs, MemoryBackend } from '../src/core/vfs.js'
import { DshRemote, hasPending } from '../src/core/remote-dsh.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 18000 + Math.floor(Math.random() * 1000)
const CODE = '424242'
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-')))
fs.writeFileSync(path.join(work, 'alpha.txt'), 'a')
fs.mkdirSync(path.join(work, 'sub'))

let gw
test.before(async () => {
  gw = spawn(process.execPath, [path.join(root, 'gateway/server.mjs'), '--host', '127.0.0.1', '--port', String(PORT), '--code', CODE,
    '--dsh', process.execPath, '--dsh-arg', path.join(root, 'tests/acp-mock.mjs'), '--dsh-root', work], { stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((resolve, reject) => {
    gw.stdout.on('data', d => { if (/desktop dsh/.test(String(d))) resolve() })
    gw.on('exit', c => reject(new Error('gateway exited ' + c)))
  })
})
test.after(() => { gw.kill(); fs.rmSync(work, { recursive: true, force: true }) })

function client(code = CODE) {
  const vfs = new Vfs()
  vfs.mount('/app', new MemoryBackend())
  return new DshRemote({ http: createNodeHttp(), gateway: () => ({ url: 'http://127.0.0.1:' + PORT, code }), vfs })
}

function until(remote, pred, ms = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      let v
      try { v = pred() } catch (e) { v = false }
      if (v) return resolve(v)
      if (Date.now() - t0 > ms) return reject(new Error('timed out; state ' + remote.state + ' ' + (remote.error || '')))
      setTimeout(tick, 50)
    }
    tick()
  })
}

test('the access code is required', async () => {
  await assert.rejects(client('000000').refreshInfo(), /access code/)
})

test('folders stay inside the allowed roots', async () => {
  const r = client()
  const ls = await r.ls(work)
  assert.deepEqual(ls.dirs, ['sub'])
  await assert.rejects(r.ls('/'), /outside the allowed folders/)
  await assert.rejects(r.newSession('/'), /inside the allowed folders/)
})

test('prompt, approve, reject, cancel', async () => {
  const r = client()
  await r.init()
  const s = await r.newSession(work)
  assert.ok(s.id && s.epoch, 'session is live')
  assert.equal(s.config[0].currentValue, 'deepseek-flash')

  // 1) a plain turn: thought, message, tool with output, message, end
  await r.prompt(s.id, 'list it')
  await until(r, () => !r.get(s.id).running)
  let kinds = r.get(s.id).items.map(i => i.kind)
  assert.deepEqual(kinds, ['user', 'thought', 'message', 'tool', 'message', 'end'])
  const tool = r.get(s.id).items[3]
  assert.equal(tool.status, 'completed')
  assert.match(tool.output, /alpha\.txt/)
  assert.equal(r.get(s.id).items[5].stopReason, 'end_turn')
  assert.equal(r.get(s.id).usage.size, 1048576)

  // 2) permission granted
  await r.prompt(s.id, 'ask first')
  const perm = await until(r, () => r.get(s.id).items.filter(i => i.kind === 'permission' && !i.decided)[0])
  assert.equal(r.get(s.id).pending, perm.requestId)
  assert.equal(perm.requestId, 0, 'the first agent request has id 0, like dsh')
  assert.ok(hasPending(r.get(s.id)), 'id 0 still counts as waiting')
  await r.answer(s.id, perm.requestId, 'allow-once')
  await until(r, () => !r.get(s.id).running)
  let last = r.get(s.id).items.filter(i => i.kind === 'tool').pop()
  assert.equal(last.status, 'completed')

  // 3) permission rejected
  await r.prompt(s.id, 'ask again')
  const p2 = await until(r, () => r.get(s.id).items.filter(i => i.kind === 'permission' && !i.decided)[0])
  await r.answer(s.id, p2.requestId, 'reject-once')
  await until(r, () => !r.get(s.id).running)
  last = r.get(s.id).items.filter(i => i.kind === 'tool').pop()
  assert.equal(last.status, 'failed')

  // 4) cancelled while working
  await r.prompt(s.id, 'slow job')
  await until(r, () => r.get(s.id).items.some(i => i.kind === 'thought' && /slow job/.test(i.text)))
  await r.cancel(s.id)
  await until(r, () => !r.get(s.id).running)
  assert.equal(r.get(s.id).items.pop().stopReason, 'cancelled')

  // another client's sessions on the same gateway stay out of this one
  const other = client()
  await other.init()
  other.start()
  const theirs = await other.newSession(work)
  await other.prompt(theirs.id, 'list it')
  await until(other, () => !other.get(theirs.id).running)
  await new Promise(res => setTimeout(res, 300))
  assert.equal(r.get(theirs.id), undefined, 'did not adopt the other client\'s session')
  other.stop()

  // the computer's own session list, and the local copy survives a restart
  const listed = await r.remoteList(work)
  assert.ok(listed.some(x => x.sessionId === s.id))
  r.stop()
  await new Promise(res => setTimeout(res, 800))
  const again = new DshRemote({ http: createNodeHttp(), gateway: r.gateway, vfs: r.vfs })
  await again.init()
  assert.equal(again.get(s.id).items.length, r.get(s.id).items.length)
  await again.remove(s.id)
  assert.equal(again.get(s.id), undefined)
})

// last: it locks this address out of the gateway for 10 minutes
test('wrong access codes lock the address out', async () => {
  const bad = client('999999')
  for (let i = 0; i < 10; i++) await assert.rejects(bad.refreshInfo())
  await assert.rejects(client().refreshInfo(), /too many wrong access codes/)
})
