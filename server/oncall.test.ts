import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createApp } from './app.ts'
import { insertRecord, nowStr, openDb } from './db.ts'
import type { Db } from './db.ts'
import { seed } from './seed.ts'
import { onCallAt, parseUtc, segmentsBetween, shiftIndexAt, shiftsBetween } from './oncall.ts'
import type { RotaDef, RotaOverride } from './oncall.ts'

const H = 3600000
const members = [
  { sys_id: 'a', name: 'Alice', order: 100 },
  { sys_id: 'c', name: 'Carol', order: 300 },
  { sys_id: 'b', name: 'Bob', order: 200 },
]
const daily: RotaDef = { rotation_type: 'daily', handoff_time: '09:00', timezone: 'UTC', start_date: '2026-03-02 00:00:00' }
const weekly: RotaDef = { ...daily, rotation_type: 'weekly' }
const t = (s: string) => parseUtc(s)
const ov = (sys_id: string, member: string, name: string, start: string, end: string, created = '1'): RotaOverride => ({ sys_id, member, name, start: t(start), end: t(end), reason: 'PTO', created })

describe('rotation computation', () => {
  it('rotates daily in member order starting at the rota start + handoff time', () => {
    assert.equal(onCallAt(daily, members, [], t('2026-03-02 09:00:00'))?.primary.name, 'Alice')
    assert.equal(onCallAt(daily, members, [], t('2026-03-03 08:59:00'))?.primary.name, 'Alice')
    assert.equal(onCallAt(daily, members, [], t('2026-03-03 09:00:00'))?.primary.name, 'Bob')
    assert.equal(onCallAt(daily, members, [], t('2026-03-04 12:00:00'))?.primary.name, 'Carol')
    assert.equal(onCallAt(daily, members, [], t('2026-03-05 12:00:00'))?.primary.name, 'Alice')
    // before the first handoff the cycle wraps backwards
    assert.equal(onCallAt(daily, members, [], t('2026-03-02 08:00:00'))?.primary.name, 'Carol')
  })

  it('rotates weekly and reports shift boundaries', () => {
    const r = onCallAt(weekly, members, [], t('2026-03-12 15:00:00'))
    assert.equal(r?.primary.name, 'Bob')
    assert.equal(r?.secondary?.name, 'Carol')
    assert.equal(nowStr(new Date(r?.shiftStart ?? 0)), '2026-03-09 09:00:00')
    assert.equal(nowStr(new Date(r?.shiftEnd ?? 0)), '2026-03-16 09:00:00')
  })

  it('honours the rota time zone for the handoff', () => {
    const ny: RotaDef = { ...daily, timezone: 'America/New_York', start_date: '2026-07-01 12:00:00' }
    // 09:00 EDT = 13:00 UTC
    assert.equal(shiftIndexAt(ny, t('2026-07-02 12:59:00')), 0)
    assert.equal(shiftIndexAt(ny, t('2026-07-02 13:00:00')), 1)
    const shifts = shiftsBetween(ny, members, t('2026-07-02 00:00:00'), t('2026-07-03 00:00:00'))
    assert.deepEqual(shifts.map((s) => nowStr(new Date(s.startMs))), ['2026-07-01 13:00:00', '2026-07-02 13:00:00'])
  })

  it('lets overrides win, and newer overrides win over older ones', () => {
    const o1 = ov('o1', 'z', 'Zed', '2026-03-03 12:00:00', '2026-03-03 18:00:00', '1')
    const o2 = ov('o2', 'y', 'Yan', '2026-03-03 14:00:00', '2026-03-03 15:00:00', '2')
    const at = (s: string) => onCallAt(daily, members, [o1, o2], t(s))
    assert.equal(at('2026-03-03 11:59:00')?.primary.name, 'Bob')
    const r = at('2026-03-03 13:00:00')
    assert.equal(r?.primary.name, 'Zed')
    assert.equal(r?.scheduled.name, 'Bob')
    assert.equal(r?.override?.sys_id, 'o1')
    assert.equal(r?.secondary?.name, 'Carol')
    assert.equal(nowStr(new Date(r?.shiftEnd ?? 0)), '2026-03-03 14:00:00')
    assert.equal(at('2026-03-03 14:30:00')?.primary.name, 'Yan')
    assert.equal(at('2026-03-03 18:00:00')?.primary.name, 'Bob')
  })

  it('picks a secondary that differs from an overriding primary', () => {
    const o = ov('o', 'c', 'Carol', '2026-03-03 10:00:00', '2026-03-03 11:00:00')
    const r = onCallAt(daily, members, [o], t('2026-03-03 10:30:00'))
    assert.equal(r?.primary.name, 'Carol')
    assert.equal(r?.secondary?.name, 'Alice')
  })

  it('splits the timeline around overrides', () => {
    const o = ov('o', 'z', 'Zed', '2026-03-03 12:00:00', '2026-03-03 18:00:00')
    const segs = segmentsBetween(daily, members, [o], t('2026-03-03 10:00:00'), t('2026-03-04 10:00:00'))
    assert.deepEqual(
      segs.map((s) => [nowStr(new Date(s.startMs)), s.name, Boolean(s.override)]),
      [
        ['2026-03-03 09:00:00', 'Bob', false],
        ['2026-03-03 12:00:00', 'Zed', true],
        ['2026-03-03 18:00:00', 'Bob', false],
        ['2026-03-04 09:00:00', 'Carol', false],
      ],
    )
  })
})

