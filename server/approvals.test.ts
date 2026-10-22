import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from './app.ts'
import { openDb } from './db.ts'
import type { Db } from './db.ts'
import { seed } from './seed.ts'
import { documentOutcome, rollupApproval } from './approvals.ts'

let server: Server
let base = ''
let db: Db
const ids: Record<string, string> = {}

async function call(user: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User': ids[user] ?? '' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  // oxlint-disable-next-line typescript/no-explicit-any
  const json: any = await res.json()
  return { status: res.status, json }
}

const approvers = (docId: string) =>
  db.prepare('SELECT u.user_name AS who, a.state, a.iteration FROM sysapproval_approver a JOIN sys_user u ON u.sys_id = a.approver WHERE a.document_id = ? ORDER BY a.iteration, a.rowid').all(docId) as { who: string; state: string; iteration: number }[]

async function newChange(requester = 'beth.anglin') {
  const grp = db.prepare("SELECT sys_id FROM sys_user_group WHERE name = 'Network'").get() as { sys_id: string }
  const r = await call(requester, 'POST', '/api/now/table/change_request', { short_description: 'Test change', type: 'normal', state: '-5', assignment_group: grp.sys_id, requested_by: ids[requester] })
  assert.equal(r.status, 201)
  return String(r.json.result.sys_id)
}

