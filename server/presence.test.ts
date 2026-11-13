import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from './app.ts'
import { openDb } from './db.ts'
import { PresenceHub } from './presence.ts'
import { seed } from './seed.ts'

let server: Server
let base = ''
const hub = new PresenceHub()
const users: Record<string, string> = {}
const streams: AbortController[] = []

async function call(method: string, path: string, user: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User': users[user], ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  // oxlint-disable-next-line typescript/no-explicit-any
  const json: any = res.status === 204 ? null : await res.json()
  return { status: res.status, json }
}

interface SseEvent {
  event: string
  // oxlint-disable-next-line typescript/no-explicit-any
  data: any
}

/** Opens a presence stream and returns a function that waits for the next event matching `pred`. */
async function openStream(table: string, id: string, user: string, client: string) {
  const ctrl = new AbortController()
  streams.push(ctrl)
  const res = await fetch(`${base}/api/now/presence/${table}/${id}/stream?user=${users[user]}&client=${client}`, { signal: ctrl.signal })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  const queue: SseEvent[] = []
  const next = async (pred: (e: SseEvent) => boolean): Promise<SseEvent> => {
    for (;;) {
      const i = queue.findIndex(pred)
      if (i >= 0) return queue.splice(0, i + 1).pop()!
      const { value, done } = await reader.read()
      if (done) throw new Error('stream closed')
      buf += value
      let sep
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        const event = /^event: (.*)$/m.exec(chunk)?.[1]
        const data = /^data: (.*)$/m.exec(chunk)?.[1]
        if (event && data) queue.push({ event, data: JSON.parse(data) })
      }
    }
  }
  return { next, close: () => ctrl.abort() }
}

before(async () => {
  const db = openDb(':memory:')
  seed(db)
  server = createApp(db, hub).listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  for (const u of ['admin', 'beth.anglin']) {
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_name: u, password: 'demo' }) })
    users[u] = ((await r.json()) as { result: { sys_id: string } }).result.sys_id
  }
})

after(() => {
  for (const s of streams) s.abort()
  hub.close()
  server.closeAllConnections()
  server.close()
})

describe('Live presence', () => {
  it('tracks viewers, editing fields and broadcasts field updates from other users', async () => {
    const inc = (await call('GET', '/api/now/table/incident?sysparm_query=state=2&sysparm_limit=1', 'admin')).json.result[0]
    const a = await openStream('incident', inc.sys_id, 'admin', 'client-admin')
    assert.equal((await a.next((e) => e.event === 'hello')).data.client, 'client-admin')
    const b = await openStream('incident', inc.sys_id, 'beth.anglin', 'client-beth')

    const both = await a.next((e) => e.event === 'presence' && e.data.viewers.length === 2)
    assert.deepEqual(both.data.viewers.map((v: { user: { name: string } }) => v.user.name).sort(), ['Beth Anglin', 'System Administrator'])

    const ed = await call('POST', `/api/now/presence/incident/${inc.sys_id}`, 'beth.anglin', { client: 'client-beth', editing: ['short_description', 'urgency'] })
    assert.equal(ed.status, 200)
    const editing = await a.next((e) => e.event === 'presence' && e.data.viewers.some((v: { editing: string[] }) => v.editing.length))
    assert.deepEqual(editing.data.viewers.find((v: { client: string }) => v.client === 'client-beth').editing, ['short_description', 'urgency'])

    const upd = await call('PATCH', `/api/now/table/incident/${inc.sys_id}`, 'beth.anglin', { short_description: 'Live edit from Beth' }, { 'X-Client-Id': 'client-beth' })
    assert.equal(upd.status, 200)
    const ev = await a.next((e) => e.event === 'record')
    assert.equal(ev.data.type, 'updated')
    assert.equal(ev.data.by.name, 'Beth Anglin')
    assert.equal(ev.data.client, 'client-beth')
    assert.deepEqual(ev.data.fields, ['short_description'])
    assert.equal(ev.data.sys_mod_count, Number(inc.sys_mod_count) + 1)

    await call('POST', `/api/now/journal/incident/${inc.sys_id}`, 'beth.anglin', { element: 'work_notes', value: 'Looking into it' })
    const j = await a.next((e) => e.event === 'record')
    assert.deepEqual([j.data.type, j.data.element], ['journal', 'work_notes'])

    b.close()
    await a.next((e) => e.event === 'presence' && e.data.viewers.length === 1)
    a.close()
  })

  it('rejects a save based on a stale sys_mod_count with 409', async () => {
    const inc = (await call('GET', '/api/now/table/incident?sysparm_query=state=2&sysparm_limit=1&sysparm_offset=1', 'admin')).json.result[0]
    const base0 = Number(inc.sys_mod_count)
    const first = await call('PATCH', `/api/now/table/incident/${inc.sys_id}`, 'beth.anglin', { short_description: 'Beth was first' }, { 'X-Base-Mod-Count': String(base0) })
    assert.equal(first.status, 200)
    assert.equal(first.json.result.sys_mod_count, base0 + 1)
    const stale = await call('PATCH', `/api/now/table/incident/${inc.sys_id}`, 'admin', { short_description: 'Admin was second' }, { 'X-Base-Mod-Count': String(base0) })
    assert.equal(stale.status, 409)
    assert.match(stale.json.error.detail, /beth\.anglin/)
    const fresh = await call('PATCH', `/api/now/table/incident/${inc.sys_id}`, 'admin', { short_description: 'Admin after reload' }, { 'X-Base-Mod-Count': String(base0 + 1) })
    assert.equal(fresh.status, 200)
    const forced = await call('PATCH', `/api/now/table/incident/${inc.sys_id}`, 'admin', { short_description: 'Admin forced' })
    assert.equal(forced.status, 200, 'saves without the header are not version-checked')
  })

  it('requires a known user and an existing record to join', async () => {
    const inc = (await call('GET', '/api/now/table/incident?sysparm_limit=1', 'admin')).json.result[0]
    assert.equal((await fetch(`${base}/api/now/presence/incident/${inc.sys_id}/stream?user=nobody`)).status, 401)
    assert.equal((await fetch(`${base}/api/now/presence/incident/missing/stream?user=${users.admin}`)).status, 404)
    const r = await call('POST', `/api/now/presence/incident/${inc.sys_id}`, 'admin', { client: 'not-joined', editing: [] })
    assert.equal(r.status, 404)
  })
})
