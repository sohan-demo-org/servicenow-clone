import { Router } from 'express'
import type { Request } from 'express'
import { HttpError, addJournal, getRecord, insertRecord, nowStr } from './db.ts'
import type { Db, Row } from './db.ts'
import { TABLES, choiceLabel } from '../shared/schema.ts'
import { parseMentions } from '../shared/mentions.ts'

export type NotificationType = 'assigned' | 'state_change' | 'mention' | 'comment'

export interface NotifyActor {
  sys_id: string
  user_name: string
  name: string
  role?: string
}

export const NOTIFY_TABLES = ['incident', 'problem', 'change_request', 'sc_req_item']
/** The "customer" of each record: notified on state changes and agent comments. */
const REQUESTER: Record<string, string> = { incident: 'caller_id', change_request: 'requested_by', sc_req_item: 'requested_for' }
const AGENT_ROLES = new Set(['admin', 'itil'])

interface NewNotification {
  recipient: string
  type: NotificationType
  table: string
  record: Row
  message: string
  actor: NotifyActor | null
  createdOn?: string
  read?: boolean
}

export function createNotification(db: Db, n: NewNotification): Row {
  return insertRecord(
    db,
    'sys_notification',
    {
      recipient: n.recipient,
      type: n.type,
      source_table: n.table,
      document_id: n.record.sys_id,
      document_number: n.record.number ?? '',
      message: n.message,
      actor: n.actor?.sys_id ?? null,
      read: n.read ? 'true' : 'false',
      sys_created_on: n.createdOn,
    },
    n.actor,
    { skipRules: true },
  )
}

const snippet = (v: string, max = 120) => {
  const s = v.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
const subject = (rec: Row) => [rec.number, rec.short_description].filter(Boolean).join(' - ')

/** Assignment and state-change notifications for a record create (prev = null) or update. */
export function notifyRecordChange(db: Db, table: string, prev: Row | null, next: Row, actor: NotifyActor | null): Row[] {
  if (!NOTIFY_TABLES.includes(table)) return []
  const out: Row[] = []
  const assignee = next.assigned_to ? String(next.assigned_to) : ''
  if (assignee && assignee !== String(prev?.assigned_to ?? '') && assignee !== actor?.sys_id) {
    out.push(
      createNotification(db, {
        recipient: assignee,
        type: 'assigned',
        table,
        record: next,
        actor,
        message: `${subject(next)} has been assigned to you${actor ? ` by ${actor.name}` : ''}`,
      }),
    )
  }
  const reqField = REQUESTER[table]
  const requester = reqField && next[reqField] ? String(next[reqField]) : ''
  if (prev && requester && requester !== actor?.sys_id && String(prev.state ?? '') !== String(next.state ?? '')) {
    out.push(
      createNotification(db, {
        recipient: requester,
        type: 'state_change',
        table,
        record: next,
        actor,
        message: `${next.number} changed from ${choiceLabel(table, 'state', String(prev.state ?? '')) || '(empty)'} to ${choiceLabel(table, 'state', String(next.state ?? ''))}`,
      }),
    )
  }
  return out
}

/** @mention notifications for a journal entry, plus a caller notification when an agent adds a customer-visible comment. */
export function notifyJournal(db: Db, table: string, id: string, element: string, value: string, actor: NotifyActor | null): Row[] {
  if (!TABLES[table]?.journal || (element !== 'work_notes' && element !== 'comments')) return []
  const rec = getRecord(db, table, id)
  const out: Row[] = []
  const notified = new Set<string>()
  const where = element === 'work_notes' ? 'a work note' : 'a comment'
  const names = parseMentions(value)
  if (names.length) {
    const users = db
      .prepare(`SELECT sys_id, user_name, name, role FROM sys_user WHERE active = 'true' AND lower(user_name) IN (${names.map(() => '?').join(',')})`)
      .all(...names) as unknown as NotifyActor[]
    for (const u of users) {
      if (u.sys_id === actor?.sys_id || notified.has(u.sys_id)) continue
      // Work notes are internal: only fulfillers can be pulled in.
      if (element === 'work_notes' && !AGENT_ROLES.has(String(u.role))) continue
      notified.add(u.sys_id)
      out.push(
        createNotification(db, {
          recipient: u.sys_id,
          type: 'mention',
          table,
          record: rec,
          actor,
          message: `${actor?.name ?? 'System'} mentioned you in ${where} on ${rec.number ?? TABLES[table].label}: "${snippet(value)}"`,
        }),
      )
    }
  }
  const reqField = REQUESTER[table]
  const requester = reqField && rec[reqField] ? String(rec[reqField]) : ''
  if (element === 'comments' && actor && AGENT_ROLES.has(String(actor.role)) && requester && requester !== actor.sys_id && !notified.has(requester)) {
    out.push(
      createNotification(db, {
        recipient: requester,
        type: 'comment',
        table,
        record: rec,
        actor,
        message: `${actor.name} added a comment on ${rec.number}: "${snippet(value)}"`,
      }),
    )
  }
  return out
}

export function unreadCount(db: Db, userId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM sys_notification WHERE recipient = ? AND "read" != 'true'`).get(userId) as { n: number }).n
}

const TYPES = new Set<string>(['assigned', 'state_change', 'mention', 'comment'])

export function listNotifications(db: Db, userId: string, opts: { limit?: number; type?: string; unreadOnly?: boolean } = {}) {
  const where = ['n.recipient = ?']
  const params: (string | number)[] = [userId]
  if (opts.type && TYPES.has(opts.type)) {
    where.push('n.type = ?')
    params.push(opts.type)
  }
  if (opts.unreadOnly) where.push(`n."read" != 'true'`)
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 200)
  const sqlWhere = where.join(' AND ')
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM sys_notification n WHERE ${sqlWhere}`).get(...params) as { n: number }).n
  const result = db
    .prepare(
      `SELECT n.*, u.name AS actor_name FROM sys_notification n LEFT JOIN sys_user u ON u.sys_id = n.actor
       WHERE ${sqlWhere}
       ORDER BY CASE WHEN n."read" = 'true' THEN 1 ELSE 0 END, n.sys_created_on DESC, n.rowid DESC LIMIT ?`,
    )
    .all(...params, limit)
  const byType = db
    .prepare(`SELECT type, COUNT(*) AS total, SUM(CASE WHEN "read" = 'true' THEN 0 ELSE 1 END) AS unread FROM sys_notification WHERE recipient = ? GROUP BY type`)
    .all(userId) as { type: string; total: number; unread: number }[]
  return { result, total, unread: unreadCount(db, userId), by_type: byType }
}

