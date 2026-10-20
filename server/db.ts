import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { TABLES, choiceLabel, getField, calcPriority } from '../shared/schema.ts'
import type { TableDef } from '../shared/schema.ts'

export type Row = Record<string, string | number | null>
export type Db = DatabaseSync

export class HttpError extends Error {
  status: number
  detail?: string
  constructor(status: number, message: string, detail?: string) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

export const sysId = (): string => randomBytes(16).toString('hex')

export function nowStr(d: Date = new Date()): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

export function openDb(path: string): Db {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  for (const t of Object.values(TABLES)) {
    const cols = t.fields
      .filter((f) => !f.name.startsWith('sys_'))
      .map((f) => `"${f.name}" ${f.type === 'integer' ? 'INTEGER' : f.type === 'currency' ? 'REAL' : 'TEXT'}`)
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${t.name} (sys_id TEXT PRIMARY KEY, ${cols.join(', ')}, ` +
        'sys_created_on TEXT, sys_created_by TEXT, sys_updated_on TEXT, sys_updated_by TEXT, sys_view_count INTEGER DEFAULT 0)',
    )
    const existing = new Set((db.prepare(`PRAGMA table_info(${t.name})`).all() as { name: string }[]).map((c) => c.name))
    for (const col of cols) {
      const name = col.slice(1, col.indexOf('"', 1))
      if (!existing.has(name)) db.exec(`ALTER TABLE ${t.name} ADD COLUMN ${col}`)
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS sys_journal_field (
    sys_id TEXT PRIMARY KEY, name TEXT, element_id TEXT, element TEXT, value TEXT,
    sys_created_by TEXT, sys_created_on TEXT)`)
  db.exec('CREATE INDEX IF NOT EXISTS journal_elem ON sys_journal_field(element_id)')
  db.exec('CREATE TABLE IF NOT EXISTS sys_number (prefix TEXT PRIMARY KEY, next INTEGER)')
  return db
}

export function tableDef(name: string): TableDef {
  const t = TABLES[name]
  if (!t) throw new HttpError(400, `Invalid table ${name}`)
  return t
}

function columns(t: TableDef): Set<string> {
  return new Set(['sys_id', ...t.fields.map((f) => f.name)])
}

export function nextNumber(db: Db, prefix: string): string {
  const row = db.prepare('SELECT next FROM sys_number WHERE prefix = ?').get(prefix) as { next: number } | undefined
  const n = row?.next ?? 10001
  db.prepare('INSERT INTO sys_number (prefix, next) VALUES (?, ?) ON CONFLICT(prefix) DO UPDATE SET next = excluded.next').run(prefix, n + 1)
  return `${prefix}${String(n).padStart(7, '0')}`
}

export interface QueryCtx {
  userId?: string
}

const OPS = ['ISNOTEMPTY', 'ISEMPTY', 'NOTLIKE', 'LIKE', 'STARTSWITH', 'NOTIN', 'IN', '!=', '>=', '<=', '=', '>', '<'] as const

function resolveValue(v: string, ctx: QueryCtx): string {
  if (v === 'javascript:gs.getUserID()') return ctx.userId ?? ''
  const m = /^javascript:gs\.daysAgo\((\d+)\)$/.exec(v)
  if (m) return nowStr(new Date(Date.now() - Number(m[1]) * 86400000))
  return v
}

/** Translate a ServiceNow-style encoded query (e.g. `active=true^priority=1^ORDERBYDESCnumber`) to SQL. */
export function parseEncodedQuery(t: TableDef, query: string | undefined, ctx: QueryCtx) {
  const cols = columns(t)
  const groups: { sql: string; params: string[] }[][] = []
  const order: string[] = []
  for (const raw of (query ?? '').split('^')) {
    if (!raw) continue
    if (raw.startsWith('ORDERBYDESC') || raw.startsWith('ORDERBY')) {
      const desc = raw.startsWith('ORDERBYDESC')
      const f = raw.slice(desc ? 11 : 7)
      if (cols.has(f)) order.push(`"${f}" ${desc ? 'DESC' : 'ASC'}`)
      continue
    }
    const isOr = raw.startsWith('OR') && groups.length > 0
    const part = isOr ? raw.slice(2) : raw
    const m = /^([a-z_][a-z0-9_]*)(.*)$/.exec(part)
    if (!m || !cols.has(m[1])) continue
    const [, field, rest] = m
    const op = OPS.find((o) => rest.startsWith(o))
    if (!op) continue
    const value = resolveValue(rest.slice(op.length), ctx)
    const col = `"${field}"`
    let cond: { sql: string; params: string[] }
    switch (op) {
      case 'ISEMPTY':
        cond = { sql: `(${col} IS NULL OR ${col} = '')`, params: [] }
        break
      case 'ISNOTEMPTY':
        cond = { sql: `(${col} IS NOT NULL AND ${col} != '')`, params: [] }
        break
      case 'LIKE':
        cond = { sql: `${col} LIKE ?`, params: [`%${value}%`] }
        break
      case 'NOTLIKE':
        cond = { sql: `(${col} IS NULL OR ${col} NOT LIKE ?)`, params: [`%${value}%`] }
        break
      case 'STARTSWITH':
        cond = { sql: `${col} LIKE ?`, params: [`${value}%`] }
        break
      case 'IN':
      case 'NOTIN': {
        const vals = value.split(',')
        const ph = vals.map(() => '?').join(',')
        cond = op === 'IN' ? { sql: `${col} IN (${ph})`, params: vals } : { sql: `(${col} IS NULL OR ${col} NOT IN (${ph}))`, params: vals }
        break
      }
      case '!=':
        cond = { sql: `(${col} IS NULL OR ${col} != ?)`, params: [value] }
        break
      default: {
        const def = getField(t.name, field)
        const numeric = def?.type === 'integer' || def?.type === 'currency'
        cond = { sql: numeric ? `CAST(${col} AS REAL) ${op} CAST(? AS REAL)` : `${col} ${op} ?`, params: [value] }
      }
    }
    if (isOr) groups[groups.length - 1].push(cond)
    else groups.push([cond])
  }
  const where = groups.map((g) => (g.length === 1 ? g[0].sql : `(${g.map((c) => c.sql).join(' OR ')})`))
  const params = groups.flat().flatMap((c) => c.params)
  return { where, params, order }
}

export interface ListOpts {
  query?: string
  text?: string
  limit?: number
  offset?: number
  ctx: QueryCtx
}

export function listRecords(db: Db, table: string, opts: ListOpts) {
  const t = tableDef(table)
  const q = parseEncodedQuery(t, opts.query, opts.ctx)
  if (!q.order.length && t.defaultSort) q.order.push(...parseEncodedQuery(t, t.defaultSort, opts.ctx).order)
  if (opts.text) {
    const textCols = t.fields.filter((f) => f.type === 'string' || f.type === 'text').map((f) => `"${f.name}" LIKE ?`)
    q.where.push(`(${textCols.join(' OR ')})`)
    q.params.push(...textCols.map(() => `%${opts.text}%`))
  }
  const whereSql = q.where.length ? `WHERE ${q.where.join(' AND ')}` : ''
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${t.name} ${whereSql}`).get(...q.params) as { n: number }).n
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 1000)
  const offset = Math.max(opts.offset ?? 0, 0)
  const orderSql = q.order.length ? `ORDER BY ${q.order.join(', ')}` : ''
  const rows = db.prepare(`SELECT * FROM ${t.name} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`).all(...q.params, limit, offset) as Row[]
  return { result: withDisplay(db, t, rows), total }
}

export function groupCounts(db: Db, table: string, groupBy: string, query: string | undefined, ctx: QueryCtx) {
  const t = tableDef(table)
  if (!columns(t).has(groupBy)) throw new HttpError(400, `Invalid group by field ${groupBy}`)
  const q = parseEncodedQuery(t, query, ctx)
  const whereSql = q.where.length ? `WHERE ${q.where.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT "${groupBy}" AS value, COUNT(*) AS count FROM ${t.name} ${whereSql} GROUP BY "${groupBy}" ORDER BY count DESC`).all(...q.params) as { value: string | null; count: number }[]
  const def = getField(table, groupBy)
  let labels: Record<string, string> = {}
  if (def?.type === 'reference' && def.ref) {
    labels = refDisplay(db, def.ref, rows.map((r) => String(r.value ?? '')))
  }
  return rows.map((r) => ({
    value: r.value ?? '',
    label: r.value == null || r.value === '' ? '(empty)' : (labels[String(r.value)] ?? choiceLabel(table, groupBy, String(r.value))),
    count: r.count,
  }))
}

function refDisplay(db: Db, refTable: string, ids: string[]): Record<string, string> {
  const uniq = [...new Set(ids.filter(Boolean))]
  if (!uniq.length) return {}
  const rt = tableDef(refTable)
  const rows = db.prepare(`SELECT sys_id, "${rt.displayField}" AS dv FROM ${rt.name} WHERE sys_id IN (${uniq.map(() => '?').join(',')})`).all(...uniq) as { sys_id: string; dv: string }[]
  return Object.fromEntries(rows.map((r) => [r.sys_id, r.dv]))
}

function withDisplay(db: Db, t: TableDef, rows: Row[]): Row[] {
  const out = rows.map((r) => ({ ...r, _dv: {} as Record<string, string> })) as (Row & { _dv: Record<string, string> })[]
  for (const f of t.fields) {
    if (f.type !== 'reference' || !f.ref) continue
    const map = refDisplay(db, f.ref, rows.map((r) => String(r[f.name] ?? '')))
    for (const r of out) {
      const v = r[f.name]
      if (v) r._dv[f.name] = map[String(v)] ?? ''
    }
  }
  return out as unknown as Row[]
}

export function getRecord(db: Db, table: string, id: string): Row {
  const t = tableDef(table)
  const row = db.prepare(`SELECT * FROM ${t.name} WHERE sys_id = ?`).get(id) as Row | undefined
  if (!row) throw new HttpError(404, 'No Record found', `Record ${id} does not exist in ${table}`)
  return withDisplay(db, t, [row])[0]
}

function displayOf(db: Db, table: string, field: string, value: unknown): string {
  if (value == null || value === '') return ''
  const def = getField(table, field)
  if (def?.type === 'reference' && def.ref) return refDisplay(db, def.ref, [String(value)])[String(value)] ?? String(value)
  if (def?.type === 'boolean') return value === 'true' ? 'true' : 'false'
  return choiceLabel(table, field, String(value))
}

function clean(t: TableDef, body: Record<string, unknown>): Row {
  const out: Row = {}
  for (const f of t.fields) {
    if (!(f.name in body) || f.name.startsWith('sys_')) continue
    const v = body[f.name]
    if (v == null || v === '') out[f.name] = null
    else if (f.type === 'integer') out[f.name] = Math.trunc(Number(v)) || 0
    else if (f.type === 'currency') out[f.name] = Number(v) || 0
    else if (f.type === 'boolean') out[f.name] = v === true || v === 'true' ? 'true' : 'false'
    else out[f.name] = String(v)
  }
  return out
}

interface Actor {
  sys_id: string
  user_name: string
  name: string
}

function applyBusinessRules(table: string, rec: Row, prev: Row | null): void {
  const merged = { ...(prev ?? {}), ...rec }
  if (table === 'incident' || table === 'problem') {
    if (!prev) {
      rec.impact ??= '3'
      rec.urgency ??= '3'
      merged.impact = rec.impact
      merged.urgency = rec.urgency
    }
    if (!prev || 'impact' in rec || 'urgency' in rec) rec.priority = calcPriority(merged.impact as string, merged.urgency as string)
  }
  if (table === 'incident') {
    if (!prev) {
      rec.state ??= '1'
      rec.contact_type ??= 'phone'
      rec.opened_at = nowStr()
      if (rec.assigned_to && rec.state === '1') rec.state = '2'
    } else {
      if (rec.assigned_to && !prev.assigned_to && merged.state === '1' && !('state' in rec && rec.state !== '1')) rec.state = '2'
      if (rec.state === '6' && prev.state !== '6') {
        if (!merged.close_code || !merged.close_notes) {
          throw new HttpError(400, 'Mandatory fields missing', 'Resolution code and Resolution notes are required to resolve an incident')
        }
        rec.resolved_at = nowStr()
      }
      if (rec.state && !['6', '7'].includes(String(rec.state)) && ['6', '7'].includes(String(prev.state))) rec.resolved_at = null
    }
  }
  if (table === 'problem' && !prev) rec.state ??= '101'
  if (table === 'change_request') {
    if (!prev) {
      rec.state ??= '-5'
      rec.type ??= 'normal'
      rec.risk ??= '3'
      rec.impact ??= '3'
      rec.approval = rec.type === 'standard' ? 'approved' : 'not requested'
    } else if (rec.state === '-3' && prev.state !== '-3' && prev.approval !== 'approved') {
      rec.approval = 'requested'
    }
  }
  if (table === 'kb_knowledge' && !prev) {
    rec.workflow_state ??= 'draft'
    rec.sys_view_count = 0
    rec.rating = 0
  }
  if (table === 'sys_user' && !prev) {
    rec.active ??= 'true'
    rec.role ??= 'user'
  }
}

export function insertRecord(db: Db, table: string, body: Record<string, unknown>, actor: Actor | null, opts: { skipRules?: boolean } = {}): Row {
  const t = tableDef(table)
  const rec = clean(t, body)
  for (const f of t.fields) {
    if (f.mandatory && (rec[f.name] == null || rec[f.name] === '')) {
      throw new HttpError(400, 'Mandatory fields missing', `${f.label} is mandatory`)
    }
  }
  if (!opts.skipRules) applyBusinessRules(table, rec, null)
  if (t.prefix && !rec.number) rec.number = nextNumber(db, t.prefix)
  const now = typeof body.sys_created_on === 'string' ? body.sys_created_on : nowStr()
  const id = typeof body.sys_id === 'string' ? body.sys_id : sysId()
  const by = actor?.user_name ?? 'system'
  const full: Row = { ...rec, sys_id: id, sys_created_on: now, sys_updated_on: (body.sys_updated_on as string) ?? now, sys_created_by: by, sys_updated_by: by }
  if (table === 'incident' && typeof body.opened_at === 'string') full.opened_at = body.opened_at
  if (table === 'incident' && typeof body.resolved_at === 'string') full.resolved_at = body.resolved_at
  const keys = Object.keys(full)
  db.prepare(`INSERT INTO ${t.name} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => full[k]))
  return getRecord(db, table, id)
}

export function updateRecord(db: Db, table: string, id: string, body: Record<string, unknown>, actor: Actor | null): Row {
  const t = tableDef(table)
  const prev = db.prepare(`SELECT * FROM ${t.name} WHERE sys_id = ?`).get(id) as Row | undefined
  if (!prev) throw new HttpError(404, 'No Record found', `Record ${id} does not exist in ${table}`)
  const rec = clean(t, body)
  for (const f of t.fields) {
    if (f.mandatory && f.name in rec && (rec[f.name] == null || rec[f.name] === '')) {
      throw new HttpError(400, 'Mandatory fields missing', `${f.label} is mandatory`)
    }
  }
  applyBusinessRules(table, rec, prev)
  const changes = Object.keys(rec).filter((k) => String(rec[k] ?? '') !== String(prev[k] ?? ''))
  if (changes.length) {
    const now = nowStr()
    const sets = [...changes.map((k) => `"${k}" = ?`), 'sys_updated_on = ?', 'sys_updated_by = ?']
    db.prepare(`UPDATE ${t.name} SET ${sets.join(', ')} WHERE sys_id = ?`).run(...changes.map((k) => rec[k]), now, actor?.user_name ?? 'system', id)
    if (t.journal) {
      const diff = changes
        .filter((k) => !['resolved_at', 'opened_at'].includes(k))
        .map((k) => ({
          field: k,
          label: getField(table, k)?.label ?? k,
          old: displayOf(db, table, k, prev[k]),
          new: displayOf(db, table, k, rec[k]),
        }))
      if (diff.length) addJournal(db, table, id, 'audit', JSON.stringify(diff), actor)
    }
  }
  return getRecord(db, table, id)
}

export function deleteRecord(db: Db, table: string, id: string): void {
  const t = tableDef(table)
  const res = db.prepare(`DELETE FROM ${t.name} WHERE sys_id = ?`).run(id)
  if (!res.changes) throw new HttpError(404, 'No Record found', `Record ${id} does not exist in ${table}`)
  db.prepare('DELETE FROM sys_journal_field WHERE element_id = ?').run(id)
}

export function addJournal(db: Db, table: string, id: string, element: string, value: string, actor: Actor | null, createdOn?: string) {
  const row = {
    sys_id: sysId(),
    name: table,
    element_id: id,
    element,
    value,
    sys_created_by: actor?.name ?? 'System Administrator',
    sys_created_on: createdOn ?? nowStr(),
  }
  db.prepare('INSERT INTO sys_journal_field (sys_id, name, element_id, element, value, sys_created_by, sys_created_on) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    row.sys_id,
    row.name,
    row.element_id,
    row.element,
    row.value,
    row.sys_created_by,
    row.sys_created_on,
  )
  return row
}

export function listJournal(db: Db, id: string) {
  return db.prepare('SELECT * FROM sys_journal_field WHERE element_id = ? ORDER BY sys_created_on DESC, rowid DESC').all(id)
}
