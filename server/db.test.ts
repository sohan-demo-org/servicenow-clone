import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  HttpError,
  addJournal,
  deleteRecord,
  getRecord,
  groupCounts,
  insertRecord,
  listJournal,
  nextNumber,
  nowStr,
  openDb,
  sysId,
  tableDef,
  updateRecord,
} from './db.ts'
import type { Db, Row } from './db.ts'

const admin = { sys_id: 'u-admin', user_name: 'admin', name: 'System Administrator' }

interface JournalRow {
  element: string
  value: string
  sys_created_by: string
  sys_created_on: string
}

function fixture() {
  const db = openDb(':memory:')
  const caller = insertRecord(db, 'sys_user', { user_name: 'abel.tuter', name: 'Abel Tuter' }, null)
  const agent = insertRecord(db, 'sys_user', { user_name: 'beth.anglin', name: 'Beth Anglin', role: 'itil' }, null)
  const group = insertRecord(db, 'sys_user_group', { name: 'Service Desk', manager: agent.sys_id }, null)
  return { db, caller: String(caller.sys_id), agent: String(agent.sys_id), group: String(group.sys_id) }
}

const journal = (db: Db, id: string) => listJournal(db, id) as unknown as JournalRow[]
const audits = (db: Db, id: string) => journal(db, id).filter((j) => j.element === 'audit')

describe('helpers', () => {
  it('nowStr formats a UTC timestamp as YYYY-MM-DD HH:MM:SS', () => {
    assert.equal(nowStr(new Date('2026-01-02T03:04:05.678Z')), '2026-01-02 03:04:05')
    assert.match(nowStr(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('sysId returns unique 32-char hex ids', () => {
    const ids = new Set(Array.from({ length: 50 }, sysId))
    assert.equal(ids.size, 50)
    for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/)
  })

  it('tableDef returns known tables and rejects unknown ones with a 400', () => {
    assert.equal(tableDef('incident').prefix, 'INC')
    assert.throws(() => tableDef('nope'), (e: unknown) => e instanceof HttpError && e.status === 400)
  })
})

describe('nextNumber', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(':memory:')
  })

  it('starts at 10001 and zero-pads to 7 digits', () => {
    assert.equal(nextNumber(db, 'INC'), 'INC0010001')
    assert.equal(nextNumber(db, 'INC'), 'INC0010002')
  })

  it('keeps an independent counter per prefix', () => {
    nextNumber(db, 'INC')
    nextNumber(db, 'INC')
    assert.equal(nextNumber(db, 'CHG'), 'CHG0010001')
    assert.equal(nextNumber(db, 'INC'), 'INC0010003')
  })

  it('is used to number inserted records on prefixed tables only', () => {
    const { db: d, caller } = fixture()
    assert.match(String(insertRecord(d, 'incident', { caller_id: caller, short_description: 'a' }, null).number), /^INC\d{7}$/)
    assert.match(String(insertRecord(d, 'kb_knowledge', { short_description: 'a' }, null).number), /^KB\d{7}$/)
    assert.equal(insertRecord(d, 'cmdb_ci', { name: 'srv' }, null).number, undefined)
  })

  it('keeps an explicitly supplied number', () => {
    const { db: d, caller } = fixture()
    assert.equal(insertRecord(d, 'incident', { caller_id: caller, short_description: 'a', number: 'INC9999999' }, null).number, 'INC9999999')
    assert.equal(insertRecord(d, 'incident', { caller_id: caller, short_description: 'b' }, null).number, 'INC0010001')
  })
})

