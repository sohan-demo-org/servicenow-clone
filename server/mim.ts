import type { Request, Router } from 'express'
import express from 'express'
import { HttpError, addJournal, getRecord, listJournal, listRecords, nowStr, updateRecord } from './db.ts'
import type { Db, Row } from './db.ts'
import { MIM_UPDATE_CADENCE_MIN } from '../shared/schema.ts'

interface Actor {
  sys_id: string
  user_name: string
  name: string
  role: string
}

export type CommsKind = 'initial' | 'update' | 'resolution'
export interface CommsPayload {
  kind: CommsKind
  audience: string
  message: string
}

const CLOSED = ['6', '7', '8']
const COMMS_KINDS: CommsKind[] = ['initial', 'update', 'resolution']
const CANDIDATE_WINDOW_H = 48

function requireAgent(db: Db, req: Request): Actor {
  const id = req.header('x-user')
  const u = id ? (db.prepare('SELECT sys_id, user_name, name, role FROM sys_user WHERE sys_id = ?').get(id) as Actor | undefined) : undefined
  if (!u) throw new HttpError(401, 'Not signed in')
  if (u.role !== 'itil' && u.role !== 'admin') throw new HttpError(403, 'Major incident management requires the itil role')
  return u
}

function getMajor(db: Db, id: string): Row {
  const inc = getRecord(db, 'incident', id)
  if (inc.major_incident_state !== 'accepted') throw new HttpError(400, 'Not a major incident', `${inc.number} has not been promoted to a major incident`)
  return inc
}

const hoursBetween = (a: string, b: string) => Math.abs(Date.parse(`${a.replace(' ', 'T')}Z`) - Date.parse(`${b.replace(' ', 'T')}Z`)) / 3600000

function commsOf(db: Db, id: string) {
  return (listJournal(db, id) as Row[]).filter((j) => j.element === 'comms')
}

function lastCommsAt(db: Db, inc: Row): string {
  return String(commsOf(db, String(inc.sys_id))[0]?.sys_created_on ?? inc.promoted_on ?? inc.opened_at ?? nowStr())
}

/** Open, unlinked incidents that look like symptoms of the same outage: same CI, or same category opened near the major incident. */
export function findCandidates(db: Db, inc: Row) {
  const open = listRecords(db, 'incident', { query: `stateNOTIN${CLOSED.join(',')}^parent_incidentISEMPTY^major_incident_stateISEMPTY^ORDERBYDESCopened_at`, limit: 200, ctx: {} }).result
  const opened = String(inc.opened_at ?? nowStr())
  return open
    .filter((r) => r.sys_id !== inc.sys_id)
    .map((r) => {
      const reasons: string[] = []
      if (inc.cmdb_ci && r.cmdb_ci === inc.cmdb_ci) reasons.push('Same configuration item')
      if (inc.category && r.category === inc.category && r.opened_at && hoursBetween(String(r.opened_at), opened) <= CANDIDATE_WINDOW_H) reasons.push(`Same category, opened within ${CANDIDATE_WINDOW_H}h`)
      return { ...r, _reasons: reasons, _score: reasons.length + (inc.cmdb_ci && r.cmdb_ci === inc.cmdb_ci ? 1 : 0) }
    })
    .filter((r) => r._reasons.length > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 10)
}

function summary(db: Db, inc: Row) {
  const children = listRecords(db, 'incident', { query: `parent_incident=${inc.sys_id}`, limit: 1000, ctx: {} }).result
  const callers = new Set([inc.caller_id, ...children.map((c) => c.caller_id)].filter(Boolean))
  const last = lastCommsAt(db, inc)
  const due = new Date(Date.parse(`${last.replace(' ', 'T')}Z`) + MIM_UPDATE_CADENCE_MIN * 60000)
  return {
    ...inc,
    _children: children.length,
    _open_children: children.filter((c) => !CLOSED.includes(String(c.state))).length,
    _affected_users: callers.size,
    _comms: commsOf(db, String(inc.sys_id)).length,
    _next_update_due: CLOSED.includes(String(inc.state)) ? null : nowStr(due),
  }
}

