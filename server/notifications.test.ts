import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from './app.ts'
import { getRecord, openDb } from './db.ts'
import type { Db, Row } from './db.ts'
import { seed } from './seed.ts'
import { notifyJournal, notifyRecordChange } from './notifications.ts'
import type { NotifyActor } from './notifications.ts'
import { parseMentions, splitMentions } from '../shared/mentions.ts'

describe('mention parsing', () => {
  it('extracts unique, lower-cased user names', () => {
    assert.deepEqual(parseMentions('@beth.anglin please check with @David.Loo and @beth.anglin'), ['beth.anglin', 'david.loo'])
  })
  it('ignores trailing punctuation, emails and bare @', () => {
    assert.deepEqual(parseMentions('Thanks @beth.anglin. Ping fred@example.com or @ (@admin)'), ['beth.anglin', 'admin'])
    assert.deepEqual(parseMentions('no mentions here'), [])
  })
  it('splits text into plain and mention parts that round-trip', () => {
    const text = 'Hi @abel.tuter, see @itil!'
    const parts = splitMentions(text)
    assert.equal(parts.map((p) => p.text).join(''), text)
    assert.deepEqual(parts.filter((p) => p.mention).map((p) => p.mention), ['abel.tuter', 'itil'])
  })
})

describe('notification rules', () => {
  let db: Db
  const users: Record<string, NotifyActor> = {}
  const count = (userName: string, type?: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM sys_notification WHERE recipient = ?${type ? ' AND type = ?' : ''}`).get(...[users[userName].sys_id, ...(type ? [type] : [])]) as { n: number }).n
  const incidentFor = (caller: string): Row => {
    const inc = db.prepare("SELECT * FROM incident WHERE caller_id = ? AND state IN ('1','2','3') LIMIT 1").get(users[caller].sys_id) as Row | undefined
    if (inc) return inc
    const any = db.prepare("SELECT * FROM incident WHERE state IN ('1','2','3') LIMIT 1").get() as Row
    db.prepare('UPDATE incident SET caller_id = ? WHERE sys_id = ?').run(users[caller].sys_id, any.sys_id)
    return getRecord(db, 'incident', String(any.sys_id))
  }

  beforeEach(() => {
    db = openDb(':memory:')
    seed(db)
    db.exec('DELETE FROM sys_notification')
    for (const u of db.prepare('SELECT sys_id, user_name, name, role FROM sys_user').all() as unknown as NotifyActor[]) users[u.user_name] = u
  })

  it('notifies the new assignee, but not on self-assignment or unchanged assignee', () => {
    const inc = incidentFor('abel.tuter')
    const next = { ...inc, assigned_to: users['beth.anglin'].sys_id }
    const out = notifyRecordChange(db, 'incident', { ...inc, assigned_to: null }, next, users.admin)
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'assigned')
    assert.match(String(out[0].message), /assigned to you by System Administrator/)
    assert.equal(notifyRecordChange(db, 'incident', next, next, users.admin).length, 0)
    assert.equal(notifyRecordChange(db, 'incident', { ...inc, assigned_to: null }, { ...inc, assigned_to: users.admin.sys_id }, users.admin).length, 0)
    assert.equal(notifyRecordChange(db, 'kb_knowledge', null, { sys_id: 'x', assigned_to: users['beth.anglin'].sys_id }, users.admin).length, 0)
  })

  it('notifies the caller on state change unless they made it', () => {
    const inc = incidentFor('abel.tuter')
    const out = notifyRecordChange(db, 'incident', { ...inc, state: '2' }, { ...inc, state: '3' }, users['beth.anglin'])
    assert.equal(out.length, 1)
    assert.equal(out[0].recipient, users['abel.tuter'].sys_id)
    assert.match(String(out[0].message), /from In Progress to On Hold/)
    assert.equal(notifyRecordChange(db, 'incident', { ...inc, state: '2' }, { ...inc, state: '3' }, users['abel.tuter']).length, 0)
  })

  it('notifies @mentioned users, respecting work-note visibility and skipping self/unknown', () => {
    const inc = incidentFor('abel.tuter')
    const id = String(inc.sys_id)
    const out = notifyJournal(db, 'incident', id, 'work_notes', '@beth.anglin @abel.tuter @admin @nobody.here take a look', users.admin)
    assert.deepEqual(out.map((n) => n.recipient), [users['beth.anglin'].sys_id], 'self-service users and the author are not notified from work notes')
    assert.equal(out[0].type, 'mention')
    assert.match(String(out[0].message), /mentioned you in a work note/)
    const c = notifyJournal(db, 'incident', id, 'comments', 'cc @carol.coughlin', users['beth.anglin'])
    assert.ok(c.some((n) => n.recipient === users['carol.coughlin'].sys_id && n.type === 'mention'))
  })

  it('notifies the caller when an agent comments, once, and not for caller comments', () => {
    const inc = incidentFor('abel.tuter')
    const id = String(inc.sys_id)
    const out = notifyJournal(db, 'incident', id, 'comments', 'We pushed a fix, please retry.', users['beth.anglin'])
    assert.deepEqual(out.map((n) => [n.type, n.recipient]), [['comment', users['abel.tuter'].sys_id]])
    assert.equal(notifyJournal(db, 'incident', id, 'comments', 'Still broken', users['abel.tuter']).length, 0)
    assert.equal(notifyJournal(db, 'incident', id, 'work_notes', 'internal only', users['beth.anglin']).length, 0)
    const both = notifyJournal(db, 'incident', id, 'comments', '@abel.tuter please confirm', users['beth.anglin'])
    assert.deepEqual(both.map((n) => n.type), ['mention'], 'mention takes precedence over the generic comment notification')
    assert.equal(count('abel.tuter'), 2)
  })
})

describe('notifications API', () => {
  let server: Server
  let base = ''
  const ids: Record<string, string> = {}

  async function call(user: string | null, method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (user) headers['X-User'] = ids[user]
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    // oxlint-disable-next-line typescript/no-explicit-any
    const json: any = res.status === 204 ? null : await res.json()
    return { status: res.status, json }
  }

  before(async () => {
    const db = openDb(':memory:')
    seed(db)
    server = createApp(db).listen(0)
    await new Promise((r) => server.once('listening', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    for (const u of ['admin', 'beth.anglin', 'abel.tuter']) ids[u] = (await call(null, 'POST', '/api/login', { user_name: u, password: 'demo' })).json.result.sys_id
  })
  after(() => server.close())

  it('requires a user', async () => {
    assert.equal((await call(null, 'GET', '/api/now/notifications')).status, 401)
  })

  it('seeds unread notifications for admin and beth, listed unread first', async () => {
    for (const u of ['admin', 'beth.anglin']) {
      const r = await call(u, 'GET', '/api/now/notifications?limit=50')
      assert.equal(r.status, 200)
      assert.ok(r.json.unread >= 3, `${u} has unread notifications`)
      const flags = r.json.result.map((n: { read: string }) => n.read)
      assert.deepEqual(flags, [...flags].sort((a: string, b: string) => (a === 'true' ? 1 : 0) - (b === 'true' ? 1 : 0)))
      assert.ok(r.json.result.every((n: { recipient: string }) => n.recipient === ids[u]))
      assert.ok(r.json.result[0].actor_name)
    }
  })

  it('generates notifications from the Table API and journal endpoints', async () => {
    const before = (await call('beth.anglin', 'GET', '/api/now/notifications/unread_count')).json.result.unread
    const inc = (await call('admin', 'GET', '/api/now/table/incident?sysparm_query=assigned_toISEMPTY^stateNOTIN6,7,8&sysparm_limit=1')).json.result[0]
    await call('admin', 'PATCH', `/api/now/table/incident/${inc.sys_id}`, { assigned_to: ids['beth.anglin'], work_notes: 'Handing over to @beth.anglin' })
    await call('admin', 'POST', `/api/now/journal/incident/${inc.sys_id}`, { element: 'work_notes', value: 'Also cc @beth.anglin' })
    const after = await call('beth.anglin', 'GET', '/api/now/notifications?limit=3')
    assert.equal(after.json.unread, before + 3)
    assert.deepEqual(after.json.result.map((n: { type: string }) => n.type).sort(), ['assigned', 'mention', 'mention'])
    assert.equal(after.json.result[0].document_number, inc.number)
  })

  it('marks one and all as read, scoped to the recipient', async () => {
    const list = (await call('admin', 'GET', '/api/now/notifications?unread=true')).json
    const first = list.result[0]
    assert.equal((await call('beth.anglin', 'POST', `/api/now/notifications/${first.sys_id}/read`)).status, 404)
    const one = await call('admin', 'POST', `/api/now/notifications/${first.sys_id}/read`)
    assert.equal(one.json.result.unread, list.unread - 1)
    const all = await call('admin', 'POST', '/api/now/notifications/read_all')
    assert.equal(all.json.result.updated, list.unread - 1)
    assert.equal((await call('admin', 'GET', '/api/now/notifications/unread_count')).json.result.unread, 0)
  })
})
