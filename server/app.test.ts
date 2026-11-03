import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { APPROVAL_PRICE_THRESHOLD, SEARCH_TARGETS, approvalFields, formatVariables, globalSearch, orderTerms } from './app.ts'
import { HttpError, getRecord, listJournal, listRecords, openDb, updateRecord } from './db.ts'
import type { Db } from './db.ts'
import { seed } from './seed.ts'
import { TABLES } from '../shared/schema.ts'

describe('orderTerms', () => {
  it('requires approval at or above the price threshold', () => {
    assert.equal(APPROVAL_PRICE_THRESHOLD, 1000)
    assert.deepEqual(orderTerms(999, 1), { quantity: 1, price: 999, needsApproval: false })
    assert.deepEqual(orderTerms(1000, 1), { quantity: 1, price: 1000, needsApproval: true })
    assert.deepEqual(orderTerms(2499, 1), { quantity: 1, price: 2499, needsApproval: true })
  })

  it('routes by total price, not unit price', () => {
    assert.deepEqual(orderTerms(500, 2), { quantity: 2, price: 1000, needsApproval: true })
    assert.equal(orderTerms(349, 2).needsApproval, false)
  })

  it('clamps quantity to 1..10 and defaults invalid input to 1', () => {
    assert.equal(orderTerms(10, 50).quantity, 10)
    assert.equal(orderTerms(10, -5).quantity, 1)
    assert.equal(orderTerms(10, 0).quantity, 1)
    assert.equal(orderTerms(10, 'abc').quantity, 1)
    assert.equal(orderTerms(10, undefined).quantity, 1)
    assert.equal(orderTerms(10, '3').quantity, 3)
  })

  it('treats free and unpriced items as not needing approval', () => {
    assert.deepEqual(orderTerms(0, 10), { quantity: 10, price: 0, needsApproval: false })
    assert.deepEqual(orderTerms(null, 1), { quantity: 1, price: 0, needsApproval: false })
  })
})

describe('formatVariables', () => {
  it('renders answered variables as key: value lines', () => {
    assert.equal(formatVariables({ Color: 'Silver', Size: '', Notes: null, Qty: 2, Rush: false }), 'Color: Silver\nQty: 2\nRush: false')
  })

  it('returns an empty string for missing or non-object input', () => {
    assert.equal(formatVariables(undefined), '')
    assert.equal(formatVariables(null), '')
    assert.equal(formatVariables('Color: Silver'), '')
    assert.equal(formatVariables({}), '')
  })
})

describe('approvalFields', () => {
  it('schedules approved changes and returns rejected ones to New', () => {
    assert.deepEqual(approvalFields('change_request', 'approved'), { approval: 'approved', state: '-2' })
    assert.deepEqual(approvalFields('change_request', 'rejected'), { approval: 'rejected', state: '-5' })
  })

  it('sends approved requested items to fulfillment and closes rejected ones incomplete', () => {
    assert.deepEqual(approvalFields('sc_req_item', 'approved'), { approval: 'approved', stage: 'fulfillment', state: '2' })
    assert.deepEqual(approvalFields('sc_req_item', 'rejected'), { approval: 'rejected', stage: 'complete', state: '4' })
  })

  it('rejects approvals on other tables', () => {
    assert.throws(() => approvalFields('incident', 'approved'), (e: unknown) => e instanceof HttpError && e.status === 400 && e.message === 'Approvals are not supported for incident')
  })
})

describe('approval transitions on seeded records', () => {
  let db: Db
  const approver = { sys_id: 'u-chg', user_name: 'don.goodliffe', name: 'Don Goodliffe' }

  before(() => {
    db = openDb(':memory:')
    seed(db)
  })

  const first = (table: string, query: string) => listRecords(db, table, { query, limit: 1, ctx: {} }).result[0]

  it('approves a pending requested item into fulfillment with an audit entry', () => {
    const ritm = first('sc_req_item', 'stage=waiting_for_approval')
    const r = updateRecord(db, 'sc_req_item', String(ritm.sys_id), approvalFields('sc_req_item', 'approved'), approver)
    assert.deepEqual([r.approval, r.stage, r.state], ['approved', 'fulfillment', '2'])
    const audit = (listJournal(db, String(ritm.sys_id)) as { element: string; value: string }[]).find((j) => j.element === 'audit')
    assert.ok(audit?.value.includes('Fulfillment'))
  })

  it('rejects a change awaiting approval back to New', () => {
    const chg = first('change_request', 'approval=requested')
    updateRecord(db, 'change_request', String(chg.sys_id), approvalFields('change_request', 'rejected'), approver)
    const r = getRecord(db, 'change_request', String(chg.sys_id))
    assert.deepEqual([r.approval, r.state, r.sys_updated_by], ['rejected', '-5', 'don.goodliffe'])
  })
})

describe('globalSearch', () => {
  let db: Db

  before(() => {
    db = openDb(':memory:')
    seed(db)
  })

  it('searches only tables that exist in the schema', () => {
    for (const [table] of SEARCH_TARGETS) assert.ok(TABLES[table], table)
  })

  it('returns nothing for blank queries', () => {
    assert.deepEqual(globalSearch(db, undefined), [])
    assert.deepEqual(globalSearch(db, ''), [])
    assert.deepEqual(globalSearch(db, '   '), [])
  })

  it('groups matches by table with plural labels, capped at 5 records each', () => {
    const groups = globalSearch(db, 'vpn')
    const tables = groups.map((g) => g.table)
    assert.ok(tables.includes('incident'))
    assert.ok(tables.includes('kb_knowledge'))
    assert.deepEqual(tables, SEARCH_TARGETS.map(([t]) => t).filter((t) => tables.includes(t)), 'preserves target order')
    for (const g of groups) {
      assert.equal(g.label, TABLES[g.table].plural)
      assert.ok(g.total > 0)
      assert.ok(g.records.length <= 5 && g.records.length <= g.total)
    }
  })

  it('reports the full match count beyond the 5-record cap', () => {
    const inc = globalSearch(db, 'INC').find((g) => g.table === 'incident')
    assert.equal(inc?.total, listRecords(db, 'incident', { ctx: {} }).total)
    assert.equal(inc?.records.length, 5)
  })

  it('finds records by number, KB body text, CI IP address and user email', () => {
    const number = String(listRecords(db, 'incident', { limit: 1, ctx: {} }).result[0].number)
    assert.deepEqual(globalSearch(db, number).find((g) => g.table === 'incident')?.records.map((r) => r.number), [number])
    assert.ok(globalSearch(db, 'GlobalProtect').some((g) => g.table === 'kb_knowledge'))
    assert.equal(globalSearch(db, '10.10.4.31').find((g) => g.table === 'cmdb_ci')?.records[0].name, 'ora-prod-db1')
    assert.equal(globalSearch(db, 'abel.tuter@example').find((g) => g.table === 'sys_user')?.records[0].name, 'Abel Tuter')
  })

  it('trims input and strips ^ so callers cannot inject extra query clauses', () => {
    assert.deepEqual(globalSearch(db, '  vpn  '), globalSearch(db, 'vpn'))
    assert.deepEqual(globalSearch(db, 'v^pn'), globalSearch(db, 'vpn'))
    assert.deepEqual(globalSearch(db, 'zz-no-match^ORnumberLIKEINC'), [])
  })

  it('returns an empty list when nothing matches', () => {
    assert.deepEqual(globalSearch(db, 'zz-definitely-no-match'), [])
  })
})
