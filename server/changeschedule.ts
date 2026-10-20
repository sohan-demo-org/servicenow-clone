import { HttpError, getRecord, nowStr } from './db.ts'
import type { Db, Row } from './db.ts'

export type ConflictType = 'ci_already_scheduled' | 'assignee_already_scheduled' | 'blackout' | 'invalid_window'

export interface Conflict {
  type: ConflictType
  label: string
  message: string
  related?: { table: string; sys_id: string; display: string; start_date: string; end_date: string }
}

export interface Slot {
  sys_id?: string
  cmdb_ci?: string | null
  assigned_to?: string | null
  start_date?: string | null
  end_date?: string | null
}

const INACTIVE_STATES = ['3', '4']
const LABELS: Record<ConflictType, string> = {
  ci_already_scheduled: 'Configuration Item Already Scheduled',
  assignee_already_scheduled: 'Assigned To Already Scheduled',
  blackout: 'Blackout Window',
  invalid_window: 'Invalid Planned Window',
}

const toMs = (v: string | null | undefined): number => (v ? Date.parse(`${v.replace(' ', 'T')}Z`) : NaN)
const fromMs = (ms: number): string => nowStr(new Date(ms))

function activeChanges(db: Db): Row[] {
  return db
    .prepare(
      `SELECT c.sys_id, c.number, c.short_description, c.cmdb_ci, c.assigned_to, c.start_date, c.end_date, c.state,
              ci.name AS ci_name, u.name AS assignee_name
       FROM change_request c LEFT JOIN cmdb_ci ci ON ci.sys_id = c.cmdb_ci LEFT JOIN sys_user u ON u.sys_id = c.assigned_to
       WHERE c.state NOT IN (${INACTIVE_STATES.map(() => '?').join(',')}) AND c.start_date IS NOT NULL AND c.end_date IS NOT NULL`,
    )
    .all(...INACTIVE_STATES) as Row[]
}

function activeBlackouts(db: Db): Row[] {
  return db
    .prepare(
      `SELECT b.sys_id, b.name, b.cmdb_ci, b.start_date, b.end_date, ci.name AS ci_name
       FROM cmn_schedule_blackout b LEFT JOIN cmdb_ci ci ON ci.sys_id = b.cmdb_ci
       WHERE b.active = 'true' AND b.start_date IS NOT NULL AND b.end_date IS NOT NULL`,
    )
    .all() as Row[]
}

interface Ctx {
  changes: Row[]
  blackouts: Row[]
}

function conflictsWith(slot: Slot, ctx: Ctx): Conflict[] {
  const start = toMs(slot.start_date)
  const end = toMs(slot.end_date)
  if (Number.isNaN(start) || Number.isNaN(end)) return []
  if (end <= start) return [{ type: 'invalid_window', label: LABELS.invalid_window, message: 'Planned end date must be after the planned start date' }]
  const overlaps = (r: Row) => toMs(String(r.start_date)) < end && start < toMs(String(r.end_date))
  const out: Conflict[] = []
  for (const c of ctx.changes) {
    if (c.sys_id === slot.sys_id || !overlaps(c)) continue
    const related = { table: 'change_request', sys_id: String(c.sys_id), display: String(c.number), start_date: String(c.start_date), end_date: String(c.end_date) }
    if (slot.cmdb_ci && c.cmdb_ci === slot.cmdb_ci)
      out.push({ type: 'ci_already_scheduled', label: LABELS.ci_already_scheduled, message: `${c.ci_name} is already scheduled for ${c.number}: ${c.short_description}`, related })
    if (slot.assigned_to && c.assigned_to === slot.assigned_to)
      out.push({ type: 'assignee_already_scheduled', label: LABELS.assignee_already_scheduled, message: `${c.assignee_name} is already implementing ${c.number} in this window`, related })
  }
  for (const b of ctx.blackouts) {
    if (!overlaps(b) || (b.cmdb_ci && b.cmdb_ci !== slot.cmdb_ci)) continue
    out.push({
      type: 'blackout',
      label: LABELS.blackout,
      message: `Overlaps blackout "${b.name}"${b.ci_name ? ` for ${b.ci_name}` : ' (all CIs)'}`,
      related: { table: 'cmn_schedule_blackout', sys_id: String(b.sys_id), display: String(b.name), start_date: String(b.start_date), end_date: String(b.end_date) },
    })
  }
  return out
}

