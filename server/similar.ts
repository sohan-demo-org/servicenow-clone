import type { Express, Request } from 'express'
import { HttpError, addJournal, getRecord, insertRecord, updateRecord } from './db.ts'
import type { Db, Row } from './db.ts'

/* ---------- text processing ---------- */

const STOP = new Set(
  (
    'a an and are as at be been but by can cannot could did do does for from had has have he her him his how i if in into is it its ' +
    'me my no not of on or our out she so than that the their them then there these they this to too up us was we were what when ' +
    'where which who why will with you your after again all also am any because before being both each few further just more most ' +
    'now only other over own same some such very while since still get gets got keep keeps please need help issue issues problem ' +
    'user users unable error since today morning every few minutes hours seems'
  ).split(' '),
)

export function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3)
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2)
  if (w.length > 4 && w.endsWith('es') && !w.endsWith('ses')) return w.slice(0, -1)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

/** Lower-case word tokens with stop words removed and light stemming. Returns stems plus a stem→surface map. */
export function tokenize(text: string, surface?: Map<string, string>): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw) || /^\d+$/.test(raw)) continue
    const s = stem(raw)
    if (STOP.has(s)) continue
    if (surface && !surface.has(s)) surface.set(s, raw)
    out.push(s)
  }
  return out
}

export type Vec = Map<string, number>

export function buildIdf(docs: string[][]): Map<string, number> {
  const df = new Map<string, number>()
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1)
  const n = docs.length
  const idf = new Map<string, number>()
  for (const [t, c] of df) idf.set(t, Math.log((1 + n) / (1 + c)) + 1)
  return idf
}

export function tfidf(tokens: string[], idf: Map<string, number>): Vec {
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  const v: Vec = new Map()
  let norm = 0
  for (const [t, c] of tf) {
    const w = (1 + Math.log(c)) * (idf.get(t) ?? Math.log(2) + 1)
    v.set(t, w)
    norm += w * w
  }
  norm = Math.sqrt(norm) || 1
  for (const [t, w] of v) v.set(t, w / norm)
  return v
}

export function cosine(a: Vec, b: Vec): number {
  const [small, big] = a.size < b.size ? [a, b] : [b, a]
  let s = 0
  for (const [t, w] of small) s += w * (big.get(t) ?? 0)
  return Math.min(1, s)
}

/* ---------- scoring ---------- */

export interface IncidentDoc {
  sys_id: string
  number: string
  short_description: string
  description: string
  cmdb_ci: string | null
  cmdb_ci_name: string
  category: string | null
  subcategory: string | null
  assignment_group: string | null
  assignment_group_name: string
  opened_at: string
  state: string
  vec: Vec
}

export const WEIGHTS = { text: 0.55, ci: 0.2, category: 0.06, subcategory: 0.07, group: 0.07 }
export const SIMILAR_MIN = 0.3
export const CLUSTER_THRESHOLD = 0.45

const parse = (s: string) => new Date(`${s.replace(' ', 'T')}Z`).getTime()
const DAY = 86400000

export interface Score {
  score: number
  text: number
  sharedTerms: string[]
  reasons: string[]
}

/** Recency factor in [0.8, 1]: incidents opened close together in time are more likely related. */
export function recency(aOpened: string, bOpened: string): number {
  const days = Math.abs(parse(aOpened) - parse(bOpened)) / DAY
  if (!Number.isFinite(days)) return 0.9
  return 0.8 + 0.2 * Math.exp(-days / 30)
}