export function mimRouter(db: Db): Router {
  const r = express.Router()

  r.get('/', (req, res) => {
    const active = req.query.active !== 'false'
    const q = `major_incident_state=accepted${active ? `^stateNOTIN${CLOSED.join(',')}` : ''}^ORDERBYDESCpromoted_on`
    res.json({ result: listRecords(db, 'incident', { query: q, limit: 100, ctx: {} }).result.map((inc) => summary(db, inc)) })
  })

  r.get('/:id', (req, res) => {
    const inc = getMajor(db, req.params.id)
    const children = listRecords(db, 'incident', { query: `parent_incident=${inc.sys_id}^ORDERBYopened_at`, limit: 1000, ctx: {} }).result
    const timeline = [inc, ...children]
      .flatMap((src) => (listJournal(db, String(src.sys_id)) as Row[]).map((j): Row => ({ ...j, _source: src.number, _source_id: src.sys_id })))
      .sort((a, b) => String(b.sys_created_on).localeCompare(String(a.sys_created_on)))
    res.json({ result: { incident: summary(db, inc), children, candidates: findCandidates(db, inc), timeline } })
  })

  r.post('/:id/promote', (req, res) => {
    const actor = requireAgent(db, req)
    const inc = getRecord(db, 'incident', req.params.id)
    if (inc.major_incident_state === 'accepted') throw new HttpError(400, 'Already a major incident', `${inc.number} is already a major incident`)
    if (CLOSED.includes(String(inc.state))) throw new HttpError(400, 'Incident is closed', 'Only active incidents can be promoted')
    if (inc.parent_incident) throw new HttpError(400, 'Incident is a child', `${inc.number} is a child of another incident; unlink it first`)
    const impact = String(req.body?.business_impact ?? '').trim()
    const result = updateRecord(
      db,
      'incident',
      String(inc.sys_id),
      { major_incident_state: 'accepted', promoted_on: nowStr(), promoted_by: actor.sys_id, impact: '1', urgency: '1', ...(impact ? { business_impact: impact } : {}) },
      actor,
    )
    addJournal(db, 'incident', String(inc.sys_id), 'work_notes', `Promoted to Major Incident by ${actor.name}. Stakeholder updates due every ${MIM_UPDATE_CADENCE_MIN} minutes.`, actor)
    res.json({ result })
  })

  r.post('/:id/children', (req, res) => {
    const actor = requireAgent(db, req)
    const parent = getMajor(db, req.params.id)
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : []
    if (!ids.length) throw new HttpError(400, 'No incidents to link')
    const linked: Row[] = []
    for (const cid of ids) {
      const child = getRecord(db, 'incident', cid)
      if (child.sys_id === parent.sys_id) throw new HttpError(400, 'Cannot link an incident to itself')
      if (child.major_incident_state === 'accepted') throw new HttpError(400, 'Cannot link a major incident', `${child.number} is itself a major incident`)
      if (child.parent_incident === parent.sys_id) continue
      linked.push(updateRecord(db, 'incident', cid, { parent_incident: parent.sys_id }, actor))
      addJournal(db, 'incident', cid, 'work_notes', `Linked as a child of major incident ${parent.number}.`, actor)
    }
    if (linked.length) addJournal(db, 'incident', String(parent.sys_id), 'work_notes', `Linked child incident${linked.length === 1 ? '' : 's'}: ${linked.map((c) => c.number).join(', ')}`, actor)
    res.json({ result: linked })
  })

  r.delete('/:id/children/:childId', (req, res) => {
    const actor = requireAgent(db, req)
    const parent = getMajor(db, req.params.id)
    const child = getRecord(db, 'incident', req.params.childId)
    if (child.parent_incident !== parent.sys_id) throw new HttpError(400, 'Not a child', `${child.number} is not a child of ${parent.number}`)
    updateRecord(db, 'incident', String(child.sys_id), { parent_incident: null }, actor)
    addJournal(db, 'incident', String(parent.sys_id), 'work_notes', `Unlinked child incident ${child.number}.`, actor)
    res.status(204).end()
  })

  r.post('/:id/comms', (req, res) => {
    const actor = requireAgent(db, req)
    const parent = getMajor(db, req.params.id)
    const kind = COMMS_KINDS.includes(req.body?.kind) ? (req.body.kind as CommsKind) : 'update'
    const message = String(req.body?.message ?? '').trim()
    const audience = String(req.body?.audience ?? 'All affected users').trim() || 'All affected users'
    if (!message) throw new HttpError(400, 'Message cannot be empty')
    const payload: CommsPayload = { kind, audience, message }
    const entry = addJournal(db, 'incident', String(parent.sys_id), 'comms', JSON.stringify(payload), actor)
    const callers = db.prepare('SELECT sys_id FROM incident WHERE parent_incident = ?').all(String(parent.sys_id)) as { sys_id: string }[]
    for (const c of [{ sys_id: String(parent.sys_id) }, ...callers]) addJournal(db, 'incident', c.sys_id, 'comments', `[Major incident ${parent.number}] ${message}`, actor)
    db.prepare('UPDATE incident SET sys_updated_on = ? WHERE sys_id = ?').run(entry.sys_created_on, parent.sys_id)
    res.status(201).json({ result: { ...entry, notified: callers.length + 1 } })
  })

  return r
}
