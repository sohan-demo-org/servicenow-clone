import { HttpError, addJournal, getRecord, insertRecord, nowStr, updateRecord } from './db.ts'
import type { Db, Row } from './db.ts'
import type { OnCallNow, OnCallOverride, OnCallPerson, OnCallRota, OnCallSchedule, OnCallSegment, OnCallShift } from '../shared/oncall.ts'

const DAY = 86400000

export interface RotaDef {
  rotation_type: string
  handoff_time: string
  timezone: string
  start_date: string
}

export interface RotaMember {
  sys_id: string
  name: string
  order: number
}

export interface RotaOverride {
  sys_id: string
  member: string
  name: string
  start: number
  end: number
  reason: string
  created: string
}

/** `YYYY-MM-DD HH:MM:SS` (UTC) <-> epoch ms */
export const parseUtc = (s: string): number => Date.parse(`${s.replace(' ', 'T')}Z`)
const fmt = (t: number): string => nowStr(new Date(t))

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function zoneParts(t: number, tz: string) {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    fmtCache.set(tz, f)
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]))
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute) }
}

/** Epoch ms of a wall-clock time in a time zone. */
export function zonedTime(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const want = Date.UTC(y, m - 1, d, h, mi)
  let guess = want
  for (let i = 0; i < 3; i++) {
    const p = zoneParts(guess, tz)
    const diff = want - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi)
    if (!diff) break
    guess += diff
  }
  return guess
}

function handoff(rota: RotaDef): [number, number] {
  const m = /^(\d{1,2}):(\d{2})/.exec(rota.handoff_time ?? '')
  return m ? [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))] : [9, 0]
}

const shiftDays = (rota: RotaDef) => (rota.rotation_type === 'weekly' ? 7 : 1)
const tzOf = (rota: RotaDef) => rota.timezone || 'UTC'

function anchorDay(rota: RotaDef): number {
  const p = zoneParts(parseUtc(rota.start_date), tzOf(rota))
  return Date.UTC(p.y, p.m - 1, p.d) / DAY
}

/** Index of the rotation shift (0 = the one that starts on the rota start date at handoff time) covering `t`. */
export function shiftIndexAt(rota: RotaDef, t: number): number {
  const p = zoneParts(t, tzOf(rota))
  const [hh, mm] = handoff(rota)
  let days = Date.UTC(p.y, p.m - 1, p.d) / DAY - anchorDay(rota)
  if (p.h * 60 + p.mi < hh * 60 + mm) days -= 1
  return Math.floor(days / shiftDays(rota))
}

export function shiftStart(rota: RotaDef, k: number): number {
  const day = new Date((anchorDay(rota) + k * shiftDays(rota)) * DAY)
  const [hh, mm] = handoff(rota)
  return zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tzOf(rota))
}

const memberAt = (members: RotaMember[], k: number) => members[((k % members.length) + members.length) % members.length]

/** The override that wins at `t`: the most recently created one covering it. */
export function overrideAt(overrides: RotaOverride[], t: number): RotaOverride | null {
  let win: RotaOverride | null = null
  for (const o of overrides) if (o.start <= t && t < o.end && (!win || o.created >= win.created)) win = o
  return win
}

export interface OnCallResult {
  primary: OnCallPerson
  secondary: OnCallPerson | null
  scheduled: OnCallPerson
  override: RotaOverride | null
  shiftStart: number
  shiftEnd: number
}