export function markRead(db: Db, userId: string, id: string): void {
  const n = db.prepare('SELECT recipient FROM sys_notification WHERE sys_id = ?').get(id) as { recipient: string } | undefined
  if (!n || n.recipient !== userId) throw new HttpError(404, 'No Record found', `Notification ${id} does not exist`)
  db.prepare(`UPDATE sys_notification SET "read" = 'true', sys_updated_on = ? WHERE sys_id = ?`).run(nowStr(), id)
}

export function markAllRead(db: Db, userId: string): number {
  return Number(db.prepare(`UPDATE sys_notification SET "read" = 'true', sys_updated_on = ? WHERE recipient = ? AND "read" != 'true'`).run(nowStr(), userId).changes)
}

export function notificationRoutes(db: Db, actorOf: (req: Request) => NotifyActor | null): Router {
  const r = Router()
  const me = (req: Request): NotifyActor => {
    const a = actorOf(req)
    if (!a) throw new HttpError(401, 'User not authenticated')
    return a
  }
  r.get('/', (req, res) => {
    const a = me(req)
    res.json(listNotifications(db, a.sys_id, { limit: Number(req.query.limit ?? 20), type: String(req.query.type ?? ''), unreadOnly: req.query.unread === 'true' }))
  })
  r.get('/unread_count', (req, res) => {
    res.json({ result: { unread: unreadCount(db, me(req).sys_id) } })
  })
  r.post('/read_all', (req, res) => {
    const a = me(req)
    res.json({ result: { updated: markAllRead(db, a.sys_id), unread: 0 } })
  })
  r.post('/:id/read', (req, res) => {
    const a = me(req)
    markRead(db, a.sys_id, req.params.id)
    res.json({ result: { unread: unreadCount(db, a.sys_id) } })
  })
  return r
}