describe('insertRecord', () => {
  let f: ReturnType<typeof fixture>
  beforeEach(() => {
    f = fixture()
  })

  it('rejects missing or blank mandatory fields with the field label', () => {
    assert.throws(() => insertRecord(f.db, 'incident', { short_description: 'no caller' }, null), { status: 400, message: 'Mandatory fields missing', detail: 'Caller is mandatory' })
    assert.throws(() => insertRecord(f.db, 'incident', { caller_id: f.caller, short_description: '' }, null), { status: 400, detail: 'Short description is mandatory' })
    assert.throws(() => insertRecord(f.db, 'change_request', { short_description: 'x' }, null), { detail: 'Requested by is mandatory' })
    assert.throws(() => insertRecord(f.db, 'sc_req_item', { cat_item: 'x' }, null), { detail: 'Requested for is mandatory' })
  })

  it('enforces mandatory fields even when business rules are skipped', () => {
    assert.throws(() => insertRecord(f.db, 'incident', { short_description: 'x' }, null, { skipRules: true }), { status: 400 })
  })

  it('applies incident defaults and computes priority', () => {
    const inc = insertRecord(f.db, 'incident', { caller_id: f.caller, short_description: 'Printer down' }, admin)
    assert.equal(inc.impact, '3')
    assert.equal(inc.urgency, '3')
    assert.equal(inc.priority, '5')
    assert.equal(inc.state, '1')
    assert.equal(inc.contact_type, 'phone')
    assert.match(String(inc.opened_at), /^\d{4}-\d{2}-\d{2} /)
    assert.equal(inc.sys_created_by, 'admin')
    assert.equal(inc.sys_created_on, inc.sys_updated_on)
  })

  it('overrides a client-supplied priority with the computed one', () => {
    const inc = insertRecord(f.db, 'incident', { caller_id: f.caller, short_description: 'x', impact: '1', urgency: '2', priority: '5' }, null)
    assert.equal(inc.priority, '2')
  })

  it('moves a new incident created with an assignee to In Progress', () => {
    assert.equal(insertRecord(f.db, 'incident', { caller_id: f.caller, short_description: 'x', assigned_to: f.agent }, null).state, '2')
    assert.equal(insertRecord(f.db, 'incident', { caller_id: f.caller, short_description: 'x', assigned_to: f.agent, state: '3' }, null).state, '3')
  })

  it('keeps supplied values verbatim when skipRules is set', () => {
    const inc = insertRecord(f.db, 'incident', { caller_id: f.caller, short_description: 'x', priority: '1', state: '6', opened_at: '2026-01-01 00:00:00' }, null, { skipRules: true })
    assert.equal(inc.priority, '1')
    assert.equal(inc.impact, null)
    assert.equal(inc.contact_type, null)
    assert.equal(inc.opened_at, '2026-01-01 00:00:00')
  })

  it('applies problem, change, knowledge and user defaults', () => {
    const prb = insertRecord(f.db, 'problem', { short_description: 'p', impact: '1', urgency: '1' }, null)
    assert.equal(prb.state, '101')
    assert.equal(prb.priority, '1')
    assert.match(String(prb.number), /^PRB\d{7}$/)

    const chg = insertRecord(f.db, 'change_request', { requested_by: f.agent, short_description: 'c' }, null)
    assert.deepEqual([chg.state, chg.type, chg.risk, chg.impact, chg.approval], ['-5', 'normal', '3', '3', 'not requested'])
    const std = insertRecord(f.db, 'change_request', { requested_by: f.agent, short_description: 's', type: 'standard', approval: 'requested' }, null)
    assert.equal(std.approval, 'approved')

    const kb = insertRecord(f.db, 'kb_knowledge', { short_description: 'k', rating: 50 }, null)
    assert.deepEqual([kb.workflow_state, kb.sys_view_count, kb.rating], ['draft', 0, 0])

    const u = insertRecord(f.db, 'sys_user', { user_name: 'new', name: 'New' }, null)
    assert.deepEqual([u.active, u.role], ['true', 'user'])
  })

  it('coerces values by field type and drops unknown fields', () => {
    const ritm = insertRecord(
      f.db,
      'sc_req_item',
      { cat_item: 'item', requested_for: f.caller, quantity: '3.7', price: '12.5', short_description: 42, bogus: 'x', assigned_to: '' },
      null,
    )
    assert.equal(ritm.quantity, 3)
    assert.equal(ritm.price, 12.5)
    assert.equal(ritm.short_description, '42')
    assert.equal(ritm.assigned_to, null)
    assert.equal('bogus' in ritm, false)
    const u = insertRecord(f.db, 'sys_user', { user_name: 'b', name: 'B', active: false }, null)
    assert.equal(u.active, 'false')
    assert.equal(insertRecord(f.db, 'sys_user', { user_name: 'c', name: 'C', active: true }, null).active, 'true')
  })

  it('honours a supplied sys_id and sys_created_on', () => {
    const r = insertRecord(f.db, 'cmdb_ci', { name: 'srv', sys_id: 'fixed-id', sys_created_on: '2025-05-05 05:05:05' }, null)
    assert.equal(r.sys_id, 'fixed-id')
    assert.equal(r.sys_created_on, '2025-05-05 05:05:05')
    assert.equal(r.sys_created_by, 'system')
  })
})