export function onCallAt(rota: RotaDef, members: RotaMember[], overrides: RotaOverride[], t: number): OnCallResult | null {
  if (!members.length) return null
  const sorted = [...members].sort((a, b) => a.order - b.order)
  const k = shiftIndexAt(rota, t)
  const scheduled = memberAt(sorted, k)
  const ov = overrideAt(overrides, t)
  const primary = ov ? { sys_id: ov.member, name: ov.name } : { sys_id: scheduled.sys_id, name: scheduled.name }
  let secondary: OnCallPerson | null = null
  for (let i = 1; i <= sorted.length; i++) {
    const m = memberAt(sorted, k + i)
    if (m.sys_id !== primary.sys_id) {
      secondary = { sys_id: m.sys_id, name: m.name }
      break
    }
  }
  const seg = segmentsBetween(rota, sorted, overrides, t, t + 15 * DAY).find((s) => s.startMs <= t && t < s.endMs)
  return {
    primary,
    secondary,
    scheduled: { sys_id: scheduled.sys_id, name: scheduled.name },
    override: ov,
    shiftStart: seg?.startMs ?? shiftStart(rota, k),
    shiftEnd: seg?.endMs ?? shiftStart(rota, k + 1),
  }
}

export function shiftsBetween(rota: RotaDef, members: RotaMember[], from: number, to: number) {
  const sorted = [...members].sort((a, b) => a.order - b.order)
  const out: { startMs: number; endMs: number; member: RotaMember }[] = []
  if (!sorted.length) return out
  for (let k = shiftIndexAt(rota, from); ; k++) {
    const s = shiftStart(rota, k)
    if (s >= to) break
    out.push({ startMs: s, endMs: shiftStart(rota, k + 1), member: memberAt(sorted, k) })
  }
  return out
}

/** Effective on-call coverage: rotation shifts split wherever an override starts or ends; consecutive equal pieces merged. */
export function segmentsBetween(rota: RotaDef, members: RotaMember[], overrides: RotaOverride[], from: number, to: number) {
  const shifts = shiftsBetween(rota, members, from, to)
  const cuts = new Set<number>()
  for (const s of shifts) cuts.add(s.startMs).add(s.endMs)
  for (const o of overrides) cuts.add(o.start).add(o.end)
  const points = [...cuts].sort((a, b) => a - b)
  const out: { startMs: number; endMs: number; member: string; name: string; override: RotaOverride | null }[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const shift = shifts.find((s) => s.startMs <= a && a < s.endMs)
    if (!shift) continue
    const ov = overrideAt(overrides, a)
    const member = ov ? ov.member : shift.member.sys_id
    const name = ov ? ov.name : shift.member.name
    const last = out[out.length - 1]
    if (last && last.endMs === a && last.member === member && (last.override?.sys_id ?? null) === (ov?.sys_id ?? null)) last.endMs = b
    else out.push({ startMs: a, endMs: b, member, name, override: ov })
  }
  return out
}

// ---- DB access ----

const person = (id: unknown, name: unknown): OnCallPerson => ({ sys_id: String(id ?? ''), name: String(name ?? '') })

interface LoadedRota {
  row: Row
  group: Row
  members: RotaMember[]
  overrides: RotaOverride[]
}

function loadRota(db: Db, rota: Row): LoadedRota {
  const group = db.prepare('SELECT * FROM sys_user_group WHERE sys_id = ?').get(rota.group) as Row
  const members = (
    db
      .prepare('SELECT m.member AS sys_id, u.name AS name, m."order" AS ord FROM cmn_rota_member m JOIN sys_user u ON u.sys_id = m.member WHERE m.rota = ? ORDER BY m."order", u.name')
      .all(rota.sys_id) as { sys_id: string; name: string; ord: number | null }[]
  ).map((m) => ({ sys_id: m.sys_id, name: m.name, order: Number(m.ord ?? 0) }))
  const overrides = (
    db
      .prepare('SELECT o.sys_id, o.member, u.name AS name, o.start_date, o.end_date, o.reason, o.sys_created_on, o.rowid AS rid FROM cmn_rota_override o JOIN sys_user u ON u.sys_id = o.member WHERE o.rota = ?')
      .all(rota.sys_id) as Row[]
  )
    .map((o) => ({
      sys_id: String(o.sys_id),
      member: String(o.member),
      name: String(o.name),
      start: parseUtc(String(o.start_date ?? '')),
      end: parseUtc(String(o.end_date ?? '')),
      reason: String(o.reason ?? ''),
      created: `${o.sys_created_on ?? ''}#${String(o.rid).padStart(10, '0')}`,
    }))
    .filter((o) => o.end > o.start)
  return { row: rota, group, members, overrides }
}

