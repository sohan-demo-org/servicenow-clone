/**
 * Approval engine backed by `sysapproval_approver` rows.
 *
 * Policy (per approval round):
 * - Changes: the assignment group manager plus the CAB members are asked to approve. The requester is never
 *   asked to approve their own change (segregation of duties).
 * - Requested items (catalog orders >= $1,000): the fulfillment group manager plus the IT budget owner (admin).
 * - Any one approval approves the document; any rejection rejects it. Once the document is decided, the
 *   remaining pending approvers in that round are set to "No Longer Required" (`cancelled`).
 * - Re-requesting approval (e.g. after a rejection) starts a new round; earlier rounds stay as history.
 */
import { Router } from 'express'
import type { Request } from 'express'
import { HttpError, addJournal, getRecord, insertRecord, nowStr, updateRecord } from './db.ts'
import type { Db, Row } from './db.ts'
import { choiceLabel } from '../shared/schema.ts'

export interface Actor {
  sys_id: string
  user_name: string
  name: string
}

export type Decision = 'approved' | 'rejected'
export type DocApproval = 'not requested' | 'requested' | 'approved' | 'rejected'

export const APPROVAL_TABLES = ['change_request', 'sc_req_item'] as const
export const CAB_MEMBERS = ['don.goodliffe', 'admin']
export const BUDGET_APPROVERS = ['admin']

const T = 'sysapproval_approver'

/** Roll the approver states of one round up to the document's approval value (any-one-approves, any-reject-rejects). */
export function rollupApproval(states: string[]): DocApproval {
  const active = states.filter((s) => s !== 'cancelled')
  if (active.includes('rejected')) return 'rejected'
  if (active.includes('approved')) return 'approved'
  if (active.includes('requested')) return 'requested'
  return 'not requested'
}

/** Document field updates applied when the rolled-up approval is final. */
export function documentOutcome(table: string, approval: Decision): Record<string, string> {
  if (table === 'change_request') return approval === 'approved' ? { approval: 'approved', state: '-2' } : { approval: 'rejected', state: '-5' }
  if (table === 'sc_req_item') return approval === 'approved' ? { approval: 'approved', stage: 'fulfillment', state: '2' } : { approval: 'rejected', stage: 'complete', state: '4' }
  throw new HttpError(400, `Approvals are not supported for ${table}`)
}

const isApprovalTable = (t: string) => (APPROVAL_TABLES as readonly string[]).includes(t)

function userIdsByName(db: Db, names: string[]): string[] {
  if (!names.length) return []
  const rows = db.prepare(`SELECT sys_id, user_name FROM sys_user WHERE active = 'true' AND user_name IN (${names.map(() => '?').join(',')})`).all(...names) as { sys_id: string; user_name: string }[]
  return names.map((n) => rows.find((r) => r.user_name === n)?.sys_id).filter((x): x is string => Boolean(x))
}

function groupManager(db: Db, groupId: unknown): string | null {
  if (!groupId) return null
  const g = db.prepare('SELECT manager FROM sys_user_group WHERE sys_id = ?').get(String(groupId)) as { manager: string | null } | undefined
  return g?.manager ?? null
}

/** Who must approve this document, in display order. */
export function approversFor(db: Db, table: string, doc: Row): string[] {
  const mgr = groupManager(db, doc.assignment_group)
  let ids: string[]
  if (table === 'change_request') {
    ids = [mgr, ...userIdsByName(db, CAB_MEMBERS)].filter((x): x is string => Boolean(x)).filter((id) => id !== doc.requested_by)
  } else {
    ids = [mgr, ...userIdsByName(db, BUDGET_APPROVERS)].filter((x): x is string => Boolean(x))
  }
  ids = [...new Set(ids)]
  return ids.length ? ids : userIdsByName(db, ['admin'])
}

function currentRound(db: Db, docId: string): number {
  const r = db.prepare(`SELECT MAX(iteration) AS n FROM ${T} WHERE document_id = ?`).get(docId) as { n: number | null }
  return r.n ?? 0
}

function roundRows(db: Db, docId: string, round = currentRound(db, docId)): Row[] {
  return db.prepare(`SELECT * FROM ${T} WHERE document_id = ? AND iteration = ? ORDER BY sys_created_on, rowid`).all(docId, round) as Row[]
}

function addHours(at: string, hours: number): string {
  const d = new Date(`${at.replace(' ', 'T')}Z`)
  return nowStr(new Date((Number.isNaN(d.getTime()) ? Date.now() : d.getTime()) + hours * 3600000))
}

