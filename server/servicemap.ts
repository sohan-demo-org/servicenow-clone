import { HttpError, addJournal, getRecord, insertRecord } from './db.ts'
import type { Db, Row } from './db.ts'
import { choiceLabel } from '../shared/schema.ts'

export type Health = 'ok' | 'minor' | 'degraded' | 'critical'
const RANK: Record<Health, number> = { ok: 0, minor: 1, degraded: 2, critical: 3 }
const worst = (a: Health, b: Health): Health => (RANK[b] > RANK[a] ? b : a)

const OPEN_INC = "state NOT IN ('6','7','8')"
const OPEN_CHG = "state NOT IN ('3','4')"

interface CiSignals {
  incidents: number
  top_priority: number | null
  changes: number
  implementing: boolean
}

export interface MapNode {
  sys_id: string
  name: string
  sys_class_name: string
  class_label: string
  operational_status: string
  environment: string
  ip_address: string
  support_group: string
  support_group_dv: string
  level: number
  health: Health
  rollup: Health
  incidents: number
  top_priority: number | null
  changes: number
  implementing: boolean
}

export interface MapEdge {
  sys_id: string
  parent: string
  child: string
  type: string
  label: string
}

interface Graph {
  cis: Map<string, Row>
  rels: MapEdge[]
  children: Map<string, MapEdge[]>
  parents: Map<string, MapEdge[]>
  signals: Map<string, CiSignals>
  groups: Map<string, string>
}

function loadGraph(db: Db): Graph {
  const cis = new Map((db.prepare('SELECT * FROM cmdb_ci').all() as Row[]).map((r) => [String(r.sys_id), r]))
  const rels: MapEdge[] = (db.prepare('SELECT sys_id, parent, child, type FROM cmdb_rel_ci').all() as Row[])
    .filter((r) => cis.has(String(r.parent)) && cis.has(String(r.child)))
    .map((r) => ({
      sys_id: String(r.sys_id),
      parent: String(r.parent),
      child: String(r.child),
      type: String(r.type),
      label: choiceLabel('cmdb_rel_ci', 'type', String(r.type)).split('::')[0],
    }))
  const children = new Map<string, MapEdge[]>()
  const parents = new Map<string, MapEdge[]>()
  for (const e of rels) {
    children.set(e.parent, [...(children.get(e.parent) ?? []), e])
    parents.set(e.child, [...(parents.get(e.child) ?? []), e])
  }
  const signals = new Map<string, CiSignals>()
  const sig = (id: string) => {
    let s = signals.get(id)
    if (!s) signals.set(id, (s = { incidents: 0, top_priority: null, changes: 0, implementing: false }))
    return s
  }
  for (const r of db.prepare(`SELECT cmdb_ci, COUNT(*) AS n, MIN(CAST(priority AS INTEGER)) AS p FROM incident WHERE cmdb_ci IS NOT NULL AND ${OPEN_INC} GROUP BY cmdb_ci`).all() as Row[]) {
    const s = sig(String(r.cmdb_ci))
    s.incidents = Number(r.n)
    s.top_priority = r.p == null ? null : Number(r.p)
  }
  for (const r of db.prepare(`SELECT cmdb_ci, COUNT(*) AS n, SUM(state = '-1') AS impl FROM change_request WHERE cmdb_ci IS NOT NULL AND ${OPEN_CHG} GROUP BY cmdb_ci`).all() as Row[]) {
    const s = sig(String(r.cmdb_ci))
    s.changes = Number(r.n)
    s.implementing = Number(r.impl) > 0
  }
  const groups = new Map((db.prepare('SELECT sys_id, name FROM sys_user_group').all() as Row[]).map((r) => [String(r.sys_id), String(r.name)]))
  return { cis, rels, children, parents, signals, groups }
}

/** Own health of a CI from its operational status, open incidents and in-flight changes. */
export function ciHealth(ci: Row, s: CiSignals | undefined): Health {
  const op = String(ci.operational_status ?? '1')
  const p = s?.top_priority ?? null
  if (op === '2' || p === 1) return 'critical'
  if (op === '3' || p === 2 || s?.implementing) return 'degraded'
  if ((s?.incidents ?? 0) > 0) return 'minor'
  return 'ok'
}