function activeRotaForGroup(db: Db, groupId: string): Row | undefined {
  return db.prepare(`SELECT * FROM cmn_rota WHERE "group" = ? AND active = 'true' ORDER BY name LIMIT 1`).get(groupId) as Row | undefined
}

const rotaInfo = (r: Row): OnCallRota => ({
  sys_id: String(r.sys_id),
  name: String(r.name ?? ''),
  rotation_type: String(r.rotation_type ?? 'weekly'),
  handoff_time: String(r.handoff_time ?? '09:00'),
  timezone: String(r.timezone ?? 'UTC'),
})

const rotaDef = (r: Row): RotaDef => ({
  rotation_type: String(r.rotation_type ?? 'weekly'),
  handoff_time: String(r.handoff_time ?? '09:00'),
  timezone: String(r.timezone || 'UTC'),
  start_date: String(r.start_date ?? nowStr()),
})

const overrideOut = (o: RotaOverride): OnCallOverride => ({ sys_id: o.sys_id, member: o.member, name: o.name, start: fmt(o.start), end: fmt(o.end), reason: o.reason })

function nowFor(db: Db, l: LoadedRota, t: number): OnCallNow | null {
  const r = onCallAt(rotaDef(l.row), l.members, l.overrides, t)
  if (!r) return null
  const mgr = l.group.manager ? (db.prepare('SELECT sys_id, name FROM sys_user WHERE sys_id = ?').get(l.group.manager) as Row | undefined) : undefined
  const manager = mgr ? person(mgr.sys_id, mgr.name) : null
  const escalation = [{ ...r.primary, level: 'Primary' }]
  if (r.secondary) escalation.push({ ...r.secondary, level: 'Secondary' })
  if (manager) escalation.push({ ...manager, level: 'Group manager' })
  return {
    group: person(l.group.sys_id, l.group.name),
    rota: rotaInfo(l.row),
    primary: r.primary,
    secondary: r.secondary,
    manager,
    scheduled: r.scheduled,
    override: r.override ? overrideOut(r.override) : null,
    shift_start: fmt(r.shiftStart),
    shift_end: fmt(r.shiftEnd),
    escalation,
  }
}

export function currentOnCall(db: Db, t = Date.now()): OnCallNow[] {
  const rotas = db.prepare(`SELECT r.* FROM cmn_rota r JOIN sys_user_group g ON g.sys_id = r."group" WHERE r.active = 'true' ORDER BY g.name, r.name`).all() as Row[]
  const seen = new Set<string>()
  const out: OnCallNow[] = []
  for (const r of rotas) {
    if (seen.has(String(r.group))) continue
    seen.add(String(r.group))
    const n = nowFor(db, loadRota(db, r), t)
    if (n) out.push(n)
  }
  return out
}

export function onCallForGroup(db: Db, groupId: string, t = Date.now()): OnCallNow | null {
  const r = activeRotaForGroup(db, groupId)
  return r ? nowFor(db, loadRota(db, r), t) : null
}