const loadCtx = (db: Db): Ctx => ({ changes: activeChanges(db), blackouts: activeBlackouts(db) })

export function findConflicts(db: Db, slot: Slot): Conflict[] {
  return conflictsWith(slot, loadCtx(db))
}

/** Recompute conflict_status on every change request (cheap at demo scale; keeps both sides of a collision in sync). */
export function refreshConflictStatus(db: Db): void {
  const ctx = loadCtx(db)
  const active = new Map(ctx.changes.map((c) => [String(c.sys_id), c]))
  const now = nowStr()
  const set = db.prepare('UPDATE change_request SET conflict_status = ?, conflict_last_run = ? WHERE sys_id = ?')
  const all = db.prepare('SELECT sys_id, state, cmdb_ci, assigned_to, start_date, end_date FROM change_request').all() as Row[]
  for (const r of all) {
    const id = String(r.sys_id)
    if (INACTIVE_STATES.includes(String(r.state))) set.run('none', now, id)
    else if (!active.has(id)) set.run('not_run', now, id)
    else set.run(conflictsWith(r as Slot, ctx).length ? 'conflict' : 'none', now, id)
  }
}

/** Earliest conflict-free window of the same duration, starting at `after` (default: now, rounded up to the next half hour). */
export function nextWindow(db: Db, id: string, after?: string): { start_date: string; end_date: string } {
  const rec = getRecord(db, 'change_request', id)
  const start = toMs(rec.start_date as string)
  const end = toMs(rec.end_date as string)
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) throw new HttpError(400, 'Change has no valid planned window')
  const dur = end - start
  const HALF_HOUR = 30 * 60000
  let t = after ? toMs(after) : Math.ceil(Date.now() / HALF_HOUR) * HALF_HOUR
  if (Number.isNaN(t)) throw new HttpError(400, 'Invalid "after" date')
  const ctx = loadCtx(db)
  const slot: Slot = { sys_id: id, cmdb_ci: rec.cmdb_ci as string | null, assigned_to: rec.assigned_to as string | null }
  for (let i = 0; i < 1000; i++) {
    const found = conflictsWith({ ...slot, start_date: fromMs(t), end_date: fromMs(t + dur) }, ctx)
    if (!found.length) return { start_date: fromMs(t), end_date: fromMs(t + dur) }
    t = Math.max(t + HALF_HOUR, Math.min(...found.map((c) => toMs(c.related?.end_date))))
  }
  throw new HttpError(409, 'No conflict-free window found')
}

export function schedule(db: Db, from: string, to: string) {
  const changes = db
    .prepare('SELECT sys_id FROM change_request WHERE start_date IS NOT NULL AND end_date IS NOT NULL AND start_date < ? AND end_date > ? ORDER BY start_date')
    .all(to, from) as { sys_id: string }[]
  const blackouts = db
    .prepare("SELECT sys_id FROM cmn_schedule_blackout WHERE active = 'true' AND start_date < ? AND end_date > ? ORDER BY start_date")
    .all(to, from) as { sys_id: string }[]
  const ctx = loadCtx(db)
  const recs = changes.map((c) => getRecord(db, 'change_request', c.sys_id))
  const conflicts: Record<string, Conflict[]> = {}
  for (const r of recs) if (!INACTIVE_STATES.includes(String(r.state))) conflicts[String(r.sys_id)] = conflictsWith(r as Slot, ctx)
  return { changes: recs, blackouts: blackouts.map((b) => getRecord(db, 'cmn_schedule_blackout', b.sys_id)), conflicts }
}
