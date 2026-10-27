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

async function call(method: string, path: string, body?: unknown, as = adminId) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User': as },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
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

describe('Table API write policy', () => {
  const userId = async (name: string) => (await call('GET', `/api/now/table/sys_user?sysparm_query=user_name=${name}`)).json.result[0].sys_id as string
  const pendingRitm = async () => {
    const laptop = (await call('GET', '/api/now/table/sc_cat_item?sysparm_query=name=Developer Laptop')).json.result[0]
    return (await call('POST', `/api/now/catalog/${laptop.sys_id}/order`, { quantity: 1 })).json.result
  }

  it('rejects a self-service user granting themselves admin', async () => {
    const abel = await userId('abel.tuter')
    const r = await call('PATCH', `/api/now/table/sys_user/${abel}`, { role: 'admin' }, abel)
    assert.equal(r.status, 403)
    assert.equal((await call('GET', `/api/now/table/sys_user/${abel}`)).json.result.role, 'user')
    const ok = await call('PATCH', `/api/now/table/sys_user/${abel}`, { title: 'Analyst', role: 'user' }, abel)
    assert.equal(ok.status, 200)
  })

  it('only lets admins set role or active, including on insert', async () => {
    const beth = await userId('beth.anglin')
    const created = await call('POST', '/api/now/table/sys_user', { user_name: 'mallory', name: 'Mallory', role: 'admin' }, beth)
    assert.equal(created.status, 403)
    const plain = await call('POST', '/api/now/table/sys_user', { user_name: 'mallory', name: 'Mallory' }, beth)
    assert.equal(plain.json.result.role, 'user')
    assert.equal((await call('PATCH', `/api/now/table/sys_user/${plain.json.result.sys_id}`, { active: 'false' }, beth)).status, 403)
    assert.equal((await call('PATCH', `/api/now/table/sys_user/${plain.json.result.sys_id}`, { user_name: 'mallory', role: 'itil' }, '')).status, 403)
    const promoted = await call('PATCH', `/api/now/table/sys_user/${plain.json.result.sys_id}`, { role: 'itil' })
    assert.equal(promoted.json.result.role, 'itil')
  })

  it('ignores approval and price writes on a requested item and blocks stage changes until approved', async () => {
    const ritm = await pendingRitm()
    const abel = await userId('abel.tuter')
    const r = await call('PATCH', `/api/now/table/sc_req_item/${ritm.sys_id}`, { approval: 'approved', price: 1 }, abel)
    assert.equal(r.status, 200)
    assert.equal(r.json.result.approval, 'requested')
    assert.equal(r.json.result.price, ritm.price)
    const staged = await call('PATCH', `/api/now/table/sc_req_item/${ritm.sys_id}`, { approval: 'approved', stage: 'fulfillment' }, abel)
    assert.equal(staged.status, 403)
    const fresh = (await call('GET', `/api/now/table/sc_req_item/${ritm.sys_id}`)).json.result
    assert.equal(fresh.approval, 'requested')
    assert.equal(fresh.stage, 'waiting_for_approval')
    assert.equal((await call('POST', `/api/now/approval/sc_req_item/${ritm.sys_id}`, { decision: 'approved' }, abel)).status, 403)
    assert.equal((await call('POST', `/api/now/approval/sc_req_item/${ritm.sys_id}`, { decision: 'approved' })).json.result.stage, 'fulfillment')
    assert.equal((await call('PATCH', `/api/now/table/sc_req_item/${ritm.sys_id}`, { stage: 'delivery' })).json.result.stage, 'delivery')
    assert.equal((await call('POST', `/api/now/approval/sc_req_item/${ritm.sys_id}`, { decision: 'approved' })).status, 400)
  })

  it('derives approval, stage and price server-side for generic requested-item inserts', async () => {
    const laptop = (await call('GET', '/api/now/table/sc_cat_item?sysparm_query=name=Developer Laptop')).json.result[0]
    const r = await call('POST', '/api/now/table/sc_req_item', { cat_item: laptop.sys_id, requested_for: adminId, quantity: 2, price: 1, approval: 'approved', stage: 'fulfillment', state: '2' })
    assert.equal(r.status, 201)
    assert.equal(r.json.result.price, laptop.price * 2)
    assert.equal(r.json.result.approval, 'requested')
    assert.equal(r.json.result.stage, 'waiting_for_approval')
    assert.equal(r.json.result.state, '1')
  })

  it('keeps change approval server-controlled and blocks scheduling an unapproved change', async () => {
    const chg = (await call('POST', '/api/now/table/change_request', { short_description: 'Patch DB', requested_by: adminId, approval: 'approved' })).json.result
    assert.equal(chg.approval, 'not requested')
    assert.equal((await call('PATCH', `/api/now/table/change_request/${chg.sys_id}`, { approval: 'approved', state: '-2' })).status, 403)
    assert.equal((await call('POST', '/api/now/table/change_request', { short_description: 'Skip CAB', requested_by: adminId, state: '-1' })).status, 403)
    const requested = await call('PATCH', `/api/now/table/change_request/${chg.sys_id}`, { state: '-3' })
    assert.equal(requested.json.result.approval, 'requested')
    assert.equal((await call('POST', `/api/now/approval/change_request/${chg.sys_id}`, { decision: 'approved' })).json.result.state, '-2')
    assert.equal((await call('PATCH', `/api/now/table/change_request/${chg.sys_id}`, { state: '-1' })).json.result.state, '-1')
  })

  it('ignores client-supplied sys_id and timestamps', async () => {
    const caller = await userId('abel.tuter')
    const r = await call('POST', '/api/now/table/incident', {
      caller_id: caller,
      short_description: 'Backdated',
      sys_id: 'attacker-chosen-id',
      sys_created_on: '2000-01-01 00:00:00',
      sys_updated_on: '2000-01-01 00:00:00',
      opened_at: '2000-01-01 00:00:00',
      resolved_at: '2000-01-02 00:00:00',
    })
    assert.equal(r.status, 201)
    const inc = r.json.result
    assert.notEqual(inc.sys_id, 'attacker-chosen-id')
    for (const k of ['sys_created_on', 'sys_updated_on', 'opened_at']) assert.ok(!String(inc[k]).startsWith('2000'), k)
    assert.equal(inc.resolved_at, null)
    const patched = await call('PATCH', `/api/now/table/incident/${inc.sys_id}`, { opened_at: '2000-01-01 00:00:00', resolved_at: '2000-01-02 00:00:00' })
    assert.equal(patched.json.result.opened_at, inc.opened_at)
    assert.equal(patched.json.result.resolved_at, null)
  })
})