describe('on-call API and auto-assign', () => {
  let server: Server
  let base = ''
  let db: Db
  let adminId = ''
  let callerId = ''

  // oxlint-disable-next-line typescript/no-explicit-any
  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-User': adminId }, body: body ? JSON.stringify(body) : undefined })
    // oxlint-disable-next-line typescript/no-explicit-any
    const json: any = res.status === 204 ? null : await res.json()
    return { status: res.status, json }
  }
  const groupId = (name: string) => (db.prepare('SELECT sys_id FROM sys_user_group WHERE name = ?').get(name) as { sys_id: string }).sys_id
  const userId = (u: string) => (db.prepare('SELECT sys_id FROM sys_user WHERE user_name = ?').get(u) as { sys_id: string }).sys_id
  const notes = async (id: string) => ((await call('GET', `/api/now/journal/incident/${id}`)).json.result as { element: string; value: string }[]).filter((j) => j.element === 'work_notes')

  before(async () => {
    db = openDb(':memory:')
    seed(db)
    server = createApp(db).listen(0)
    await new Promise((r) => server.once('listening', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    adminId = (await call('POST', '/api/login', { user_name: 'admin', password: 'demo' })).json.result.sys_id
    callerId = userId('abel.tuter')
  })
  after(() => server.close())

  it('seeds a rota with 3-4 members for every assignment group', async () => {
    const groups = (db.prepare('SELECT COUNT(*) AS n FROM sys_user_group').get() as { n: number }).n
    const { json } = await call('GET', '/api/now/oncall/current')
    assert.equal(json.result.length, groups)
    for (const g of json.result) {
      assert.ok(g.primary.name)
      assert.deepEqual(g.escalation.map((e: { level: string }) => e.level).slice(0, 2), ['Primary', 'Secondary'])
      const sched = await call('GET', `/api/now/oncall/${g.group.sys_id}/schedule?days=14`)
      assert.ok(sched.json.result.members.length >= 3 && sched.json.result.members.length <= 4)
      assert.ok(sched.json.result.segments.length > 0)
    }
    assert.ok(json.result.some((g: { override: unknown }) => g.override), 'a seeded override is active now')
  })

  it('creates an override that becomes the primary now', async () => {
    const net = groupId('Network')
    const start = nowStr(new Date(Date.now() - H))
    const end = nowStr(new Date(Date.now() + 4 * H))
    const bad = await call('POST', `/api/now/oncall/${net}/override`, { member: userId('itil'), start: end, end: start })
    assert.equal(bad.status, 400)
    const { status } = await call('POST', `/api/now/oncall/${net}/override`, { member: userId('itil'), start, end, reason: 'Test swap' })
    assert.equal(status, 201)
    const now = (await call('GET', '/api/now/oncall/current')).json.result.find((g: { group: { name: string } }) => g.group.name === 'Network')
    assert.equal(now.primary.name, 'ITIL User')
    assert.equal(now.override.reason, 'Test swap')
  })

  it('auto-assigns a new P1 incident to the primary on-call with a work note', async () => {
    const net = groupId('Network')
    const { status, json } = await call('POST', '/api/now/table/incident', { caller_id: callerId, short_description: 'Core switch down', impact: '1', urgency: '1', assignment_group: net })
    assert.equal(status, 201)
    assert.equal(json.result.priority, '1')
    assert.equal(json.result.assigned_to, userId('itil'))
    assert.equal(json.result.state, '2')
    const wn = await notes(json.result.sys_id)
    assert.ok(wn.some((n) => n.value.startsWith('Auto-assigned to ITIL User (on-call for Network)')))
  })

  it('does not auto-assign P3 incidents or incidents that already have an assignee', async () => {
    const net = groupId('Network')
    const p3 = await call('POST', '/api/now/table/incident', { caller_id: callerId, short_description: 'Slow wifi', impact: '2', urgency: '2', assignment_group: net })
    assert.equal(p3.json.result.priority, '3')
    assert.equal(p3.json.result.assigned_to ?? '', '')
    const pre = await call('POST', '/api/now/table/incident', { caller_id: callerId, short_description: 'VPN down', impact: '1', urgency: '1', assignment_group: net, assigned_to: userId('beth.anglin') })
    assert.equal(pre.json.result.assigned_to, userId('beth.anglin'))
    assert.equal((await notes(pre.json.result.sys_id)).length, 0)
  })

  it('auto-assigns when an unassigned incident is escalated to P2', async () => {
    const sd = groupId('Service Desk')
    const created = await call('POST', '/api/now/table/incident', { caller_id: callerId, short_description: 'Printer queue stuck', impact: '3', urgency: '3', assignment_group: sd })
    assert.equal(created.json.result.assigned_to ?? '', '')
    const expected = (await call('GET', '/api/now/oncall/current')).json.result.find((g: { group: { name: string } }) => g.group.name === 'Service Desk')
    const upd = await call('PATCH', `/api/now/table/incident/${created.json.result.sys_id}`, { impact: '1', urgency: '2' })
    assert.equal(upd.json.result.priority, '2')
    assert.equal(upd.json.result.assigned_to, expected.primary.sys_id)
    const wn = await notes(created.json.result.sys_id)
    assert.ok(wn.some((n) => n.value.startsWith(`Auto-assigned to ${expected.primary.name} (on-call for Service Desk)`)))
  })

  it('skips groups without an active rota', async () => {
    const g = insertRecord(db, 'sys_user_group', { name: 'Facilities', active: 'true' }, null)
    const { json } = await call('POST', '/api/now/table/incident', { caller_id: callerId, short_description: 'Water leak', impact: '1', urgency: '1', assignment_group: g.sys_id })
    assert.equal(json.result.assigned_to ?? '', '')
  })
})
