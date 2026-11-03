import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { IMPACT, PRIORITY, PRIORITY_MATRIX, SLA_HOURS, TABLES, URGENCY, calcPriority, choiceLabel, getField } from '../shared/schema.ts'

describe('calcPriority', () => {
  it('maps every impact/urgency pair through the ITIL priority matrix', () => {
    const expected: Record<string, string> = {
      '1-1': '1', '1-2': '2', '1-3': '3',
      '2-1': '2', '2-2': '3', '2-3': '4',
      '3-1': '3', '3-2': '4', '3-3': '5',
    }
    for (const i of IMPACT) {
      for (const u of URGENCY) assert.equal(calcPriority(i.value, u.value), expected[`${i.value}-${u.value}`], `impact ${i.value} urgency ${u.value}`)
    }
  })

  it('is symmetric in impact and urgency', () => {
    for (const a of ['1', '2', '3']) for (const b of ['1', '2', '3']) assert.equal(calcPriority(a, b), calcPriority(b, a))
  })

  it('defaults missing impact or urgency to 3 - Low', () => {
    assert.equal(calcPriority(undefined, undefined), '5')
    assert.equal(calcPriority(null, null), '5')
    assert.equal(calcPriority('1', undefined), '3')
    assert.equal(calcPriority(undefined, '1'), '3')
  })

  it('falls back to 5 - Planning for out-of-range values', () => {
    assert.equal(calcPriority('9', '1'), '5')
    assert.equal(calcPriority('', ''), '5')
  })

  it('only produces priorities that exist in the choice list and have an SLA', () => {
    const valid = new Set(PRIORITY.map((p) => p.value))
    for (const p of Object.values(PRIORITY_MATRIX)) {
      assert.ok(valid.has(p))
      assert.ok(SLA_HOURS[p] > 0)
    }
  })
})

describe('getField', () => {
  it('returns the field definition for a known table and field', () => {
    const f = getField('incident', 'caller_id')
    assert.equal(f?.type, 'reference')
    assert.equal(f?.ref, 'sys_user')
    assert.equal(f?.mandatory, true)
  })

  it('returns undefined for unknown tables or fields', () => {
    assert.equal(getField('incident', 'nope'), undefined)
    assert.equal(getField('nope', 'number'), undefined)
  })
})

describe('choiceLabel', () => {
  it('resolves choice values to labels', () => {
    assert.equal(choiceLabel('incident', 'state', '6'), 'Resolved')
    assert.equal(choiceLabel('incident', 'priority', '1'), '1 - Critical')
    assert.equal(choiceLabel('change_request', 'state', '-2'), 'Scheduled')
    assert.equal(choiceLabel('sc_req_item', 'stage', 'waiting_for_approval'), 'Waiting for Approval')
  })

  it('returns an empty string for null, undefined and empty values', () => {
    assert.equal(choiceLabel('incident', 'state', null), '')
    assert.equal(choiceLabel('incident', 'state', undefined), '')
    assert.equal(choiceLabel('incident', 'state', ''), '')
  })

  it('passes through unknown values and non-choice fields unchanged', () => {
    assert.equal(choiceLabel('incident', 'state', '99'), '99')
    assert.equal(choiceLabel('incident', 'short_description', 'Printer down'), 'Printer down')
    assert.equal(choiceLabel('nope', 'state', '1'), '1')
  })

  it('includes subcategories from every category, de-duplicated', () => {
    const subs = getField('incident', 'subcategory')?.choices ?? []
    const values = subs.map((s) => s.value)
    assert.equal(new Set(values).size, values.length)
    assert.ok(values.includes('vpn'))
    assert.ok(values.includes('oracle'))
    assert.equal(values.filter((v) => v === 'email').length, 1)
  })
})

describe('TABLES metadata', () => {
  const tables = Object.values(TABLES)

  it('keys each table by its own name', () => {
    for (const [key, t] of Object.entries(TABLES)) assert.equal(t.name, key)
  })

  it('points every reference field at a defined table', () => {
    for (const t of tables) {
      for (const f of t.fields.filter((x) => x.type === 'reference')) assert.ok(f.ref && TABLES[f.ref], `${t.name}.${f.name} -> ${f.ref}`)
    }
  })

  it('only lists, displays and lays out fields that exist', () => {
    for (const t of tables) {
      const names = new Set(t.fields.map((f) => f.name))
      assert.ok(names.has(t.displayField), `${t.name} displayField ${t.displayField}`)
      for (const f of t.listFields) assert.ok(names.has(f), `${t.name} list field ${f}`)
      for (const s of [...t.form, ...(t.tabs ?? [])]) {
        for (const f of [...s.left, ...s.right, ...(s.full ?? [])]) assert.ok(names.has(f), `${t.name} form field ${f}`)
      }
    }
  })

  it('declares related lists whose field references back to the parent table', () => {
    for (const t of tables) {
      for (const r of t.related ?? []) {
        const f = getField(r.table, r.field)
        assert.equal(f?.ref, t.name, `${t.name} related ${r.table}.${r.field}`)
      }
    }
  })

  it('uses unique number prefixes and a number field on prefixed tables', () => {
    const prefixed = tables.filter((t) => t.prefix)
    assert.equal(new Set(prefixed.map((t) => t.prefix)).size, prefixed.length)
    for (const t of prefixed) assert.ok(getField(t.name, 'number'), `${t.name}.number`)
  })

  it('has unique field names per table and choices on every choice field', () => {
    for (const t of tables) {
      const names = t.fields.map((f) => f.name)
      assert.equal(new Set(names).size, names.length, t.name)
      for (const f of t.fields.filter((x) => x.type === 'choice')) assert.ok(f.choices?.length, `${t.name}.${f.name}`)
    }
  })
})