export function groupSchedule(db: Db, groupId: string, opts: { from?: number; days?: number } = {}): OnCallSchedule {
  const r = activeRotaForGroup(db, groupId)
  if (!r) throw new HttpError(404, 'No active on-call rota', `Group ${groupId} has no active rota`)
  const l = loadRota(db, r)
  const def = rotaDef(r)
  const days = Math.min(Math.max(Math.round(opts.days ?? 14), 1), 60)
  const from = opts.from ?? Date.now()
  const to = from + days * DAY
  const current = nowFor(db, l, Date.now())
  if (!current) throw new HttpError(404, 'Rota has no members', `${String(r.name)} has no members`)
  const shifts: OnCallShift[] = shiftsBetween(def, l.members, from, to).map((s) => ({ start: fmt(s.startMs), end: fmt(s.endMs), member: s.member.sys_id, name: s.member.name }))
  const segments: OnCallSegment[] = segmentsBetween(def, l.members, l.overrides, from, to).map((s) => ({
    start: fmt(s.startMs),
    end: fmt(s.endMs),
    member: s.member,
    name: s.name,
    override: s.override ? overrideOut(s.override) : null,
  }))
  return {
    group: person(l.group.sys_id, l.group.name),
    rota: rotaInfo(r),
    members: l.members.map((m) => ({ sys_id: m.sys_id, name: m.name, order: m.order })),
    from: fmt(from),
    to: fmt(to),
    shifts,
    overrides: l.overrides.filter((o) => o.end > from && o.start < to).sort((a, b) => a.start - b.start).map(overrideOut),
    segments,
    current,
  }
}

interface Actor {
  sys_id: string
  user_name: string
  name: string
}

export function createOverride(db: Db, groupId: string, body: Record<string, unknown>, actor: Actor | null): Row {
  const r = activeRotaForGroup(db, groupId)
  if (!r) throw new HttpError(404, 'No active on-call rota', `Group ${groupId} has no active rota`)
  const member = String(body.member ?? '')
  const start = String(body.start ?? '')
  const end = String(body.end ?? '')
  if (!member || !start || !end) throw new HttpError(400, 'Mandatory fields missing', 'Member, start and end are required')
  getRecord(db, 'sys_user', member)
  const s = parseUtc(start)
  const e = parseUtc(end)
  if (Number.isNaN(s) || Number.isNaN(e)) throw new HttpError(400, 'Invalid date', 'Use YYYY-MM-DD HH:MM:SS (UTC)')
  if (e <= s) throw new HttpError(400, 'Invalid override window', 'End must be after start')
  return insertRecord(db, 'cmn_rota_override', { rota: r.sys_id, member, start_date: fmt(s), end_date: fmt(e), reason: String(body.reason ?? '').trim() || 'Override' }, actor)
}

const ONCALL_ACTOR: Actor = { sys_id: '', user_name: 'oncall.scheduler', name: 'On-Call Scheduler' }
const HIGH = ['1', '2']
const CLOSED = ['6', '7', '8']

/**
 * Business rule: a P1/P2 incident with an assignment group but no assignee goes to the group's current primary on-call,
 * on insert or when it is escalated to P1/P2 (or moved to a new group) while unassigned.
 */
export function autoAssignOnCall(db: Db, inc: Row, prev: Row | null): Row {
  const priority = String(inc.priority ?? '')
  if (!HIGH.includes(priority) || !inc.assignment_group || inc.assigned_to || CLOSED.includes(String(inc.state))) return inc
  if (prev) {
    const escalated = !HIGH.includes(String(prev.priority ?? ''))
    const regrouped = String(prev.assignment_group ?? '') !== String(inc.assignment_group)
    if (!escalated && !regrouped) return inc
  }
  const oc = onCallForGroup(db, String(inc.assignment_group))
  if (!oc) return inc
  const id = String(inc.sys_id)
  const updated = updateRecord(db, 'incident', id, { assigned_to: oc.primary.sys_id }, ONCALL_ACTOR)
  const via = oc.override ? ` Covering via override (${oc.override.reason}) for ${oc.scheduled.name}.` : ''
  const chain = oc.escalation.map((e) => `${e.level}: ${e.name}`).join(' → ')
  addJournal(db, 'incident', id, 'work_notes', `Auto-assigned to ${oc.primary.name} (on-call for ${oc.group.name}).${via} Escalation chain: ${chain}.`, ONCALL_ACTOR)
  return updated
}