export function scorePair(a: IncidentDoc, b: IncidentDoc, surface?: Map<string, string>, subLabel?: (v: string) => string): Score {
  const text = cosine(a.vec, b.vec)
  const sameCi = !!a.cmdb_ci && a.cmdb_ci === b.cmdb_ci
  const sameCat = !!a.category && a.category === b.category
  const sameSub = sameCat && !!a.subcategory && a.subcategory === b.subcategory
  const sameGroup = !!a.assignment_group && a.assignment_group === b.assignment_group
  const raw = WEIGHTS.text * text + (sameCi ? WEIGHTS.ci : 0) + (sameCat ? WEIGHTS.category : 0) + (sameSub ? WEIGHTS.subcategory : 0) + (sameGroup ? WEIGHTS.group : 0)
  const score = text === 0 && !sameCi ? 0 : raw * recency(a.opened_at, b.opened_at)
  const shared = [...a.vec.keys()]
    .filter((t) => b.vec.has(t))
    .sort((x, y) => (a.vec.get(y) ?? 0) * (b.vec.get(y) ?? 0) - (a.vec.get(x) ?? 0) * (b.vec.get(x) ?? 0))
    .slice(0, 4)
    .map((t) => surface?.get(t) ?? t)
  const reasons: string[] = []
  if (sameCi) reasons.push(`same CI: ${a.cmdb_ci_name}`)
  if (shared.length) reasons.push(`shared terms: ${shared.join(', ')}`)
  if (sameSub) reasons.push(`same category: ${a.category}/${subLabel ? subLabel(String(a.subcategory)) : a.subcategory}`)
  else if (sameCat) reasons.push(`same category: ${a.category}`)
  if (sameGroup) reasons.push(`same group: ${a.assignment_group_name}`)
  return { score: Math.round(score * 1000) / 1000, text, sharedTerms: shared, reasons }
}

/* ---------- clustering (average-linkage agglomerative) ---------- */

export function cluster(n: number, sim: (i: number, j: number) => number, threshold: number): number[][] {
  const S: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : sim(i, j))))
  let groups: number[][] = Array.from({ length: n }, (_, i) => [i])
  const avg = (g: number[], h: number[]) => {
    let s = 0
    for (const i of g) for (const j of h) s += S[i][j]
    return s / (g.length * h.length)
  }
  for (;;) {
    let best = -1
    let bi = -1
    let bj = -1
    for (let i = 0; i < groups.length; i++)
      for (let j = i + 1; j < groups.length; j++) {
        const s = avg(groups[i], groups[j])
        if (s > best) [best, bi, bj] = [s, i, j]
      }
    if (bi < 0 || best < threshold) break
    const merged = [...groups[bi], ...groups[bj]]
    groups = groups.filter((_, k) => k !== bi && k !== bj)
    groups.push(merged)
  }
  return groups.filter((g) => g.length > 1).map((g) => g.sort((x, y) => x - y))
}

/* ---------- db-backed corpus ---------- */

const OPEN = ['1', '2', '3']
const isOpen = (s: unknown) => OPEN.includes(String(s))
const textOf = (r: Row) => `${r.short_description ?? ''} ${r.short_description ?? ''} ${r.description ?? ''}`

interface Corpus {
  docs: IncidentDoc[]
  rows: Map<string, Row>
  idf: Map<string, number>
  surface: Map<string, string>
}

function names(db: Db, table: string, field: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const r of db.prepare(`SELECT sys_id, ${field} AS n FROM ${table}`).all() as { sys_id: string; n: string }[]) m.set(r.sys_id, r.n)
  return m
}

function loadCorpus(db: Db): Corpus {
  const rows = db.prepare('SELECT * FROM incident').all() as Row[]
  const surface = new Map<string, string>()
  const toks = rows.map((r) => tokenize(textOf(r), surface))
  const kbRows = db.prepare("SELECT short_description, text FROM kb_knowledge WHERE workflow_state = 'published'").all() as Row[]
  const idf = buildIdf([...toks, ...kbRows.map((k) => tokenize(`${k.short_description} ${k.text}`))])
  const ci = names(db, 'cmdb_ci', 'name')
  const grp = names(db, 'sys_user_group', 'name')
  const docs = rows.map((r, i) => ({
    sys_id: String(r.sys_id),
    number: String(r.number),
    short_description: String(r.short_description ?? ''),
    description: String(r.description ?? ''),
    cmdb_ci: (r.cmdb_ci as string) || null,
    cmdb_ci_name: ci.get(String(r.cmdb_ci)) ?? '',
    category: (r.category as string) || null,
    subcategory: (r.subcategory as string) || null,
    assignment_group: (r.assignment_group as string) || null,
    assignment_group_name: grp.get(String(r.assignment_group)) ?? '',
    opened_at: String(r.opened_at ?? r.sys_created_on ?? ''),
    state: String(r.state ?? ''),
    vec: tfidf(toks[i], idf),
  }))
  return { docs, rows: new Map(rows.map((r) => [String(r.sys_id), r])), idf, surface }
}