/** Create a new approval round for the document. Returns the created approver rows. */
export function requestApprovals(db: Db, table: string, id: string, actor: Actor | null, at?: string): Row[] {
  const doc = getRecord(db, table, id)
  const created = at ?? nowStr()
  const round = currentRound(db, id) + 1
  const ids = approversFor(db, table, doc)
  const requestedBy = table === 'change_request' ? doc.requested_by : doc.requested_for
  let due = addHours(created, table === 'change_request' ? 48 : 72)
  if (table === 'change_request' && doc.start_date && String(doc.start_date) > created && String(doc.start_date) < due) due = String(doc.start_date)
  const rows = ids.map((approver) =>
    insertRecord(
      db,
      T,
      {
        approver,
        state: 'requested',
        source_table: table,
        document_id: id,
        document_number: doc.number,
        short_description: doc.short_description,
        requested_by: requestedBy,
        iteration: round,
        due_date: due,
        sys_created_on: created,
      },
      actor,
    ),
  )
  const names = rows.map((r) => (r._dv as unknown as Record<string, string>)?.approver ?? '').filter(Boolean)
  addJournal(db, table, id, 'work_notes', `Approval requested from: ${names.join(', ')}. Any one approval is sufficient; any rejection rejects.`, actor, created)
  return rows
}

function cancelPending(db: Db, docId: string, at: string, comment: string): void {
  db.prepare(`UPDATE ${T} SET state = 'cancelled', decided_on = ?, sys_updated_on = ?, comments = COALESCE(comments, ?) WHERE document_id = ? AND state = 'requested'`).run(at, at, comment, docId)
}

/**
 * Keep approver rows in sync with the document after any write: open a round when the document starts
 * requiring approval, and retire pending approvers when the document is cancelled or decided elsewhere.
 */
export function syncApprovals(db: Db, table: string, id: string, actor: Actor | null): void {
  if (!isApprovalTable(table)) return
  const doc = db.prepare(`SELECT * FROM ${table} WHERE sys_id = ?`).get(id) as Row | undefined
  if (!doc) return
  const pending = roundRows(db, id).filter((r) => r.state === 'requested')
  const cancelled = (table === 'change_request' && doc.state === '4') || (table === 'sc_req_item' && doc.state === '4' && doc.approval === 'requested')
  if (cancelled) {
    if (pending.length) cancelPending(db, id, nowStr(), 'Document was cancelled')
    return
  }
  if (doc.approval === 'requested' && !pending.length) requestApprovals(db, table, id, actor)
  else if (doc.approval !== 'requested' && pending.length) cancelPending(db, id, nowStr(), `Approval set to ${doc.approval ?? 'empty'} on the document`)
}

export interface DecideResult {
  approval: Row
  document: Row
}

/** Record one approver's decision and roll it up to the document. */
export function decide(db: Db, approvalId: string, decision: Decision, comment: string, actor: Actor | null, at?: string): DecideResult {
  const row = db.prepare(`SELECT * FROM ${T} WHERE sys_id = ?`).get(approvalId) as Row | undefined
  if (!row) throw new HttpError(404, 'No Record found', `Approval ${approvalId} does not exist`)
  if (!actor || row.approver !== actor.sys_id) throw new HttpError(403, 'Not your approval', 'Only the assigned approver can approve or reject this record')
  if (row.state !== 'requested') throw new HttpError(409, 'Already decided', `This approval is ${choiceLabel(T, 'state', String(row.state))}`)
  const text = comment.trim()
  if (decision === 'rejected' && !text) throw new HttpError(400, 'Comment required', 'Enter a comment explaining why you are rejecting')
  const table = String(row.source_table)
  const docId = String(row.document_id)
  const when = at ?? nowStr()
  db.prepare(`UPDATE ${T} SET state = ?, comments = ?, decided_on = ?, sys_updated_on = ?, sys_updated_by = ? WHERE sys_id = ?`).run(decision, text || null, when, when, actor.user_name, approvalId)
  addJournal(db, table, docId, 'work_notes', `${decision === 'approved' ? 'Approved' : 'Rejected'} by ${actor.name}${text ? `: ${text}` : ''}`, actor, when)

  const outcome = rollupApproval(roundRows(db, docId, Number(row.iteration)).map((r) => String(r.state)))
  const doc = getRecord(db, table, docId)
  let document = doc
  if ((outcome === 'approved' || outcome === 'rejected') && doc.approval !== outcome) {
    document = updateRecord(db, table, docId, documentOutcome(table, outcome), actor)
    cancelPending(db, docId, when, `Not required: ${outcome} by ${actor.name}`)
  }
  return { approval: getRecord(db, T, approvalId), document }
}

/** Decide the actor's pending approval on a document (used by the document form and legacy endpoint). */
export function decideForDocument(db: Db, table: string, id: string, decision: Decision, comment: string, actor: Actor | null): DecideResult {
  if (!isApprovalTable(table)) throw new HttpError(400, `Approvals are not supported for ${table}`)
  getRecord(db, table, id)
  const mine = actor ? (db.prepare(`SELECT sys_id FROM ${T} WHERE document_id = ? AND approver = ? AND state = 'requested'`).get(id, actor.sys_id) as { sys_id: string } | undefined) : undefined
  if (!mine) throw new HttpError(403, 'Not a pending approver', 'You do not have a pending approval for this record')
  return decide(db, mine.sys_id, decision, comment, actor)
}