before(async () => {
  db = openDb(':memory:')
  seed(db)
  for (const u of db.prepare('SELECT sys_id, user_name FROM sys_user').all() as { sys_id: string; user_name: string }[]) ids[u.user_name] = u.sys_id
  server = createApp(db).listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => server.close())

describe('approval rollup', () => {
  it('any approval approves, any rejection rejects, cancelled rows are ignored', () => {
    assert.equal(rollupApproval(['requested', 'requested']), 'requested')
    assert.equal(rollupApproval(['requested', 'approved']), 'approved')
    assert.equal(rollupApproval(['approved', 'rejected']), 'rejected')
    assert.equal(rollupApproval(['cancelled', 'approved']), 'approved')
    assert.equal(rollupApproval(['cancelled']), 'not requested')
    assert.equal(rollupApproval([]), 'not requested')
  })

  it('maps outcomes to document fields', () => {
    assert.deepEqual(documentOutcome('change_request', 'approved'), { approval: 'approved', state: '-2' })
    assert.deepEqual(documentOutcome('sc_req_item', 'rejected'), { approval: 'rejected', stage: 'complete', state: '4' })
    assert.throws(() => documentOutcome('incident', 'approved'))
  })
})

describe('approver records', () => {
  it('creates approvers (group manager + CAB, never the requester) when a change requests approval', async () => {
    const id = await newChange()
    assert.equal(approvers(id).length, 0)
    await call('beth.anglin', 'PATCH', `/api/now/table/change_request/${id}`, { state: '-3', approval: 'requested' })
    assert.deepEqual(
      approvers(id).map((a) => a.who),
      ['david.loo', 'don.goodliffe', 'admin'],
    )
    const journal = (await call('admin', 'GET', `/api/now/journal/change_request/${id}`)).json.result as { value: string }[]
    assert.ok(journal.some((j) => j.value.startsWith('Approval requested from: David Loo')))
  })

  it('approves the change on the first approval and retires the other approvers', async () => {
    const id = await newChange()
    await call('beth.anglin', 'PATCH', `/api/now/table/change_request/${id}`, { state: '-3', approval: 'requested' })
    const mine = (await call('admin', 'GET', `/api/now/approvals/document/change_request/${id}`)).json.result.find((a: { approver: string }) => a.approver === ids.admin)
    const r = await call('admin', 'POST', `/api/now/approvals/${mine.sys_id}`, { decision: 'approved', comment: 'Looks good' })
    assert.equal(r.status, 200)
    assert.equal(r.json.result.approval.state, 'approved')
    assert.equal(r.json.result.document.approval, 'approved')
    assert.equal(r.json.result.document.state, '-2')
    assert.deepEqual(
      approvers(id).map((a) => a.state),
      ['cancelled', 'cancelled', 'approved'],
    )
    const journal = (await call('admin', 'GET', `/api/now/journal/change_request/${id}`)).json.result as { value: string }[]
    assert.ok(journal.some((j) => j.value === 'Approved by System Administrator: Looks good'))
  })

  it('requires a comment to reject, and a rejection rejects the document', async () => {
    const id = await newChange()
    await call('beth.anglin', 'PATCH', `/api/now/table/change_request/${id}`, { state: '-3', approval: 'requested' })
    const noComment = await call('don.goodliffe', 'POST', `/api/now/approval/change_request/${id}`, { decision: 'rejected' })
    assert.equal(noComment.status, 400)
    const r = await call('don.goodliffe', 'POST', `/api/now/approval/change_request/${id}`, { decision: 'rejected', comment: 'No backout plan' })
    assert.equal(r.json.result.approval, 'rejected')
    assert.equal(r.json.result.state, '-5')
    const late = await call('admin', 'POST', `/api/now/approval/change_request/${id}`, { decision: 'approved' })
    assert.equal(late.status, 403)
  })

  it('only lets the assigned approver decide', async () => {
    const id = await newChange()
    await call('beth.anglin', 'PATCH', `/api/now/table/change_request/${id}`, { state: '-3', approval: 'requested' })
    const r = await call('abel.tuter', 'POST', `/api/now/approval/change_request/${id}`, { decision: 'approved' })
    assert.equal(r.status, 403)
    assert.ok(approvers(id).every((a) => a.state === 'requested'))
  })

  it('starts a new round when approval is re-requested and keeps the old one as history', async () => {
    const id = await newChange()
    await call('beth.anglin', 'PATCH', `/api/now/table/change_request/${id}`, { state: '-3', approval: 'requested' })
    await call('admin', 'POST', `/api/now/approval/change_request/${id}`, { decision: 'rejected', comment: 'Add a test plan' })
    await call('beth.anglin', 'PATCH', `/api/now/table/change_request/${id}`, { state: '-3', approval: 'requested' })
    const rows = approvers(id)
    assert.deepEqual([...new Set(rows.map((a) => a.iteration))], [1, 2])
    assert.ok(rows.filter((a) => a.iteration === 2).every((a) => a.state === 'requested'))
  })

  it('cancels pending approvers when the change is cancelled', async () => {
    const id = await newChange()
    await call('beth.anglin', 'PATCH', `/api/now/table/change_request/${id}`, { state: '-3', approval: 'requested' })
    await call('beth.anglin', 'PATCH', `/api/now/table/change_request/${id}`, { state: '4' })
    assert.ok(approvers(id).every((a) => a.state === 'cancelled'))
  })

  it('routes catalog orders to the fulfillment group manager and budget owner', async () => {
    const laptop = db.prepare("SELECT sys_id FROM sc_cat_item WHERE name = 'Developer Laptop'").get() as { sys_id: string }
    const r = await call('abel.tuter', 'POST', `/api/now/catalog/${laptop.sys_id}/order`, { quantity: 1 })
    const id = String(r.json.result.sys_id)
    assert.deepEqual(
      approvers(id).map((a) => a.who),
      ['itil', 'admin'],
    )
    const ok = await call('itil', 'POST', `/api/now/approval/sc_req_item/${id}`, { decision: 'approved', comment: '' })
    assert.equal(ok.json.result.stage, 'fulfillment')
  })
})

describe('My Approvals API', () => {
  it('lists pending approvals with document context and a count', async () => {
    const r = await call('beth.anglin', 'GET', '/api/now/approvals/mine')
    assert.ok(r.json.result.length >= 3)
    assert.equal(r.json.pending, r.json.result.length)
    const tables = new Set(r.json.result.map((a: { source_table: string }) => a.source_table))
    assert.ok(tables.has('change_request') && tables.has('sc_req_item'))
    assert.ok(r.json.result.every((a: { state: string; document: { number: string } }) => a.state === 'requested' && a.document.number))
    const count = await call('beth.anglin', 'GET', '/api/now/approvals/count')
    assert.equal(count.json.result.pending, r.json.pending)
    const history = await call('beth.anglin', 'GET', '/api/now/approvals/mine?view=history')
    assert.ok(history.json.result.some((a: { state: string }) => a.state === 'approved'))
    assert.ok(history.json.result.some((a: { state: string }) => a.state === 'rejected'))
  })

  it('bulk approves and reports per-row results', async () => {
    const before = (await call('beth.anglin', 'GET', '/api/now/approvals/mine')).json
    const pick = before.result.slice(0, 2).map((a: { sys_id: string }) => a.sys_id)
    const r = await call('beth.anglin', 'POST', '/api/now/approvals/bulk', { ids: [...pick, 'missing'], decision: 'approved' })
    assert.deepEqual(
      r.json.result.map((x: { ok: boolean }) => x.ok),
      [true, true, false],
    )
    const after = (await call('beth.anglin', 'GET', '/api/now/approvals/count')).json.result.pending
    assert.ok(after <= before.pending - 2)
  })
})
