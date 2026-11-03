import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { listJournal, openDb } from './db.ts'
import type { Db, Row } from './db.ts'
import { seed } from './seed.ts'
import { TABLES, calcPriority } from '../shared/schema.ts'

const all = (db: Db, table: string, order = 'number') => db.prepare(`SELECT * FROM ${table} ORDER BY "${order}"`).all() as Row[]
const count = (db: Db, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

describe('seed', () => {
  let db: Db

  before(() => {
    db = openDb(':memory:')
    seed(db)
  })

  it('populates every table', () => {
    for (const t of Object.keys(TABLES)) assert.ok(count(db, t) > 0, t)
  })

  it('is a no-op on an already-seeded database', () => {
    const before = Object.fromEntries(Object.keys(TABLES).map((t) => [t, count(db, t)]))
    const journal = count(db, 'sys_journal_field')
    seed(db)
    assert.deepEqual(Object.fromEntries(Object.keys(TABLES).map((t) => [t, count(db, t)])), before)
    assert.equal(count(db, 'sys_journal_field'), journal)
  })

  it('produces the same records on every run', () => {
    const other = openDb(':memory:')
    seed(other)
    const shape = (d: Db) => all(d, 'incident').map((r) => [r.number, r.short_description, r.impact, r.urgency, r.priority, r.state, r.contact_type])
    assert.deepEqual(shape(other), shape(db))
    const ritm = (d: Db) => all(d, 'sc_req_item').map((r) => [r.number, r.short_description, r.quantity, r.price, r.stage])
    assert.deepEqual(ritm(other), ritm(db))
  })

  it('creates the demo login accounts', () => {
    const users: Record<string, Row> = Object.fromEntries(all(db, 'sys_user', 'user_name').map((u) => [String(u.user_name), u]))
    assert.equal(users.admin.role, 'admin')
    assert.equal(users.itil.role, 'itil')
    assert.equal(users.employee.role, 'user')
    for (const u of Object.values(users)) assert.equal(u.active, 'true')
  })

  it('leaves no dangling references', () => {
    for (const t of Object.values(TABLES)) {
      for (const f of t.fields.filter((x) => x.type === 'reference' && x.ref)) {
        const dangling = db
          .prepare(`SELECT COUNT(*) AS n FROM ${t.name} WHERE "${f.name}" IS NOT NULL AND "${f.name}" != '' AND "${f.name}" NOT IN (SELECT sys_id FROM ${f.ref})`)
          .get() as { n: number }
        assert.equal(dangling.n, 0, `${t.name}.${f.name}`)
      }
    }
  })

  it('assigns unique, correctly prefixed numbers', () => {
    for (const t of Object.values(TABLES).filter((x) => x.prefix)) {
      const numbers = all(db, t.name).map((r) => String(r.number))
      assert.equal(new Set(numbers).size, numbers.length, t.name)
      for (const n of numbers) assert.match(n, new RegExp(`^${t.prefix}\\d{7}$`))
    }
  })

  it('only uses choice values defined in the schema', () => {
    for (const t of Object.values(TABLES)) {
      for (const f of t.fields.filter((x) => x.type === 'choice')) {
        const allowed = new Set(f.choices?.map((c) => c.value))
        for (const r of all(db, t.name, 'sys_id')) {
          if (r[f.name] != null && r[f.name] !== '') assert.ok(allowed.has(String(r[f.name])), `${t.name}.${f.name}=${r[f.name]}`)
        }
      }
    }
  })

  it('keeps incident and problem priority consistent with impact and urgency', () => {
    for (const t of ['incident', 'problem']) {
      for (const r of all(db, t)) assert.equal(r.priority, calcPriority(String(r.impact), String(r.urgency)), `${r.number}`)
    }
  })

  it('gives resolved incidents resolution info and leaves open ones unresolved', () => {
    for (const r of all(db, 'incident')) {
      const resolved = ['6', '7'].includes(String(r.state))
      assert.equal(Boolean(r.close_code && r.close_notes && r.resolved_at), resolved, `${r.number} state ${r.state}`)
      if (r.state === '1') assert.equal(r.assigned_to, null, `${r.number} is New but assigned`)
    }
  })

  it('upgrades the first incident to Critical with an audit trail', () => {
    const first = all(db, 'incident')[0]
    assert.equal(first.priority, '1')
    const audit = (listJournal(db, String(first.sys_id)) as { element: string; value: string }[]).filter((j) => j.element === 'audit')
    assert.equal(audit.length, 1)
    assert.ok(JSON.parse(audit[0].value).some((d: { field: string; new: string }) => d.field === 'priority' && d.new === '1 - Critical'))
  })

  it('keeps requested-item approval in sync with stage', () => {
    for (const r of all(db, 'sc_req_item')) {
      assert.equal(r.approval === 'requested', r.stage === 'waiting_for_approval', String(r.number))
      if (r.stage === 'complete') assert.equal(r.state, '3')
    }
  })

  it('pre-approves standard changes and requests approval for changes in Authorize', () => {
    for (const r of all(db, 'change_request')) {
      if (r.type === 'standard') assert.equal(r.approval, 'approved', String(r.number))
      else if (r.state === '-3') assert.equal(r.approval, 'requested', String(r.number))
    }
    assert.ok(all(db, 'change_request').some((r) => r.approval === 'requested'), 'at least one change awaits approval')
  })

  it('gives knowledge articles view counts and ratings', () => {
    for (const r of all(db, 'kb_knowledge')) {
      assert.ok(Number(r.sys_view_count) >= 20, String(r.number))
      assert.ok(Number(r.rating) >= 0)
    }
  })
})
