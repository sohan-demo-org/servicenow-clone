import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from './app.ts'
import { nowStr, openDb } from './db.ts'
import { refreshConflictStatus } from './changeschedule.ts'
import { seed } from './seed.ts'

let server: Server
let base = ''
let adminId = ''

// oxlint-disable-next-line typescript/no-explicit-any
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User': adminId },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: res.status === 204 ? null : await res.json() }
}

const hoursFromNow = (h: number) => nowStr(new Date(Date.now() + h * 3600000))
const byDesc = async (sd: string) => (await call('GET', `/api/now/table/change_request?sysparm_query=short_description=${encodeURIComponent(sd)}`)).json.result[0]

before(async () => {
  const db = openDb(':memory:')
  seed(db)
  refreshConflictStatus(db)
  server = createApp(db).listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  adminId = (await call('POST', '/api/login', { user_name: 'admin', password: 'demo' })).json.result.sys_id
})

after(() => server.close())

describe('Change Schedule', () => {
  it('returns changes, blackouts and per-change conflicts for a window', async () => {
    const r = await call('GET', `/api/now/change_schedule?from=${encodeURIComponent(hoursFromNow(-24))}&to=${encodeURIComponent(hoursFromNow(24 * 8))}`)
    assert.equal(r.status, 200)
    const { changes, blackouts, conflicts } = r.json.result
    assert.ok(changes.length >= 8)
    assert.deepEqual(blackouts.map((b: { name: string }) => b.name).sort(), ['Q4 financial close freeze', 'SAP year-end batch processing'])
    const types = new Set(Object.values(conflicts).flat().map((c) => (c as { type: string }).type))
    assert.ok(types.has('ci_already_scheduled'))
    assert.ok(types.has('assignee_already_scheduled'))
    assert.ok(types.has('blackout'))
  })

  it('flags seeded collisions in conflict_status and leaves clean changes alone', async () => {
    assert.equal((await byDesc('Apply Jenkins controller security patch')).conflict_status, 'conflict')
    assert.equal((await byDesc('Migrate Jenkins agents to new image')).conflict_status, 'conflict')
    assert.equal((await byDesc('SAP HANA memory parameter tuning')).conflict_status, 'conflict')
    assert.equal((await byDesc('Rotate Exchange Online DKIM keys')).conflict_status, 'conflict')
    assert.equal((await byDesc('Renew TLS certificate on lnux-web-01')).conflict_status, 'none')
  })

  it('applies CI-scoped blackouts only to that CI', async () => {
    const sap = await byDesc('SAP HANA memory parameter tuning')
    const base = { start_date: sap.start_date, end_date: sap.end_date }
    const onSap = await call('POST', '/api/now/change_schedule/conflicts', { ...base, sys_id: sap.sys_id, cmdb_ci: sap.cmdb_ci })
    assert.deepEqual(onSap.json.result.map((c: { type: string }) => c.type), ['blackout'])
    const tls = await byDesc('Renew TLS certificate on lnux-web-01')
    const elsewhere = await call('POST', '/api/now/change_schedule/conflicts', { ...base, cmdb_ci: tls.cmdb_ci })
    assert.deepEqual(elsewhere.json.result, [])
  })

  it('previews conflicts for an unsaved window, including invalid ranges', async () => {
    const tls = await byDesc('Renew TLS certificate on lnux-web-01')
    const r = await call('POST', '/api/now/change_schedule/conflicts', { sys_id: tls.sys_id, cmdb_ci: tls.cmdb_ci, start_date: hoursFromNow(90), end_date: hoursFromNow(92) })
    assert.ok(r.json.result.some((c: { type: string; related: { display: string } }) => c.type === 'blackout' && c.related.display === 'Q4 financial close freeze'))
    const bad = await call('POST', '/api/now/change_schedule/conflicts', { start_date: hoursFromNow(5), end_date: hoursFromNow(4) })
    assert.equal(bad.json.result[0].type, 'invalid_window')
  })

  it('finds the next conflict-free window and rescheduling clears both sides', async () => {
    const patch = await byDesc('Apply Jenkins controller security patch')
    const agents = await byDesc('Migrate Jenkins agents to new image')
    const r = await call('POST', `/api/now/change_schedule/${patch.sys_id}/next_window`, { after: patch.start_date })
    assert.equal(r.status, 200)
    const { start_date, end_date } = r.json.result
    assert.ok(start_date >= agents.end_date, 'moved past the colliding change')
    assert.equal(Date.parse(`${end_date}Z`) - Date.parse(`${start_date}Z`), 4 * 3600000, 'keeps the duration')
    const conflicts = await call('POST', '/api/now/change_schedule/conflicts', { sys_id: patch.sys_id, cmdb_ci: patch.cmdb_ci, assigned_to: patch.assigned_to, start_date, end_date })
    assert.deepEqual(conflicts.json.result, [])

    const upd = await call('PATCH', `/api/now/table/change_request/${patch.sys_id}`, { start_date, end_date, work_notes: 'Rescheduled' })
    assert.equal(upd.json.result.conflict_status, 'none')
    assert.equal((await byDesc('Migrate Jenkins agents to new image')).conflict_status, 'none')
  })

  it('re-runs the checker when a blackout window is created', async () => {
    const tls = await byDesc('Renew TLS certificate on lnux-web-01')
    const b = await call('POST', '/api/now/table/cmn_schedule_blackout', { name: 'Web tier freeze', start_date: tls.start_date, end_date: tls.end_date, cmdb_ci: tls.cmdb_ci, active: 'true' })
    assert.equal(b.status, 201)
    assert.equal((await byDesc('Renew TLS certificate on lnux-web-01')).conflict_status, 'conflict')
    await call('DELETE', `/api/now/table/cmn_schedule_blackout/${b.json.result.sys_id}`)
    assert.equal((await byDesc('Renew TLS certificate on lnux-web-01')).conflict_status, 'none')
  })
})