/** Everything a CI depends on, transitively (excluding itself). */
function downstream(g: Graph, id: string): Set<string> {
  const seen = new Set<string>()
  const stack = [id]
  while (stack.length) {
    for (const e of g.children.get(stack.pop() as string) ?? []) {
      if (e.child === id || seen.has(e.child)) continue
      seen.add(e.child)
      stack.push(e.child)
    }
  }
  return seen
}

/** Everything that depends on a CI, transitively, with hop count and the next hop toward the CI. */
function upstream(g: Graph, id: string): Map<string, { hops: number; via: string }> {
  const out = new Map<string, { hops: number; via: string }>()
  let frontier = [id]
  for (let hops = 1; frontier.length; hops++) {
    const next: string[] = []
    for (const cur of frontier)
      for (const e of g.parents.get(cur) ?? []) {
        if (e.parent === id || out.has(e.parent)) continue
        out.set(e.parent, { hops, via: cur })
        next.push(e.parent)
      }
    frontier = next
  }
  return out
}

function health(g: Graph, id: string): Health {
  return ciHealth(g.cis.get(id) as Row, g.signals.get(id))
}

function rollup(g: Graph, id: string): Health {
  let h = health(g, id)
  for (const d of downstream(g, id)) h = worst(h, health(g, d))
  return h
}

function node(g: Graph, id: string, level: number): MapNode {
  const ci = g.cis.get(id) as Row
  const s = g.signals.get(id)
  const sg = String(ci.support_group ?? '')
  return {
    sys_id: id,
    name: String(ci.name),
    sys_class_name: String(ci.sys_class_name ?? ''),
    class_label: choiceLabel('cmdb_ci', 'sys_class_name', String(ci.sys_class_name ?? '')),
    operational_status: String(ci.operational_status ?? ''),
    environment: String(ci.environment ?? ''),
    ip_address: String(ci.ip_address ?? ''),
    support_group: sg,
    support_group_dv: g.groups.get(sg) ?? '',
    level,
    health: health(g, id),
    rollup: rollup(g, id),
    incidents: s?.incidents ?? 0,
    top_priority: s?.top_priority ?? null,
    changes: s?.changes ?? 0,
    implementing: s?.implementing ?? false,
  }
}

/**
 * Dependency view centred on one CI: consumers above (negative levels), dependencies below
 * (positive levels), up to `depth` hops each way.
 */
export function serviceMap(db: Db, id: string, depth = 3) {
  const g = loadGraph(db)
  if (!g.cis.has(id)) throw new HttpError(404, 'No Record found', `CI ${id} does not exist`)
  const d = Math.max(1, Math.min(6, Math.trunc(depth) || 3))
  const levels = new Map<string, number>([[id, 0]])
  for (const [dir, edgesOf, other] of [
    [1, g.children, (e: MapEdge) => e.child],
    [-1, g.parents, (e: MapEdge) => e.parent],
  ] as const) {
    let frontier = [id]
    for (let i = 1; i <= d && frontier.length; i++) {
      const next: string[] = []
      for (const cur of frontier)
        for (const e of edgesOf.get(cur) ?? []) {
          const o = other(e)
          if (levels.has(o)) continue
          levels.set(o, dir * i)
          next.push(o)
        }
      frontier = next
    }
  }
  const nodes = [...levels].map(([nid, lvl]) => node(g, nid, lvl))
  const edges = g.rels.filter((e) => levels.has(e.parent) && levels.has(e.child))
  return { root: id, depth: d, nodes, edges }
}

