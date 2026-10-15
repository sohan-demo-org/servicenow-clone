import { TABLES, getField } from '../shared/schema.ts'
import type { Rec } from './api.ts'

export interface Condition {
  field: string
  op: string
  value: string
  or?: boolean
}

export const OPERATORS: { op: string; label: string; noValue?: boolean }[] = [
  { op: '=', label: 'is' },
  { op: '!=', label: 'is not' },
  { op: 'LIKE', label: 'contains' },
  { op: 'NOTLIKE', label: 'does not contain' },
  { op: 'STARTSWITH', label: 'starts with' },
  { op: 'IN', label: 'is one of' },
  { op: 'NOTIN', label: 'is not one of' },
  { op: 'ISEMPTY', label: 'is empty', noValue: true },
  { op: 'ISNOTEMPTY', label: 'is not empty', noValue: true },
  { op: '>', label: 'greater than' },
  { op: '<', label: 'less than' },
]

const OP_ORDER = ['ISNOTEMPTY', 'ISEMPTY', 'NOTLIKE', 'LIKE', 'STARTSWITH', 'NOTIN', 'IN', '!=', '>=', '<=', '=', '>', '<']

export function parseQuery(q: string): { conditions: Condition[]; order: string[] } {
  const conditions: Condition[] = []
  const order: string[] = []
  for (const raw of q.split('^')) {
    if (!raw) continue
    if (raw.startsWith('ORDERBY')) {
      order.push(raw)
      continue
    }
    const or = raw.startsWith('OR') && conditions.length > 0
    const part = or ? raw.slice(2) : raw
    const m = /^([a-z_][a-z0-9_]*)(.*)$/.exec(part)
    if (!m) continue
    const op = OP_ORDER.find((o) => m[2].startsWith(o))
    if (!op) continue
    conditions.push({ field: m[1], op, value: m[2].slice(op.length), or })
  }
  return { conditions, order }
}

export function buildQuery(conditions: Condition[], order: string[] = []): string {
  return [...conditions.map((c) => `${c.or ? 'OR' : ''}${c.field}${c.op}${OPERATORS.find((o) => o.op === c.op)?.noValue ? '' : c.value}`), ...order].join('^')
}

export function describeCondition(table: string, c: Condition, refNames: Record<string, string> = {}): string {
  const def = getField(table, c.field)
  const label = def?.label ?? c.field
  const op = OPERATORS.find((o) => o.op === c.op)?.label ?? c.op
  if (OPERATORS.find((o) => o.op === c.op)?.noValue) return `${label} ${op}`
  let value = c.value
  if (value === 'javascript:gs.getUserID()') value = '(me)'
  else if (def?.type === 'choice')
    value = value
      .split(',')
      .map((v) => def.choices?.find((ch) => ch.value === v)?.label ?? v)
      .join(', ')
  else if (def?.type === 'reference') value = refNames[value] ?? value
  const sym = c.op === '=' ? '=' : c.op === '!=' ? '!=' : op
  return `${c.or ? 'or ' : ''}${label} ${sym} ${value}`
}

export function refNamesFromRows(rows: Rec[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) for (const [k, v] of Object.entries(r._dv ?? {})) if (r[k]) out[String(r[k])] = v
  return out
}

export function tableFields(table: string) {
  return TABLES[table]?.fields ?? []
}
