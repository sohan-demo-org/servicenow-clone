import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { insertRecord, listRecords, openDb, parseEncodedQuery } from './db.ts'
import type { Db, Row } from './db.ts'
import { seed } from './seed.ts'
import { TABLES } from '../shared/schema.ts'

const incident = TABLES.incident
const catItem = TABLES.sc_cat_item
const parse = (q: string | undefined, userId?: string) => parseEncodedQuery(incident, q, { userId })

describe('parseEncodedQuery', () => {
  it('returns no clauses for an empty or missing query', () => {
    assert.deepEqual(parse(undefined), { where: [], params: [], order: [] })
    assert.deepEqual(parse(''), { where: [], params: [], order: [] })
    assert.deepEqual(parse('^^'), { where: [], params: [], order: [] })
  })

  it('ANDs top-level conditions joined by ^', () => {
    assert.deepEqual(parse('state=1^priority=2'), { where: ['"state" = ?', '"priority" = ?'], params: ['1', '2'], order: [] })
  })

  it('groups ^OR conditions with the preceding condition', () => {
    const q = parse('state=1^priority=1^ORpriority=2^ORurgency=1')
    assert.deepEqual(q.where, ['"state" = ?', '("priority" = ? OR "priority" = ? OR "urgency" = ?)'])
    assert.deepEqual(q.params, ['1', '1', '2', '1'])
  })

  it('drops a leading ^OR that has nothing to attach to', () => {
    assert.deepEqual(parse('ORpriority=1').where, [])
  })

  it('collects ORDERBY and ORDERBYDESC in order without adding filters', () => {
    const q = parse('ORDERBYDESCpriority^state=2^ORDERBYnumber')
    assert.deepEqual(q.order, ['"priority" DESC', '"number" ASC'])
    assert.deepEqual(q.where, ['"state" = ?'])
  })

  it('ignores unknown fields, unknown operators and unknown sort fields', () => {
    assert.deepEqual(parse('bogus=1^ORDERBYbogus^ORDERBYDESCnumber;DROP TABLE incident^state~1'), { where: [], params: [], order: [] })
  })

  it('accepts sys_ columns', () => {
    assert.deepEqual(parse('sys_id=abc^ORDERBYDESCsys_created_on'), { where: ['"sys_id" = ?'], params: ['abc'], order: ['"sys_created_on" DESC'] })
  })

  it('translates string operators to LIKE patterns', () => {
    assert.deepEqual(parse('short_descriptionLIKEvpn'), { where: ['"short_description" LIKE ?'], params: ['%vpn%'], order: [] })
    assert.deepEqual(parse('numberSTARTSWITHINC00'), { where: ['"number" LIKE ?'], params: ['INC00%'], order: [] })
    assert.deepEqual(parse('short_descriptionNOTLIKEvpn'), { where: ['("short_description" IS NULL OR "short_description" NOT LIKE ?)'], params: ['%vpn%'], order: [] })
  })

  it('splits IN / NOTIN value lists into placeholders', () => {
    assert.deepEqual(parse('stateIN1,2,3'), { where: ['"state" IN (?,?,?)'], params: ['1', '2', '3'], order: [] })
    assert.deepEqual(parse('stateNOTIN6,7'), { where: ['("state" IS NULL OR "state" NOT IN (?,?))'], params: ['6', '7'], order: [] })
  })

  it('handles ISEMPTY / ISNOTEMPTY without parameters', () => {
    assert.deepEqual(parse('assigned_toISEMPTY'), { where: [`("assigned_to" IS NULL OR "assigned_to" = '')`], params: [], order: [] })
    assert.deepEqual(parse('assigned_toISNOTEMPTY'), { where: [`("assigned_to" IS NOT NULL AND "assigned_to" != '')`], params: [], order: [] })
  })

  it('treats != as null-inclusive', () => {
    assert.deepEqual(parse('state!=6'), { where: ['("state" IS NULL OR "state" != ?)'], params: ['6'], order: [] })
  })

  it('matches two-character comparison operators before =, < and >', () => {
    assert.deepEqual(parse('priority>=2').where, ['"priority" >= ?'])
    assert.deepEqual(parse('priority<=2').where, ['"priority" <= ?'])
    assert.deepEqual(parse('priority>2').where, ['"priority" > ?'])
    assert.deepEqual(parse('priority<2').where, ['"priority" < ?'])
    assert.deepEqual(parse('priority>=2').params, ['2'])
  })

  it('casts integer and currency fields for numeric comparison', () => {
    assert.deepEqual(parseEncodedQuery(catItem, 'price>=1000', {}).where, ['CAST("price" AS REAL) >= CAST(? AS REAL)'])
    assert.deepEqual(parseEncodedQuery(TABLES.kb_knowledge, 'sys_view_count>100', {}).where, ['CAST("sys_view_count" AS REAL) > CAST(? AS REAL)'])
  })

  it('keeps everything after the operator as the value, including = signs', () => {
    assert.deepEqual(parse('short_description=a=b').params, ['a=b'])
  })

  it('resolves javascript:gs.getUserID() from the context', () => {
    assert.deepEqual(parse('caller_id=javascript:gs.getUserID()', 'u123').params, ['u123'])
    assert.deepEqual(parse('caller_id=javascript:gs.getUserID()').params, [''])
  })

  it('resolves javascript:gs.daysAgo(n) to a timestamp n days in the past', () => {
    const [value] = parse('sys_created_on>=javascript:gs.daysAgo(7)').params
    assert.match(value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    const ms = Date.parse(value.replace(' ', 'T') + 'Z')
    assert.ok(Math.abs(Date.now() - 7 * 86400000 - ms) < 5000)
  })
})

describe('listRecords against a hand-built fixture', () => {
  let db: Db
  const ids: Record<string, string> = {}

  before(() => {
    db = openDb(':memory:')
    for (const [name, price, sd] of [
      ['Mouse', 25, 'Wireless mouse'],
      ['Laptop', 2499, 'Developer laptop'],
      ['Monitor', 1000, null],
      ['Visio', 280, 'Diagramming license'],
      ['Badge', 99, 'Replacement badge'],
    ] as const) {
      ids[name] = String(insertRecord(db, 'sc_cat_item', { name, price, short_description: sd, category: price >= 1000 ? 'hardware' : 'software' }, null).sys_id)
    }
  })

  const names = (r: { result: Row[] }) => r.result.map((x) => x.name)

  it('applies the table default sort when no ORDERBY is given', () => {
    assert.deepEqual(names(listRecords(db, 'sc_cat_item', { ctx: {} })), ['Badge', 'Laptop', 'Monitor', 'Mouse', 'Visio'])
  })

  it('compares currency numerically rather than lexically', () => {
    assert.deepEqual(names(listRecords(db, 'sc_cat_item', { query: 'price>=1000^ORDERBYprice', ctx: {} })), ['Monitor', 'Laptop'])
    assert.deepEqual(names(listRecords(db, 'sc_cat_item', { query: 'price<100^ORDERBYDESCprice', ctx: {} })), ['Badge', 'Mouse'])
  })

  it('includes empty values for NOTLIKE and != but not for LIKE', () => {
    assert.deepEqual(names(listRecords(db, 'sc_cat_item', { query: 'short_descriptionNOTLIKElaptop', ctx: {} })), ['Badge', 'Monitor', 'Mouse', 'Visio'])
    assert.deepEqual(names(listRecords(db, 'sc_cat_item', { query: 'short_description!=Wireless mouse', ctx: {} })), ['Badge', 'Laptop', 'Monitor', 'Visio'])
    assert.deepEqual(names(listRecords(db, 'sc_cat_item', { query: 'short_descriptionLIKEl', ctx: {} })), ['Badge', 'Laptop', 'Mouse', 'Visio'])
  })

  it('filters on empty and non-empty values', () => {
    assert.deepEqual(names(listRecords(db, 'sc_cat_item', { query: 'short_descriptionISEMPTY', ctx: {} })), ['Monitor'])
    assert.equal(listRecords(db, 'sc_cat_item', { query: 'short_descriptionISNOTEMPTY', ctx: {} }).total, 4)
  })

  it('combines AND, OR, IN and sorting', () => {
    const r = listRecords(db, 'sc_cat_item', { query: 'category=software^nameINVisio,Badge^ORprice>2000^ORDERBYDESCname', ctx: {} })
    assert.deepEqual(names(r), ['Visio', 'Badge'])
  })

  it('reports the full total while paging with limit and offset', () => {
    const page = listRecords(db, 'sc_cat_item', { limit: 2, offset: 2, ctx: {} })
    assert.equal(page.total, 5)
    assert.deepEqual(names(page), ['Monitor', 'Mouse'])
  })

  it('clamps limit to 1..1000 and offset to >= 0', () => {
    assert.equal(listRecords(db, 'sc_cat_item', { limit: 0, ctx: {} }).result.length, 1)
    assert.equal(listRecords(db, 'sc_cat_item', { limit: 5000, ctx: {} }).result.length, 5)
    assert.deepEqual(names(listRecords(db, 'sc_cat_item', { limit: 1, offset: -3, ctx: {} })), ['Badge'])
  })

  it('searches free text across string and text columns', () => {
    assert.deepEqual(names(listRecords(db, 'sc_cat_item', { text: 'license', ctx: {} })), ['Visio'])
    assert.deepEqual(names(listRecords(db, 'sc_cat_item', { text: 'lap', query: 'price>100', ctx: {} })), ['Laptop'])
  })

  it('looks up a record by sys_id', () => {
    assert.deepEqual(names(listRecords(db, 'sc_cat_item', { query: `sys_id=${ids.Mouse}`, ctx: {} })), ['Mouse'])
  })

  it('rejects unknown tables with a 400', () => {
    assert.throws(() => listRecords(db, 'nope', { ctx: {} }), { status: 400, message: 'Invalid table nope' })
  })
})

describe('listRecords against seeded data', () => {
  let db: Db

  before(() => {
    db = openDb(':memory:')
    seed(db)
  })

  it('returns only matching priorities for an ^OR query, ordered by number', () => {
    const r = listRecords(db, 'incident', { query: 'priority=1^ORpriority=2^ORDERBYnumber', limit: 1000, ctx: {} })
    assert.ok(r.total > 0)
    assert.equal(r.result.length, r.total)
    for (const rec of r.result) assert.ok(['1', '2'].includes(String(rec.priority)))
    const numbers = r.result.map((x) => String(x.number))
    assert.deepEqual(numbers, [...numbers].sort())
  })

  it('matches the complement for NOTIN', () => {
    const all = listRecords(db, 'incident', { ctx: {} }).total
    const open = listRecords(db, 'incident', { query: 'stateNOTIN6,7', ctx: {} }).total
    const closed = listRecords(db, 'incident', { query: 'stateIN6,7', ctx: {} }).total
    assert.equal(open + closed, all)
  })

  it('scopes "my" records with javascript:gs.getUserID()', () => {
    const someone = listRecords(db, 'incident', { query: 'caller_idISNOTEMPTY', limit: 1, ctx: {} }).result[0]
    const mine = listRecords(db, 'incident', { query: 'caller_id=javascript:gs.getUserID()', limit: 1000, ctx: { userId: String(someone.caller_id) } })
    assert.ok(mine.total >= 1)
    for (const r of mine.result) assert.equal(r.caller_id, someone.caller_id)
    assert.equal(listRecords(db, 'incident', { query: 'caller_id=javascript:gs.getUserID()', ctx: {} }).total, 0)
  })

  it('filters by relative dates with javascript:gs.daysAgo(n)', () => {
    const all = listRecords(db, 'incident', { ctx: {} }).total
    assert.equal(listRecords(db, 'incident', { query: 'sys_created_on>=javascript:gs.daysAgo(365)', ctx: {} }).total, all)
    assert.equal(listRecords(db, 'incident', { query: 'sys_created_on>=javascript:gs.daysAgo(0)', ctx: {} }).total, 0)
  })
})