/** Blast radius if a CI goes down: every CI and business service that depends on it. */
export function impactAnalysis(db: Db, id: string) {
  const g = loadGraph(db)
  const ci = g.cis.get(id)
  if (!ci) throw new HttpError(404, 'No Record found', `CI ${id} does not exist`)
  const up = upstream(g, id)
  const pathFrom = (start: string): string[] => {
    const path = [String(g.cis.get(start)?.name)]
    let cur = start
    while (cur !== id) {
      cur = (up.get(cur) as { via: string }).via
      path.push(String(g.cis.get(cur)?.name))
    }
    return path
  }
  const impacted = [...up]
    .map(([cid, { hops }]) => ({ ...node(g, cid, -hops), hops, path: pathFrom(cid) }))
    .sort((a, b) => a.hops - b.hops || a.name.localeCompare(b.name))
  const scope = [id, ...up.keys()]
  const ph = scope.map(() => '?').join(',')
  const incidents = db
    .prepare(`SELECT i.sys_id, i.number, i.priority, i.state, i.short_description, i.cmdb_ci, c.name AS ci_name FROM incident i JOIN cmdb_ci c ON c.sys_id = i.cmdb_ci WHERE i.cmdb_ci IN (${ph}) AND i.${OPEN_INC} ORDER BY CAST(i.priority AS INTEGER), i.opened_at DESC`)
    .all(...scope) as Row[]
  const changes = db
    .prepare(`SELECT ch.sys_id, ch.number, ch.state, ch.type, ch.short_description, ch.start_date, ch.cmdb_ci, c.name AS ci_name FROM change_request ch JOIN cmdb_ci c ON c.sys_id = ch.cmdb_ci WHERE ch.cmdb_ci IN (${ph}) AND ch.${OPEN_CHG} ORDER BY ch.start_date`)
    .all(...scope) as Row[]
  return {
    ci: node(g, id, 0),
    impacted,
    services: impacted.filter((n) => n.sys_class_name === 'cmdb_ci_service'),
    incidents: incidents.map((r): Row => ({ ...r, priority_label: choiceLabel('incident', 'priority', String(r.priority)), state_label: choiceLabel('incident', 'state', String(r.state)) })),
    changes: changes.map((r): Row => ({ ...r, state_label: choiceLabel('change_request', 'state', String(r.state)) })),
  }
}

/** Business services with their own health and the health rolled up from everything they depend on. */
export function serviceHealth(db: Db) {
  const g = loadGraph(db)
  return [...g.cis.values()]
    .filter((c) => c.sys_class_name === 'cmdb_ci_service')
    .map((c) => {
      const id = String(c.sys_id)
      const deps = downstream(g, id)
      const causes = [id, ...deps]
        .map((d) => node(g, d, d === id ? 0 : 1))
        .filter((n) => n.health !== 'ok')
        .sort((a, b) => RANK[b.health] - RANK[a.health] || a.name.localeCompare(b.name))
      return {
        ...node(g, id, 0),
        dependencies: deps.size,
        open_incidents: [id, ...deps].reduce((s, d) => s + (g.signals.get(d)?.incidents ?? 0), 0),
        causes,
      }
    })
    .sort((a, b) => RANK[b.rollup] - RANK[a.rollup] || a.name.localeCompare(b.name))
}

const CATEGORY_BY_CLASS: Record<string, string> = {
  cmdb_ci_netgear: 'network',
  cmdb_ci_database: 'database',
  cmdb_ci_server: 'hardware',
  cmdb_ci_computer: 'hardware',
}

interface Actor {
  sys_id: string
  user_name: string
  name: string
}

/** Declare a major (P1) incident against a CI, pre-filled with its blast radius. */
export function declareOutage(db: Db, id: string, actor: Actor | null) {
  const impact = impactAnalysis(db, id)
  const ci = getRecord(db, 'cmdb_ci', id)
  const svc = impact.services.map((s) => `- ${s.name} (via ${s.path.slice(1).join(' -> ')})`)
  const lines = [
    `Outage declared on ${impact.ci.name} (${impact.ci.class_label}) from the Service Map.`,
    '',
    `Business services impacted (${impact.services.length}):`,
    ...(svc.length ? svc : ['- none']),
    '',
    `Total dependent CIs: ${impact.impacted.length}. Related open incidents: ${impact.incidents.length}. Open changes in scope: ${impact.changes.length}.`,
  ]
  const inc = insertRecord(
    db,
    'incident',
    {
      caller_id: actor?.sys_id,
      category: CATEGORY_BY_CLASS[String(ci.sys_class_name)] ?? 'software',
      cmdb_ci: id,
      contact_type: 'self-service',
      state: '1',
      impact: '1',
      urgency: '1',
      assignment_group: ci.support_group,
      short_description: `Major outage: ${impact.ci.name}${impact.services.length ? ` - impacting ${impact.services.map((s) => s.name).join(', ')}` : ''}`,
      description: lines.join('\n'),
    },
    actor,
  )
  if (impact.incidents.length)
    addJournal(db, 'incident', String(inc.sys_id), 'work_notes', `Possibly related open incidents: ${impact.incidents.map((i) => `${i.number} (${i.ci_name})`).join(', ')}`, actor)
  return inc
}