const SUB_LABEL: Record<string, string> = { vpn: 'VPN', erp: 'ERP', dns: 'DNS', dhcp: 'DHCP', 'vpn client': 'VPN Client' }
const subLabel = (v: string) => SUB_LABEL[v] ?? v

function problemRef(db: Db, id: unknown) {
  if (!id) return null
  const p = db.prepare('SELECT sys_id, number, short_description, state FROM problem WHERE sys_id = ?').get(String(id)) as Row | undefined
  return p ? { sys_id: String(p.sys_id), number: String(p.number), short_description: String(p.short_description), state: String(p.state) } : null
}

export function findSimilar(db: Db, id: string, limit = 8) {
  getRecord(db, 'incident', id)
  const c = loadCorpus(db)
  const me = c.docs.find((d) => d.sys_id === id)!
  const meRow = c.rows.get(id)!
  const matches = c.docs
    .filter((d) => d.sys_id !== id && d.state !== '8')
    .map((d) => ({ d, s: scorePair(me, d, c.surface, subLabel) }))
    .filter((x) => x.s.score >= SIMILAR_MIN)
    .sort((x, y) => y.s.score - x.s.score)
    .slice(0, limit)
    .map(({ d, s }) => {
      const r = c.rows.get(d.sys_id)!
      const resolved = ['6', '7'].includes(d.state)
      return {
        sys_id: d.sys_id,
        number: d.number,
        short_description: d.short_description,
        state: d.state,
        priority: String(r.priority ?? ''),
        opened_at: d.opened_at,
        resolved_at: (r.resolved_at as string) ?? null,
        cmdb_ci_name: d.cmdb_ci_name,
        score: s.score,
        reasons: s.reasons,
        resolved,
        close_code: resolved ? ((r.close_code as string) ?? null) : null,
        close_notes: resolved ? ((r.close_notes as string) ?? null) : null,
        problem: problemRef(db, r.problem_id),
      }
    })

  const kb = (db.prepare("SELECT sys_id, number, short_description, text FROM kb_knowledge WHERE workflow_state = 'published'").all() as Row[])
    .map((k) => {
      const v = tfidf(tokenize(`${k.short_description} ${k.short_description} ${k.text}`), c.idf)
      const score = cosine(me.vec, v)
      const shared = [...me.vec.keys()].filter((t) => v.has(t)).slice(0, 3).map((t) => c.surface.get(t) ?? t)
      return { sys_id: String(k.sys_id), number: String(k.number), short_description: String(k.short_description), score: Math.round(score * 1000) / 1000, reasons: shared.length ? [`shared terms: ${shared.join(', ')}`] : [] }
    })
    .filter((k) => k.score >= 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)

  // Problems: those already linked to similar incidents, plus problems whose statement matches this incident.
  const probScores = new Map<string, { score: number; reasons: Set<string> }>()
  const bump = (pid: string, score: number, reason: string) => {
    const cur = probScores.get(pid) ?? { score: 0, reasons: new Set<string>() }
    cur.score = Math.max(cur.score, score)
    cur.reasons.add(reason)
    probScores.set(pid, cur)
  }
  for (const m of matches) if (m.problem) bump(m.problem.sys_id, m.score, `linked to similar ${m.number}`)
  for (const p of db.prepare("SELECT * FROM problem WHERE state NOT IN ('107')").all() as Row[]) {
    const v = tfidf(tokenize(`${p.short_description} ${p.description ?? ''}`), c.idf)
    const text = cosine(me.vec, v)
    const sameCi = !!me.cmdb_ci && p.cmdb_ci === me.cmdb_ci
    const score = WEIGHTS.text * text + (sameCi ? WEIGHTS.ci : 0) + (p.category === me.category ? WEIGHTS.category : 0)
    if (score >= 0.25 && (text > 0.08 || sameCi)) bump(String(p.sys_id), score, sameCi ? `same CI: ${me.cmdb_ci_name}` : 'matching problem statement')
  }
  const problems = [...probScores.entries()]
    .map(([pid, v]) => ({ ...problemRef(db, pid)!, score: Math.round(Math.min(1, v.score) * 1000) / 1000, reasons: [...v.reasons].slice(0, 3), linked: pid === meRow.problem_id }))
    .sort((a, b) => Number(b.linked) - Number(a.linked) || b.score - a.score)
    .slice(0, 3)

  return { incident: { sys_id: id, number: me.number }, matches, kb, problems }
}

