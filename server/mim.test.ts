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
let endUserId = ''

async function call(method: string, path: string, body?: unknown, user = adminId) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User': user },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  // oxlint-disable-next-line typescript/no-explicit-any
  const json: any = res.status === 204 ? null : await res.json()
  return { status: res.status, json }
}

const find = async (q: string) => (await call('GET', `/api/now/table/incident?sysparm_query=${encodeURIComponent(q)}&sysparm_limit=1`)).json.result[0]

before(async () => {
  const db = openDb(':memory:')
  seed(db)
  server = createApp(db).listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  adminId = (await call('POST', '/api/login', { user_name: 'admin', password: 'demo' })).json.result.sys_id
  endUserId = (await call('POST', '/api/login', { user_name: 'abel.tuter', password: 'demo' })).json.result.sys_id
})

after(() => server.close())

describe('Major Incident Management', () => {
  it('lists the seeded major incident with child and comms counts', async () => {
    const r = await call('GET', '/api/now/mim')
    assert.equal(r.status, 200)
    const mim = r.json.result.find((m: { short_description: string }) => m.short_description.startsWith('Exchange Online outage'))
    assert.ok(mim)
    assert.equal(mim._children, 3)
    assert.equal(mim._comms, 2)
    assert.ok(mim._affected_users >= 4)
    assert.ok(mim._next_update_due)
  })

  it('suggests open look-alike incidents on the same CI and excludes linked children', async () => {
    const parent = await find('major_incident_state=accepted')
    const wb = (await call('GET', `/api/now/mim/${parent.sys_id}`)).json.result
    assert.equal(wb.children.length, 3)
    const childIds = new Set(wb.children.map((c: { sys_id: string }) => c.sys_id))
    assert.ok(wb.candidates.length >= 3)
    for (const c of wb.candidates) {
      assert.ok(!childIds.has(c.sys_id))
      assert.ok(c._reasons.length > 0)
    }
    assert.ok(wb.candidates.some((c: { short_description: string }) => c.short_description === 'Shared mailbox emails not arriving'))
    assert.ok(wb.timeline.some((t: { _source: string }) => t._source !== parent.number), 'timeline merges child journals')
  })

  it('blocks end users from promoting', async () => {
    const inc = await find('stateIN1,2^major_incident_stateISEMPTY^parent_incidentISEMPTY')
    const r = await call('POST', `/api/now/mim/${inc.sys_id}/promote`, {}, endUserId)
    assert.equal(r.status, 403)
  })

  it('promotes, links children, sends comms to every caller and cascades resolution', async () => {
    const inc = await find('category=network^stateIN1,2^major_incident_stateISEMPTY^parent_incidentISEMPTY')
    const p = await call('POST', `/api/now/mim/${inc.sys_id}/promote`, { business_impact: 'Remote staff cannot connect' })
    assert.equal(p.status, 200)
    assert.equal(p.json.result.major_incident_state, 'accepted')
    assert.equal(p.json.result.priority, '1')
    assert.ok(p.json.result.promoted_on)
    assert.equal((await call('POST', `/api/now/mim/${inc.sys_id}/promote`, {})).status, 400)

    const caller = (await call('GET', '/api/now/table/sys_user?sysparm_query=user_name=bud.richman')).json.result[0]
    const kids = []
    for (const sd of ['VPN down for me too', 'Cannot reach intranet over VPN']) {
      kids.push((await call('POST', '/api/now/table/incident', { caller_id: caller.sys_id, short_description: sd, category: 'network' })).json.result)
    }
    const link = await call('POST', `/api/now/mim/${inc.sys_id}/children`, { ids: kids.map((k) => k.sys_id) })
    assert.equal(link.status, 200)
    assert.equal(link.json.result.length, 2)
    assert.equal((await call('POST', `/api/now/mim/${inc.sys_id}/children`, { ids: [inc.sys_id] })).status, 400)

    const comms = await call('POST', `/api/now/mim/${inc.sys_id}/comms`, { kind: 'update', audience: 'Remote staff', message: 'VPN gateway failover in progress.' })
    assert.equal(comms.status, 201)
    assert.equal(comms.json.result.notified, 3)
    const childJournal = (await call('GET', `/api/now/journal/incident/${kids[0].sys_id}`)).json.result
    assert.ok(childJournal.some((j: { element: string; value: string }) => j.element === 'comments' && j.value.includes('VPN gateway failover')))

    const unlink = await call('DELETE', `/api/now/mim/${inc.sys_id}/children/${kids[1].sys_id}`)
    assert.equal(unlink.status, 204)

    const res = await call('PATCH', `/api/now/table/incident/${inc.sys_id}`, { state: '6', close_code: 'Solved (Permanently)', close_notes: 'Failed over to secondary gateway' })
    assert.equal(res.status, 200)
    const linkedKid = (await call('GET', `/api/now/table/incident/${kids[0].sys_id}`)).json.result
    assert.equal(linkedKid.state, '6')
    assert.match(linkedKid.close_notes, /Failed over to secondary gateway/)
    const unlinkedKid = (await call('GET', `/api/now/table/incident/${kids[1].sys_id}`)).json.result
    assert.notEqual(unlinkedKid.state, '6')
  })
})