function documentSummary(db: Db, table: string, id: string) {
  const doc = db.prepare(`SELECT * FROM ${table} WHERE sys_id = ?`).get(id) as Row | undefined
  if (!doc) return null
  const withDv = getRecord(db, table, id)
  const dv = (withDv._dv ?? {}) as unknown as Record<string, string>
  const base = { number: doc.number, short_description: doc.short_description, approval: doc.approval, state: doc.state, state_label: choiceLabel(table, 'state', String(doc.state ?? '')) }
  if (table === 'change_request') {
    return {
      ...base,
      requested_by: doc.requested_by,
      requested_by_name: dv.requested_by ?? '',
      risk: doc.risk,
      risk_label: choiceLabel(table, 'risk', String(doc.risk ?? '')),
      type_label: choiceLabel(table, 'type', String(doc.type ?? '')),
      cmdb_ci_name: dv.cmdb_ci ?? '',
      group_name: dv.assignment_group ?? '',
      start_date: doc.start_date,
    }
  }
  return {
    ...base,
    requested_by: doc.requested_for,
    requested_by_name: dv.requested_for ?? '',
    price: doc.price,
    quantity: doc.quantity,
    item_name: dv.cat_item ?? '',
    group_name: dv.assignment_group ?? '',
    stage_label: choiceLabel(table, 'stage', String(doc.stage ?? '')),
  }
}

/** The actor's approvals with document context for the My Approvals inbox. */
export function myApprovals(db: Db, userId: string, view: 'pending' | 'history') {
  const where = view === 'pending' ? "state = 'requested'" : "state IN ('approved', 'rejected', 'cancelled')"
  const order = view === 'pending' ? 'sys_created_on ASC' : 'COALESCE(decided_on, sys_updated_on) DESC'
  const rows = db.prepare(`SELECT sys_id FROM ${T} WHERE approver = ? AND ${where} ORDER BY ${order} LIMIT 200`).all(userId) as { sys_id: string }[]
  return rows
    .map((r) => {
      const a = getRecord(db, T, r.sys_id)
      const others = roundRows(db, String(a.document_id), Number(a.iteration))
        .filter((o) => o.sys_id !== a.sys_id)
        .map((o) => ({ approver: o.approver, state: o.state }))
      return { ...a, document: documentSummary(db, String(a.source_table), String(a.document_id)), others }
    })
    .filter((a) => a.document)
}

export function pendingCount(db: Db, userId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${T} WHERE approver = ? AND state = 'requested'`).get(userId) as { n: number }).n
}

export function approvalRouter(db: Db, actorOf: (req: Request) => Actor | null): Router {
  const r = Router()
  const parseDecision = (v: unknown): Decision => {
    if (v === 'approved' || v === 'rejected') return v
    throw new HttpError(400, 'Invalid decision', 'decision must be "approved" or "rejected"')
  }

  r.get('/api/now/approvals/mine', (req, res) => {
    const actor = actorOf(req)
    if (!actor) throw new HttpError(401, 'Not logged in')
    const view = req.query.view === 'history' ? 'history' : 'pending'
    res.json({ result: myApprovals(db, actor.sys_id, view), pending: pendingCount(db, actor.sys_id) })
  })

  r.get('/api/now/approvals/count', (req, res) => {
    const actor = actorOf(req)
    res.json({ result: { pending: actor ? pendingCount(db, actor.sys_id) : 0 } })
  })

  r.get('/api/now/approvals/document/:table/:id', (req, res) => {
    const { table, id } = req.params
    if (!isApprovalTable(table)) throw new HttpError(400, `Approvals are not supported for ${table}`)
    const rows = (db.prepare(`SELECT sys_id FROM ${T} WHERE document_id = ? ORDER BY iteration DESC, sys_created_on, rowid`).all(id) as { sys_id: string }[]).map((x) => getRecord(db, T, x.sys_id))
    res.json({ result: rows, round: currentRound(db, id) })
  })

  r.post('/api/now/approvals/bulk', (req, res) => {
    const actor = actorOf(req)
    const ids: unknown = req.body?.ids
    if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'No approvals selected')
    const decision = parseDecision(req.body?.decision ?? 'approved')
    const comment = String(req.body?.comment ?? '')
    const results = ids.map((id) => {
      try {
        const out = decide(db, String(id), decision, comment, actor)
        return { sys_id: String(id), ok: true, number: out.document.number, approval: out.document.approval }
      } catch (e) {
        return { sys_id: String(id), ok: false, error: e instanceof HttpError ? `${e.message}${e.detail ? `: ${e.detail}` : ''}` : String(e) }
      }
    })
    res.json({ result: results })
  })

  r.post('/api/now/approvals/:id', (req, res) => {
    const out = decide(db, req.params.id, parseDecision(req.body?.decision), String(req.body?.comment ?? ''), actorOf(req))
    res.json({ result: out })
  })

  return r
}
