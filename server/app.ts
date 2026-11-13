import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import {
  HttpError,
  addJournal,
  deleteRecord,
  getRecord,
  groupCounts,
  insertRecord,
  listJournal,
  listRecords,
  updateRecord,
} from './db.ts'
import type { Db, Row } from './db.ts'
import { PresenceHub } from './presence.ts'
import { TABLES } from '../shared/schema.ts'

interface Actor {
  sys_id: string
  user_name: string
  name: string
  role: string
}

function actorOf(db: Db, req: Request): Actor | null {
  const id = req.header('x-user')
  if (!id) return null
  const u = db.prepare('SELECT sys_id, user_name, name, role FROM sys_user WHERE sys_id = ?').get(id) as Actor | undefined
  return u ?? null
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const who = (a: Actor | null) => (a ? { sys_id: a.sys_id, name: a.name, user_name: a.user_name } : null)

function baseModCount(req: Request): number | undefined {
  const raw = req.header('x-base-mod-count')
  if (raw == null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'Invalid X-Base-Mod-Count header')
  return n
}

export function createApp(db: Db, presence: PresenceHub = new PresenceHub()) {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  const client = (req: Request) => req.header('x-client-id') ?? null

  app.post('/api/login', (req, res) => {
    const { user_name, password } = req.body ?? {}
    const u = db.prepare("SELECT * FROM sys_user WHERE user_name = ? AND active = 'true'").get(String(user_name ?? '')) as Row | undefined
    if (!u || password !== 'demo') throw new HttpError(401, 'Invalid user name or password')
    res.json({ result: u })
  })

  app.get('/api/now/table/:table', (req, res) => {
    const actor = actorOf(db, req)
    res.json(
      listRecords(db, req.params.table, {
        query: str(req.query.sysparm_query),
        text: str(req.query.sysparm_text),
        limit: Number(req.query.sysparm_limit ?? 20),
        offset: Number(req.query.sysparm_offset ?? 0),
        ctx: { userId: actor?.sys_id },
      }),
    )
  })

  app.get('/api/now/table/:table/:id', (req, res) => {
    res.json({ result: getRecord(db, req.params.table, req.params.id) })
  })

  app.post('/api/now/table/:table', (req, res) => {
    res.status(201).json({ result: insertRecord(db, req.params.table, req.body ?? {}, actorOf(db, req)) })
  })

  app.patch('/api/now/table/:table/:id', (req, res) => {
    const actor = actorOf(db, req)
    const { work_notes, comments, ...fields } = req.body ?? {}
    const { table, id } = req.params
    let changed: string[] = []
    const result = updateRecord(db, table, id, fields, actor, { expectedModCount: baseModCount(req), onChange: (f) => (changed = f) })
    if (TABLES[table]?.journal) {
      if (work_notes) addJournal(db, table, id, 'work_notes', String(work_notes), actor)
      if (comments) addJournal(db, table, id, 'comments', String(comments), actor)
    }
    if (changed.length) presence.notify(table, id, { type: 'updated', by: who(actor), client: client(req), fields: changed, sys_mod_count: Number(result.sys_mod_count ?? 0) })
    else if (TABLES[table]?.journal && (work_notes || comments))
      presence.notify(table, id, { type: 'journal', by: who(actor), client: client(req), element: work_notes ? 'work_notes' : 'comments' })
    res.json({ result })
  })

  app.delete('/api/now/table/:table/:id', (req, res) => {
    deleteRecord(db, req.params.table, req.params.id)
    presence.notify(req.params.table, req.params.id, { type: 'deleted', by: who(actorOf(db, req)), client: client(req) })
    res.status(204).end()
  })

  app.get('/api/now/journal/:table/:id', (req, res) => {
    getRecord(db, req.params.table, req.params.id)
    res.json({ result: listJournal(db, req.params.id) })
  })

  app.post('/api/now/journal/:table/:id', (req, res) => {
    getRecord(db, req.params.table, req.params.id)
    const element = req.body?.element === 'work_notes' ? 'work_notes' : 'comments'
    const value = String(req.body?.value ?? '').trim()
    if (!value) throw new HttpError(400, 'Journal entry cannot be empty')
    const actor = actorOf(db, req)
    const entry = addJournal(db, req.params.table, req.params.id, element, value, actor)
    db.prepare(`UPDATE ${req.params.table} SET sys_updated_on = ? WHERE sys_id = ?`).run(entry.sys_created_on, req.params.id)
    presence.notify(req.params.table, req.params.id, { type: 'journal', by: who(actor), client: client(req), element })
    res.status(201).json({ result: entry })
  })

  // EventSource cannot send headers, so the stream takes the user as a query param (same trust model as X-User).
  app.get('/api/now/presence/:table/:id/stream', (req, res) => {
    const { table, id } = req.params
    getRecord(db, table, id)
    const u = db.prepare('SELECT sys_id, user_name, name, role FROM sys_user WHERE sys_id = ?').get(str(req.query.user) ?? '') as Actor | undefined
    if (!u) throw new HttpError(401, 'Unknown user')
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    res.flushHeaders()
    const requested = str(req.query.client)
    presence.join(table, id, { sys_id: u.sys_id, name: u.name, user_name: u.user_name }, res, requested && /^[\w-]{6,64}$/.test(requested) ? requested : undefined)
  })

  app.get('/api/now/presence/:table/:id', (req, res) => {
    res.json({ result: presence.viewers(req.params.table, req.params.id) })
  })

  app.post('/api/now/presence/:table/:id', (req, res) => {
    const editing = Array.isArray(req.body?.editing) ? req.body.editing.filter((f: unknown): f is string => typeof f === 'string').slice(0, 50) : []
    const ok = presence.setEditing(req.params.table, req.params.id, String(req.body?.client ?? ''), editing)
    if (!ok) throw new HttpError(404, 'Presence session not found')
    res.json({ result: presence.viewers(req.params.table, req.params.id) })
  })

  app.get('/api/now/stats/:table', (req, res) => {
    const actor = actorOf(db, req)
    const groupBy = str(req.query.sysparm_group_by) ?? 'state'
    res.json({ result: groupCounts(db, req.params.table, groupBy, str(req.query.sysparm_query), { userId: actor?.sys_id }) })
  })

  app.post('/api/now/catalog/:itemId/order', (req, res) => {
    const actor = actorOf(db, req)
    const item = getRecord(db, 'sc_cat_item', req.params.itemId)
    const quantity = Math.max(1, Math.min(10, Number(req.body?.quantity ?? 1) || 1))
    const price = Number(item.price ?? 0) * quantity
    const needsApproval = price >= 1000
    const variables = req.body?.variables && typeof req.body.variables === 'object' ? req.body.variables : {}
    const ritm = insertRecord(
      db,
      'sc_req_item',
      {
        cat_item: item.sys_id,
        requested_for: req.body?.requested_for || actor?.sys_id,
        quantity,
        price,
        stage: needsApproval ? 'waiting_for_approval' : 'request_approved',
        state: '1',
        approval: needsApproval ? 'requested' : 'approved',
        assignment_group: item.fulfillment_group,
        short_description: item.name,
        variables: Object.entries(variables)
          .filter(([, v]) => v !== '' && v != null)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n'),
      },
      actor,
    )
    addJournal(db, 'sc_req_item', String(ritm.sys_id), 'comments', `Request submitted for ${quantity} x ${item.name}.`, actor)
    res.status(201).json({ result: ritm })
  })

  app.post('/api/now/approval/:table/:id', (req, res) => {
    const actor = actorOf(db, req)
    const decision = req.body?.decision === 'rejected' ? 'rejected' : 'approved'
    const { table, id } = req.params
    let fields: Record<string, string>
    if (table === 'change_request') fields = decision === 'approved' ? { approval: 'approved', state: '-2' } : { approval: 'rejected', state: '-5' }
    else if (table === 'sc_req_item') fields = decision === 'approved' ? { approval: 'approved', stage: 'fulfillment', state: '2' } : { approval: 'rejected', stage: 'complete', state: '4' }
    else throw new HttpError(400, `Approvals are not supported for ${table}`)
    let changed: string[] = []
    const result = updateRecord(db, table, id, fields, actor, { onChange: (f) => (changed = f) })
    addJournal(db, table, id, 'work_notes', `${decision === 'approved' ? 'Approved' : 'Rejected'} by ${actor?.name ?? 'System'}${req.body?.comment ? `: ${req.body.comment}` : ''}`, actor)
    presence.notify(table, id, changed.length ? { type: 'updated', by: who(actor), client: client(req), fields: changed, sys_mod_count: Number(result.sys_mod_count ?? 0) } : { type: 'journal', by: who(actor), client: client(req), element: 'work_notes' })
    res.json({ result })
  })

  app.post('/api/now/kb/:id/view', (req, res) => {
    db.prepare('UPDATE kb_knowledge SET sys_view_count = COALESCE(sys_view_count, 0) + 1 WHERE sys_id = ?').run(req.params.id)
    res.json({ result: getRecord(db, 'kb_knowledge', req.params.id) })
  })

  app.post('/api/now/kb/:id/helpful', (req, res) => {
    db.prepare('UPDATE kb_knowledge SET rating = COALESCE(rating, 0) + 1 WHERE sys_id = ?').run(req.params.id)
    res.json({ result: getRecord(db, 'kb_knowledge', req.params.id) })
  })

  app.get('/api/now/search', (req, res) => {
    const q = str(req.query.q)?.trim() ?? ''
    if (!q) {
      res.json({ result: [] })
      return
    }
    const targets: [string, string][] = [
      ['incident', 'numberLIKE{q}^ORshort_descriptionLIKE{q}'],
      ['problem', 'numberLIKE{q}^ORshort_descriptionLIKE{q}'],
      ['change_request', 'numberLIKE{q}^ORshort_descriptionLIKE{q}'],
      ['sc_req_item', 'numberLIKE{q}^ORshort_descriptionLIKE{q}'],
      ['kb_knowledge', "numberLIKE{q}^ORshort_descriptionLIKE{q}^ORtextLIKE{q}"],
      ['cmdb_ci', 'nameLIKE{q}^ORip_addressLIKE{q}'],
      ['sys_user', 'nameLIKE{q}^ORuser_nameLIKE{q}^ORemailLIKE{q}'],
    ]
    const safe = q.replace(/\^/g, '')
    const result = targets
      .map(([table, query]) => {
        const r = listRecords(db, table, { query: query.replaceAll('{q}', safe), limit: 5, ctx: {} })
        return { table, label: TABLES[table].plural, total: r.total, records: r.result }
      })
      .filter((g) => g.total > 0)
    res.json({ result })
  })

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')))

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { message: err.message, detail: err.detail ?? '' }, status: 'failure' })
      return
    }
    console.error(err)
    res.status(500).json({ error: { message: 'Internal server error', detail: String(err) }, status: 'failure' })
  })

  return app
}