describe('reference display values (_dv)', () => {
  let f: ReturnType<typeof fixture>
  beforeEach(() => {
    f = fixture()
  })

  it('resolves each reference field to the referenced display field', () => {
    const inc = insertRecord(f.db, 'incident', { caller_id: f.caller, short_description: 'x', assigned_to: f.agent, assignment_group: f.group }, null)
    // oxlint-disable-next-line typescript/no-explicit-any
    const dv = (inc as any)._dv
    assert.deepEqual(dv, { caller_id: 'Abel Tuter', assigned_to: 'Beth Anglin', assignment_group: 'Service Desk' })
  })

  it('uses the number of numbered tables as their display value', () => {
    const prb = insertRecord(f.db, 'problem', { short_description: 'p' }, null)
    const inc = insertRecord(f.db, 'incident', { caller_id: f.caller, short_description: 'x', problem_id: prb.sys_id }, null)
    // oxlint-disable-next-line typescript/no-explicit-any
    assert.equal((inc as any)._dv.problem_id, prb.number)
  })

  it('returns an empty display value for dangling references and omits empty ones', () => {
    const inc = insertRecord(f.db, 'incident', { caller_id: 'missing-user', short_description: 'x' }, null)
    // oxlint-disable-next-line typescript/no-explicit-any
    assert.deepEqual((inc as any)._dv, { caller_id: '' })
  })

  it('reflects renamed references on the next read', () => {
    const inc = insertRecord(f.db, 'incident', { caller_id: f.caller, short_description: 'x' }, null)
    updateRecord(f.db, 'sys_user', f.caller, { name: 'Abel T.' }, null)
    // oxlint-disable-next-line typescript/no-explicit-any
    assert.equal((getRecord(f.db, 'incident', String(inc.sys_id)) as any)._dv.caller_id, 'Abel T.')
  })
})