const EXTRA_CIS: [string, string, string, string][] = [
  ['Order to Cash', 'cmdb_ci_service', 'Software', 'Quote, order, invoice and collect across CRM and ERP'],
  ['Hire to Retire', 'cmdb_ci_service', 'Software', 'Recruiting, onboarding, payroll and offboarding'],
  ['Financial Reporting', 'cmdb_ci_service', 'Database', 'Month-end close and management reporting'],
  ['HR Integration Hub', 'cmdb_ci_appl', 'Software', 'Middleware syncing Workday with payroll and badge systems'],
]

const RELS: [string, string, string][] = [
  ['Order to Cash', 'depends_on', 'SAP ERP Production'],
  ['Order to Cash', 'depends_on', 'Salesforce CRM'],
  ['Order to Cash', 'depends_on', 'Okta SSO'],
  ['Hire to Retire', 'depends_on', 'Workday HCM'],
  ['Hire to Retire', 'depends_on', 'HR Integration Hub'],
  ['Hire to Retire', 'depends_on', 'Okta SSO'],
  ['Financial Reporting', 'depends_on', 'SAP ERP Production'],
  ['Financial Reporting', 'depends_on', 'pg-reporting-01'],
  ['Email - Exchange Online', 'depends_on', 'Okta SSO'],
  ['Email - Exchange Online', 'connected_by', 'fw-edge-ams'],
  ['Corporate VPN', 'depends_on', 'Okta SSO'],
  ['Corporate VPN', 'connected_by', 'fw-edge-ams'],
  ['Corporate VPN', 'connected_by', 'core-sw-sd-01'],
  ['SAP ERP Production', 'runs_on', 'lnux-web-01'],
  ['SAP ERP Production', 'runs_on', 'lnux-web-02'],
  ['SAP ERP Production', 'depends_on', 'ora-prod-db1'],
  ['Salesforce CRM', 'depends_on', 'Okta SSO'],
  ['HR Integration Hub', 'runs_on', 'win-app-07'],
  ['HR Integration Hub', 'depends_on', 'sqlsrv-hr-01'],
  ['pg-reporting-01', 'depends_on', 'ora-prod-db1'],
  ['ora-prod-db1', 'connected_by', 'core-sw-sd-01'],
  ['Jenkins CI', 'connected_by', 'core-sw-sd-01'],
  ['lnux-web-01', 'connected_by', 'core-sw-sd-01'],
  ['lnux-web-02', 'connected_by', 'core-sw-sd-01'],
  ['win-app-07', 'connected_by', 'core-sw-sd-01'],
  ['sqlsrv-hr-01', 'connected_by', 'core-sw-sd-01'],
  ['Print Server HQ', 'connected_by', 'core-sw-sd-01'],
  ['wlc-hq-01', 'connected_by', 'core-sw-sd-01'],
  ['core-sw-sd-01', 'connected_by', 'fw-edge-ams'],
  ['Okta SSO', 'connected_by', 'fw-edge-ams'],
]

/** Seeds business services and CI relationships; idempotent, so it also upgrades existing databases. */
export function seedServiceMap(db: Db): void {
  if ((db.prepare('SELECT COUNT(*) AS n FROM cmdb_rel_ci').get() as { n: number }).n > 0) return
  const byName = () => new Map((db.prepare('SELECT sys_id, name FROM cmdb_ci').all() as Row[]).map((r) => [String(r.name), String(r.sys_id)]))
  if (!byName().has('SAP ERP Production')) return
  const groups = new Map((db.prepare('SELECT sys_id, name FROM sys_user_group').all() as Row[]).map((r) => [String(r.name), String(r.sys_id)]))
  db.exec('BEGIN')
  try {
    const existing = byName()
    for (const [name, cls, group, desc] of EXTRA_CIS) {
      if (existing.has(name)) continue
      insertRecord(db, 'cmdb_ci', { name, sys_class_name: cls, environment: 'production', operational_status: '1', location: 'San Diego', support_group: groups.get(group), short_description: desc }, null)
    }
    const ids = byName()
    for (const [parent, type, child] of RELS) {
      if (ids.has(parent) && ids.has(child)) insertRecord(db, 'cmdb_rel_ci', { parent: ids.get(parent), type, child: ids.get(child) }, null)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