export function findClusters(db: Db, threshold = CLUSTER_THRESHOLD) {
  const c = loadCorpus(db)
  const open = c.docs.filter((d) => isOpen(d.state))
  const scores = new Map<string, Score>()
  const key = (i: number, j: number) => (i < j ? `${i}:${j}` : `${j}:${i}`)
  const sim = (i: number, j: number) => {
    const k = key(i, j)
    if (!scores.has(k)) scores.set(k, scorePair(open[i], open[j], c.surface, subLabel))
    return scores.get(k)!.score
  }
  const groups = cluster(open.length, sim, threshold)
  const mode = <T,>(xs: T[]): [T | null, number] => {
    const m = new Map<T, number>()
    for (const x of xs) if (x != null && x !== '') m.set(x, (m.get(x) ?? 0) + 1)
    let best: T | null = null
    let n = 0
    for (const [k, v] of m) if (v > n) [best, n] = [k, v]
    return [best, n]
  }
  const now = Date.now()
  const probs = (db.prepare("SELECT * FROM problem WHERE state NOT IN ('106', '107')").all() as Row[]).map((p) => ({
    p,
    vec: tfidf(tokenize(`${p.short_description} ${p.description ?? ''}`), c.idf),
  }))
  const clusters = groups.map((g) => {
    const members = g.map((i) => open[i])
    const centrality = g.map((i) => g.reduce((s, j) => s + (i === j ? 0 : sim(i, j)), 0) / (g.length - 1))
    const medoid = members[centrality.indexOf(Math.max(...centrality))]
    const cohesion = centrality.reduce((a, b) => a + b, 0) / centrality.length
    const termW = new Map<string, number>()
    for (const m of members) for (const [t, w] of m.vec) termW.set(t, (termW.get(t) ?? 0) + w)
    const df = (t: string) => members.filter((m) => m.vec.has(t)).length
    const topTerms = [...termW.entries()]
      .filter(([t]) => df(t) >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([t]) => c.surface.get(t) ?? t)
    const [ci, ciN] = mode(members.map((m) => m.cmdb_ci))
    const [category] = mode(members.map((m) => m.category))
    const [subcategory] = mode(members.map((m) => m.subcategory))
    const [group] = mode(members.map((m) => m.assignment_group))
    const ciName = members.find((m) => m.cmdb_ci === ci)?.cmdb_ci_name ?? ''
    const opened = members.map((m) => parse(m.opened_at)).filter(Number.isFinite)
    const spark = Array.from({ length: 14 }, (_, d) => opened.filter((t) => Math.floor((now - t) / DAY) === 13 - d).length)
    const [linkedProblem, linkedN] = mode(members.map((m) => (c.rows.get(m.sys_id)?.problem_id as string) || null))
    const centroid: Vec = new Map()
    for (const m of members) for (const [t, w] of m.vec) centroid.set(t, (centroid.get(t) ?? 0) + w / members.length)
    const related = probs
      .map(({ p, vec }) => ({ p, s: cosine(centroid, vec) + (ci && p.cmdb_ci === ci ? 0.3 : 0) }))
      .filter((x) => x.s >= 0.4)
      .sort((a, b) => b.s - a.s)[0]
    const title = `Recurring: ${medoid.short_description}${ciName && ciN >= members.length / 2 ? ` (${ciName})` : ''}`
    return {
      id: members.map((m) => m.number).join('-'),
      size: members.length,
      cohesion: Math.round(cohesion * 1000) / 1000,
      suggested_title: title,
      top_terms: topTerms,
      cmdb_ci: ci ? { sys_id: ci, name: ciName, count: ciN } : null,
      category,
      subcategory,
      assignment_group: group ? { sys_id: group, name: members.find((m) => m.assignment_group === group)?.assignment_group_name ?? '' } : null,
      oldest_opened: members.reduce((a, m) => (m.opened_at < a ? m.opened_at : a), members[0].opened_at),
      newest_opened: members.reduce((a, m) => (m.opened_at > a ? m.opened_at : a), members[0].opened_at),
      spark,
      existing_problem: linkedProblem && linkedN >= 2 ? problemRef(db, linkedProblem) : null,
      related_problem: related ? problemRef(db, related.p.sys_id) : null,
      incidents: members.map((m) => {
        const r = c.rows.get(m.sys_id)!
        return {
          sys_id: m.sys_id,
          number: m.number,
          short_description: m.short_description,
          opened_at: m.opened_at,
          priority: String(r.priority ?? ''),
          state: m.state,
          cmdb_ci_name: m.cmdb_ci_name,
          problem: problemRef(db, r.problem_id),
        }
      }),
    }
  })
  clusters.sort((a, b) => b.size - a.size || b.cohesion - a.cohesion)
  return { threshold, open_incidents: open.length, clusters }
}