describe('updateRecord', () => {
  let f: ReturnType<typeof fixture>
  let inc: Row
  beforeEach(() => {
    f = fixture()
    inc = insertRecord(f.db, 'incident', { caller_id: f.caller, short_description: 'VPN down', impact: '2', urgency: '2' }, null)
  })
  const id = () => String(inc.sys_id)

  it('404s for an unknown record', () => {
    assert.throws(() => updateRecord(f.db, 'incident', 'nope', { state: '2' }, null), { status: 404 })
  })

  it('rejects blanking a mandatory field but allows omitting it', () => {
    assert.throws(() => updateRecord(f.db, 'incident', id(), { caller_id: '' }, null), { status: 400, detail: 'Caller is mandatory' })
    assert.equal(updateRecord(f.db, 'incident', id(), { description: 'more' }, null).caller_id, f.caller)
  })

  it('recomputes priority when impact or urgency changes', () => {
    assert.equal(inc.priority, '3')
    assert.equal(updateRecord(f.db, 'incident', id(), { impact: '1' }, null).priority, '2')
    assert.equal(updateRecord(f.db, 'incident', id(), { urgency: '1' }, null).priority, '1')
    assert.equal(updateRecord(f.db, 'incident', id(), { priority: '5' }, null).priority, '5')
  })

  it('moves a New incident to In Progress when first assigned', () => {
    assert.equal(updateRecord(f.db, 'incident', id(), { assigned_to: f.agent }, null).state, '2')
  })

  it('respects an explicit non-New state when assigning', () => {
    assert.equal(updateRecord(f.db, 'incident', id(), { assigned_to: f.agent, state: '3' }, null).state, '3')
  })

  it('requires resolution code and notes to resolve', () => {
    const missing = { status: 400, detail: 'Resolution code and Resolution notes are required to resolve an incident' }
    assert.throws(() => updateRecord(f.db, 'incident', id(), { state: '6' }, null), missing)
    assert.throws(() => updateRecord(f.db, 'incident', id(), { state: '6', close_code: 'Solved (Permanently)' }, null), missing)
    assert.equal(getRecord(f.db, 'incident', id()).state, '1', 'failed update leaves record unchanged')
  })

  it('accepts resolution info already on the record', () => {
    updateRecord(f.db, 'incident', id(), { close_code: 'Solved (Work Around)', close_notes: 'Restarted' }, null)
    const r = updateRecord(f.db, 'incident', id(), { state: '6' }, null)
    assert.equal(r.state, '6')
    assert.ok(r.resolved_at)
  })

  it('stamps resolved_at on resolve and clears it on reopen', () => {
    const resolved = updateRecord(f.db, 'incident', id(), { state: '6', close_code: 'Solved (Permanently)', close_notes: 'Fixed' }, null)
    assert.match(String(resolved.resolved_at), /^\d{4}-\d{2}-\d{2} /)
    const closed = updateRecord(f.db, 'incident', id(), { state: '7' }, null)
    assert.equal(closed.resolved_at, resolved.resolved_at)
    assert.equal(updateRecord(f.db, 'incident', id(), { state: '2' }, null).resolved_at, null)
  })

  it('writes a labelled audit diff using display values', () => {
    updateRecord(f.db, 'incident', id(), { state: '6', close_code: 'Solved (Permanently)', close_notes: 'Fixed', assigned_to: f.agent }, admin)
    const [entry] = audits(f.db, id())
    assert.equal(entry.sys_created_by, 'System Administrator')
    const diff = JSON.parse(entry.value) as { field: string; label: string; old: string; new: string }[]
    const byField = Object.fromEntries(diff.map((d) => [d.field, d]))
    assert.deepEqual(byField.state, { field: 'state', label: 'State', old: 'New', new: 'Resolved' })
    assert.deepEqual(byField.assigned_to, { field: 'assigned_to', label: 'Assigned to', old: '', new: 'Beth Anglin' })
    assert.equal(byField.close_notes.new, 'Fixed')
    assert.equal(byField.resolved_at, undefined, 'timestamps are not audited')
  })

  it('skips the write and audit entry when nothing changed', () => {
    const before = getRecord(f.db, 'incident', id())
    const after = updateRecord(f.db, 'incident', id(), { short_description: 'VPN down', impact: '2' }, admin)
    assert.equal(after.sys_updated_on, before.sys_updated_on)
    assert.equal(after.sys_updated_by, 'system')
    assert.equal(audits(f.db, id()).length, 0)
  })

  it('records the acting user on change', () => {
    assert.equal(updateRecord(f.db, 'incident', id(), { description: 'x' }, admin).sys_updated_by, 'admin')
  })

  it('does not audit tables without a journal', () => {
    const ci = insertRecord(f.db, 'cmdb_ci', { name: 'srv' }, null)
    updateRecord(f.db, 'cmdb_ci', String(ci.sys_id), { name: 'srv-2' }, null)
    assert.equal(journal(f.db, String(ci.sys_id)).length, 0)
  })

  it('requests approval when a change enters Authorize', () => {
    const chg = insertRecord(f.db, 'change_request', { requested_by: f.agent, short_description: 'c' }, null)
    const cid = String(chg.sys_id)
    assert.equal(updateRecord(f.db, 'change_request', cid, { state: '-4' }, null).approval, 'not requested')
    assert.equal(updateRecord(f.db, 'change_request', cid, { state: '-3' }, null).approval, 'requested')
  })

  it('does not re-request approval for already-approved changes', () => {
    const std = insertRecord(f.db, 'change_request', { requested_by: f.agent, short_description: 's', type: 'standard' }, null)
    assert.equal(updateRecord(f.db, 'change_request', String(std.sys_id), { state: '-3' }, null).approval, 'approved')
  })
})