/** Demo notifications so the bell is alive right after a reset. */
export function seedNotifications(db: Db): void {
  const user = (u: string) => db.prepare('SELECT sys_id, user_name, name, role FROM sys_user WHERE user_name = ?').get(u) as unknown as NotifyActor | undefined
  const admin = user('admin')
  const beth = user('beth.anglin')
  const david = user('david.loo')
  const don = user('don.goodliffe')
  const luke = user('luke.wilson')
  const abel = user('abel.tuter')
  if (!admin || !beth || !david || !don || !luke) return
  const ago = (h: number) => nowStr(new Date(Date.now() - h * 3600000))
  const used = new Set<string>()
  const pickOne = (table: string, where: string, ...params: string[]): Row | undefined => {
    const rows = db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY number DESC`).all(...params) as Row[]
    const row = rows.find((r) => !used.has(String(r.sys_id)))
    if (row) used.add(String(row.sys_id))
    return row
  }
  const ACTIVE_INC = "state IN ('1','2','3')"
  /** Prefer a record already assigned to the user; otherwise hand them an active one. */
  const assignedRecord = (table: string, active: string, to: NotifyActor): Row | undefined => {
    const rec = pickOne(table, `${active} AND assigned_to = ?`, to.sys_id) ?? pickOne(table, active)
    if (rec && rec.assigned_to !== to.sys_id) {
      db.prepare(`UPDATE ${table} SET assigned_to = ?, state = CASE WHEN ? = 'incident' AND state = '1' THEN '2' ELSE state END WHERE sys_id = ?`).run(to.sys_id, table, rec.sys_id)
      rec.assigned_to = to.sys_id
    }
    return rec
  }
  const note = (table: string, rec: Row | undefined, from: NotifyActor, to: NotifyActor, text: string, h: number, read = false) => {
    if (!rec) return
    const at = ago(h)
    addJournal(db, table, String(rec.sys_id), 'work_notes', text, from, at)
    createNotification(db, { recipient: to.sys_id, type: 'mention', table, record: rec, actor: from, createdOn: at, read, message: `${from.name} mentioned you in a work note on ${rec.number}: "${snippet(text)}"` })
  }
  const assigned = (table: string, rec: Row | undefined, from: NotifyActor, to: NotifyActor, h: number, read = false) => {
    if (!rec) return
    createNotification(db, { recipient: to.sys_id, type: 'assigned', table, record: rec, actor: from, createdOn: ago(h), read, message: `${subject(rec)} has been assigned to you by ${from.name}` })
  }

  // Beth Anglin (Service Desk): 3 unread, 2 read
  assigned('incident', assignedRecord('incident', ACTIVE_INC, beth), admin, beth, 0.4)
  note('incident', pickOne('incident', ACTIVE_INC), david, beth, '@beth.anglin can you call the user back and confirm the workaround is still holding before we close this out?', 1.2)
  assigned('sc_req_item', assignedRecord('sc_req_item', "state IN ('1','2')", beth), don, beth, 3)
  note('change_request', pickOne('change_request', "state NOT IN ('3','4')"), don, beth, '@beth.anglin please schedule Service Desk comms for this change window and update the known-issues banner.', 26, true)
  assigned('problem', assignedRecord('problem', "state NOT IN ('106','107')", beth), admin, beth, 49, true)

  // System Administrator: 3 unread, 2 read
  note('incident', pickOne('incident', ACTIVE_INC), beth, admin, '@admin I need elevated access to reset the MFA token for this user - can you grant the security_admin role for an hour?', 0.25)
  assigned('incident', assignedRecord('incident', ACTIVE_INC, admin), beth, admin, 2)
  note('incident', pickOne('incident', ACTIVE_INC), luke, admin, '@admin please review the firewall rule request attached to this ticket before the CAB meeting.', 5)
  assigned('change_request', assignedRecord('change_request', "state NOT IN ('3','4')", admin), don, admin, 30, true)
  note('incident', pickOne('incident', ACTIVE_INC), david, admin, '@admin FYI core-sw-sd-01 firmware upgrade is complete, monitoring for another 24h.', 52, true)

  // Abel Tuter (self-service caller): updates on his own tickets
  if (abel) {
    const inc = pickOne('incident', `${ACTIVE_INC} AND caller_id = ?`, abel.sys_id) ?? pickOne('incident', 'caller_id = ?', abel.sys_id)
    if (inc) {
      const text = 'Hi Abel, we have pushed a fix to your laptop. Could you restart and let us know if the issue persists?'
      addJournal(db, 'incident', String(inc.sys_id), 'comments', text, beth, ago(0.8))
      createNotification(db, { recipient: abel.sys_id, type: 'comment', table: 'incident', record: inc, actor: beth, createdOn: ago(0.8), message: `${beth.name} added a comment on ${inc.number}: "${snippet(text)}"` })
      createNotification(db, { recipient: abel.sys_id, type: 'state_change', table: 'incident', record: inc, actor: beth, createdOn: ago(4), message: `${inc.number} changed from ${inc.state === '2' ? 'New' : 'In Progress'} to ${choiceLabel('incident', 'state', String(inc.state))}` })
    }
  }
}
