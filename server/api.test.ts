import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from './app.ts'
import { openDb } from './db.ts'
import { seed } from './seed.ts'

let server: Server
let base = ''
let adminId = ''

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User': adminId },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = res.status === 204 ? null : await res.json()
  return { status: res.status, json }
}

before(async () => {
  const db = openDb(':memory:')
  seed(db)
  server = createApp(db).listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const login = await call('POST', '/api/login', { user_name: 'admin', password: 'demo' })
  adminId = login.json.result.sys_id
})

after(() => server.close())

describe('Table API', () => {
  it('rejects bad credentials', async () => {
    const r = await call('POST', '/api/login', { user_name: 'admin', password: 'nope' })
    assert.equal(r.status, 401)
  })

  it('lists seeded incidents with encoded query, OR and ordering', async () => {
    const r = await call('GET', '/api/now/table/incident?sysparm_query=priority=1^ORpriority=2^ORDERBYnumber&sysparm_limit=100')
    assert.equal(r.status, 200)
    assert.ok(r.json.total > 0)
    for (const rec of r.json.result) assert.ok(['1', '2'].includes(rec.priority))
    const numbers = r.json.result.map((x: { number: string }) => x.number)
    assert.deepEqual(numbers, [...numbers].sort())
    assert.ok(r.json.result[0]._dv.caller_id, 'reference display values are returned')
  })

  it('creates an incident with auto-number and computed priority', async () => {
    const caller = (await call('GET', '/api/now/table/sys_user?sysparm_query=user_name=abel.tuter')).json.result[0]
    const r = await call('POST', '/api/now/table/incident', { caller_id: caller.sys_id, short_description: 'Test outage', impact: '1', urgency: '2' })
    assert.equal(r.status, 201)
    assert.match(r.json.result.number, /^INC\d{7}$/)
    assert.equal(r.json.result.priority, '2')
    assert.equal(r.json.result.state, '1')
  })

  it('enforces mandatory fields', async () => {
    const r = await call('POST', '/api/now/table/incident', { short_description: 'no caller' })
    assert.equal(r.status, 400)
    assert.match(r.json.error.detail, /Caller/)
  })

  it('requires resolution info to resolve and records an audit entry', async () => {
    const inc = (await call('GET', '/api/now/table/incident?sysparm_query=state=2&sysparm_limit=1')).json.result[0]
    const bad = await call('PATCH', `/api/now/table/incident/${inc.sys_id}`, { state: '6' })
    assert.equal(bad.status, 400)
    const ok = await call('PATCH', `/api/now/table/incident/${inc.sys_id}`, { state: '6', close_code: 'Solved (Permanently)', close_notes: 'Rebooted', work_notes: 'Fixed it' })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.result.state, '6')
    assert.ok(ok.json.result.resolved_at)
    const journal = (await call('GET', `/api/now/journal/incident/${inc.sys_id}`)).json.result
    assert.ok(journal.some((j: { element: string; value: string }) => j.element === 'audit' && j.value.includes('Resolved')))
    assert.ok(journal.some((j: { element: string; value: string }) => j.element === 'work_notes' && j.value === 'Fixed it'))
  })

  it('orders a catalog item and routes approval by price', async () => {
    const laptop = (await call('GET', '/api/now/table/sc_cat_item?sysparm_query=name=Developer Laptop')).json.result[0]
    const r = await call('POST', `/api/now/catalog/${laptop.sys_id}/order`, { quantity: 1, variables: { Color: 'Silver' } })
    assert.equal(r.status, 201)
    assert.equal(r.json.result.approval, 'requested')
    assert.equal(r.json.result.stage, 'waiting_for_approval')
    const approved = await call('POST', `/api/now/approval/sc_req_item/${r.json.result.sys_id}`, { decision: 'approved' })
    assert.equal(approved.json.result.stage, 'fulfillment')
  })

  it('moves a change to Scheduled on approval', async () => {
    const chg = (await call('GET', '/api/now/table/change_request?sysparm_query=approval=requested&sysparm_limit=1')).json.result[0]
    const r = await call('POST', `/api/now/approval/change_request/${chg.sys_id}`, { decision: 'approved' })
    assert.equal(r.json.result.state, '-2')
    assert.equal(r.json.result.approval, 'approved')
  })

  it('groups counts and searches across tables', async () => {
    const stats = await call('GET', '/api/now/stats/incident?sysparm_group_by=priority')
    assert.ok(stats.json.result.every((s: { label: string }) => s.label))
    const search = await call('GET', '/api/now/search?q=vpn')
    assert.ok(search.json.result.some((g: { table: string }) => g.table === 'incident'))
    assert.ok(search.json.result.some((g: { table: string }) => g.table === 'kb_knowledge'))
  })
})