describe('getRecord / deleteRecord', () => {
  it('404s for unknown ids and deletes records with their journal', () => {
    const f = fixture()
    assert.throws(() => getRecord(f.db, 'incident', 'nope'), { status: 404, message: 'No Record found', detail: 'Record nope does not exist in incident' })
    const inc = insertRecord(f.db, 'incident', { caller_id: f.caller, short_description: 'x' }, null)
    const id = String(inc.sys_id)
    addJournal(f.db, 'incident', id, 'comments', 'hello', null)
    deleteRecord(f.db, 'incident', id)
    assert.throws(() => getRecord(f.db, 'incident', id), { status: 404 })
    assert.equal(journal(f.db, id).length, 0)
    assert.throws(() => deleteRecord(f.db, 'incident', id), { status: 404 })
  })
})

describe('journal', () => {
  it('stores entries with author and returns them newest first', () => {
    const db = openDb(':memory:')
    const e1 = addJournal(db, 'incident', 'rec1', 'comments', 'first', admin, '2026-01-01 10:00:00')
    addJournal(db, 'incident', 'rec1', 'work_notes', 'second', null, '2026-01-01 11:00:00')
    addJournal(db, 'incident', 'rec1', 'comments', 'same-time-later', admin, '2026-01-01 11:00:00')
    addJournal(db, 'incident', 'rec2', 'comments', 'other record', admin)
    assert.equal(e1.sys_created_by, 'System Administrator')
    assert.equal(e1.element_id, 'rec1')
    const rows = journal(db, 'rec1')
    assert.deepEqual(rows.map((r) => r.value), ['same-time-later', 'second', 'first'])
    assert.equal(rows[1].sys_created_by, 'System Administrator', 'null actor defaults to System Administrator')
    assert.equal(rows[1].element, 'work_notes')
  })
})

describe('groupCounts', () => {
  let f: ReturnType<typeof fixture>
  beforeEach(() => {
    f = fixture()
    const mk = (body: Record<string, unknown>) => insertRecord(f.db, 'incident', { caller_id: f.caller, short_description: 'x', ...body }, null)
    mk({ impact: '1', urgency: '1', assignment_group: f.group })
    mk({ impact: '1', urgency: '1', assignment_group: f.group })
    mk({ impact: '2', urgency: '2', assignment_group: f.group })
    mk({})
  })

  it('counts by a choice field with labels, largest group first', () => {
    const [top, ...rest] = groupCounts(f.db, 'incident', 'priority', undefined, {})
    assert.deepEqual(top, { value: '1', label: '1 - Critical', count: 2 })
    assert.deepEqual(
      rest.sort((a, b) => a.value.localeCompare(b.value)),
      [
        { value: '3', label: '3 - Moderate', count: 1 },
        { value: '5', label: '5 - Planning', count: 1 },
      ],
    )
  })

  it('labels reference groups by display value and empty groups as (empty)', () => {
    assert.deepEqual(groupCounts(f.db, 'incident', 'assignment_group', undefined, {}), [
      { value: f.group, label: 'Service Desk', count: 3 },
      { value: '', label: '(empty)', count: 1 },
    ])
  })

  it('applies an encoded query filter', () => {
    assert.deepEqual(groupCounts(f.db, 'incident', 'state', 'priority=1', {}), [{ value: '1', label: 'New', count: 2 }])
    assert.deepEqual(groupCounts(f.db, 'incident', 'state', 'caller_id=javascript:gs.getUserID()', { userId: 'someone-else' }), [])
  })

  it('rejects unknown group-by fields and tables', () => {
    assert.throws(() => groupCounts(f.db, 'incident', 'bogus', undefined, {}), { status: 400, message: 'Invalid group by field bogus' })
    assert.throws(() => groupCounts(f.db, 'nope', 'state', undefined, {}), { status: 400 })
  })
})