interface Actor {
  sys_id: string
  user_name: string
  name: string
}

export function createProblemFromIncidents(db: Db, ids: string[], opts: { short_description?: string; description?: string }, actor: Actor | null) {
  if (!ids.length) throw new HttpError(400, 'No incidents selected')
  const incs = ids.map((id) => getRecord(db, 'incident', id))
  const most = (f: string) => {
    const m = new Map<string, number>()
    for (const r of incs) if (r[f]) m.set(String(r[f]), (m.get(String(r[f])) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  }
  const minOf = (f: string) => String(Math.min(...incs.map((r) => Number(r[f] ?? 3))))
  const list = incs.map((r) => `- ${r.number}: ${r.short_description}`).join('\n')
  const problem = insertRecord(
    db,
    'problem',
    {
      short_description: opts.short_description?.trim() || `Recurring: ${incs[0].short_description}`,
      description: opts.description?.trim() || `Created from an incident cluster of ${incs.length} similar incidents:\n${list}`,
      category: most('category'),
      cmdb_ci: most('cmdb_ci'),
      assignment_group: most('assignment_group'),
      impact: minOf('impact'),
      urgency: minOf('urgency'),
    },
    actor,
  )
  const pid = String(problem.sys_id)
  addJournal(db, 'problem', pid, 'work_notes', `Problem created from incident cluster (${incs.length} incidents):\n${list}`, actor)
  for (const r of incs) {
    updateRecord(db, 'incident', String(r.sys_id), { problem_id: pid }, actor)
    addJournal(db, 'incident', String(r.sys_id), 'work_notes', `Linked to Problem ${problem.number} "${problem.short_description}" — created from an incident cluster of ${incs.length} similar incidents.`, actor)
  }
  return { problem, linked: incs.map((r) => String(r.number)) }
}

export function registerSimilarRoutes(app: Express, db: Db, actorOf: (db: Db, req: Request) => Actor | null) {
  app.get('/api/now/similar/incident/:id', (req, res) => {
    const limit = Math.max(1, Math.min(20, Number(req.query.limit ?? 8) || 8))
    res.json({ result: findSimilar(db, req.params.id, limit) })
  })
  app.get('/api/now/clusters/incident', (req, res) => {
    const t = Number(req.query.threshold)
    res.json({ result: findClusters(db, Number.isFinite(t) && t > 0 && t < 1 ? t : CLUSTER_THRESHOLD) })
  })
  app.post('/api/now/clusters/incident/problem', (req, res) => {
    const ids = Array.isArray(req.body?.incident_ids) ? req.body.incident_ids.map(String) : []
    res.status(201).json({ result: createProblemFromIncidents(db, ids, { short_description: req.body?.short_description, description: req.body?.description }, actorOf(db, req)) })
  })
}
