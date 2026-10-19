import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api.ts'
import type { Health, ImpactData, MapEdge, MapNode, Rec, ServiceHealthRow, ServiceMapData } from '../api.ts'
import { Icon } from '../components/Icon.tsx'
import { usePageTitle } from '../components/Layout.tsx'
import { ReferenceInput } from '../components/ReferenceInput.tsx'
import { Cell } from '../components/ListTable.tsx'
import { listUrl, recordUrl } from '../util.ts'

const HEALTH_LABEL: Record<Health, string> = { ok: 'Healthy', minor: 'Minor issues', degraded: 'Degraded', critical: 'Critical' }
const RANK: Record<Health, number> = { ok: 0, minor: 1, degraded: 2, critical: 3 }
const CLASS_ICON: Record<string, string> = {
  cmdb_ci_service: 'cloud',
  cmdb_ci_appl: 'software',
  cmdb_ci_server: 'server',
  cmdb_ci_database: 'database',
  cmdb_ci_netgear: 'network',
  cmdb_ci_computer: 'laptop',
}

function HealthPill({ h, prefix }: { h: Health; prefix?: string }) {
  return (
    <span className={`sm-pill h-${h}`}>
      <i />
      {prefix}
      {HEALTH_LABEL[h]}
    </span>
  )
}

function signalText(n: MapNode): string {
  const parts: string[] = []
  if (n.operational_status === '2') parts.push('non-operational')
  if (n.operational_status === '3') parts.push('repair in progress')
  if (n.incidents) parts.push(`${n.incidents} open incident${n.incidents > 1 ? 's' : ''} (top P${n.top_priority})`)
  if (n.implementing) parts.push('change being implemented')
  return parts.join(', ') || 'no open issues'
}

export function ServiceOverview() {
  usePageTitle('Service Health')
  const navigate = useNavigate()
  const [rows, setRows] = useState<ServiceHealthRow[] | null>(null)
  useEffect(() => {
    api.cmdbServices().then(setRows)
  }, [])
  return (
    <div className="sn-dashboard">
      <div className="sn-dash-head">
        <div>
          <h1>Service Health</h1>
          <div className="sm-muted">Business services, rolled up from every CI they depend on. Click a service to open its dependency map.</div>
        </div>
        <div className="sn-dash-actions sm-open-ci">
          <ReferenceInput table="cmdb_ci" value="" display="" placeholder="Open map for any CI..." onChange={(cid) => cid && navigate(`/map/${cid}`)} />
        </div>
      </div>
      {!rows ? (
        <div className="sm-muted">Loading...</div>
      ) : (
        <div className="sm-services">
          {rows.map((s) => (
            <Link key={s.sys_id} to={`/map/${s.sys_id}`} className={`sm-service h-${s.rollup}`} data-testid={`service-${s.name}`}>
              <div className="sm-service-head">
                <Icon name="cloud" size={22} />
                <b>{s.name}</b>
                <HealthPill h={s.rollup} />
              </div>
              <div className="sm-service-sub">
                {s.rollup === s.health
                  ? s.health === 'ok'
                    ? 'All dependencies healthy'
                    : `Service: ${signalText(s)}`
                  : `Service itself ${s.health === 'ok' ? 'healthy' : HEALTH_LABEL[s.health].toLowerCase()} - impacted by its dependencies`}
              </div>
              <div className="sm-service-stats">
                <span>
                  <b>{s.dependencies}</b> dependencies
                </span>
                <span>
                  <b>{s.open_incidents}</b> open incidents
                </span>
              </div>
              <div className="sm-causes">
                {s.causes.slice(0, 4).map((c) => (
                  <span key={c.sys_id} className={`sm-chip h-${c.health}`} title={signalText(c)}>
                    <Icon name={CLASS_ICON[c.sys_class_name] ?? 'info'} size={12} /> {c.name}
                  </span>
                ))}
                {s.causes.length > 4 && <span className="sm-chip">+{s.causes.length - 4} more</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

const NW = 188
const NH = 62
const GX = 28
const GY = 92
const PAD = 36

interface Pos {
  x: number
  y: number
}

/** Layered top-down layout: consumers above the focus CI, dependencies below, rows ordered by barycentre to limit crossings. */
function layout(nodes: MapNode[], edges: MapEdge[]) {
  const rows = new Map<number, MapNode[]>()
  for (const n of nodes) rows.set(n.level, [...(rows.get(n.level) ?? []), n])
  const levels = [...rows.keys()].sort((a, b) => a - b)
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    adj.set(e.parent, [...(adj.get(e.parent) ?? []), e.child])
    adj.set(e.child, [...(adj.get(e.child) ?? []), e.parent])
  }
  const level = new Map(nodes.map((n) => [n.sys_id, n.level]))
  const order = new Map<number, MapNode[]>()
  for (const l of levels) order.set(l, [...(rows.get(l) ?? [])].sort((a, b) => a.sys_class_name.localeCompare(b.sys_class_name) || a.name.localeCompare(b.name)))
  const maxRow = Math.max(...[...order.values()].map((r) => r.length))
  const width = Math.max(maxRow * (NW + GX) - GX, NW * 2) + PAD * 2
  const pos = new Map<string, Pos>()
  const place = (l: number) => {
    const row = order.get(l) ?? []
    const rw = row.length * (NW + GX) - GX
    row.forEach((n, i) => pos.set(n.sys_id, { x: (width - rw) / 2 + i * (NW + GX), y: PAD + levels.indexOf(l) * (NH + GY) }))
  }
  levels.forEach(place)
  const byDistance = [...levels].sort((a, b) => Math.abs(a) - Math.abs(b))
  for (let pass = 0; pass < 3; pass++) {
    for (const l of byDistance) {
      if (l === 0) continue
      const ref = l - Math.sign(l)
      const bary = (n: MapNode) => {
        const xs = (adj.get(n.sys_id) ?? []).filter((o) => level.get(o) === ref).map((o) => (pos.get(o) as Pos).x)
        return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : (pos.get(n.sys_id) as Pos).x
      }
      order.set(l, [...(order.get(l) ?? [])].sort((a, b) => bary(a) - bary(b)))
      place(l)
    }
  }
  return { pos, width, height: PAD * 2 + levels.length * (NH + GY) - GY }
}

function edgePath(p: Pos, c: Pos) {
  let a: Pos
  let b: Pos
  let c1: Pos
  let c2: Pos
  if (Math.abs(p.y - c.y) < 1) {
    a = { x: p.x + NW / 2, y: p.y + NH }
    b = { x: c.x + NW / 2, y: c.y + NH + 6 }
    c1 = { x: a.x, y: a.y + 46 }
    c2 = { x: b.x, y: b.y + 46 }
  } else if (p.y < c.y) {
    a = { x: p.x + NW / 2, y: p.y + NH }
    b = { x: c.x + NW / 2, y: c.y - 6 }
    c1 = { x: a.x, y: a.y + GY / 2 }
    c2 = { x: b.x, y: b.y - GY / 2 }
  } else {
    a = { x: p.x + NW / 2, y: p.y }
    b = { x: c.x + NW / 2, y: c.y + NH + 6 }
    c1 = { x: a.x, y: a.y - GY / 2 }
    c2 = { x: b.x, y: b.y + GY / 2 }
  }
  const mid = { x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8 }
  return { d: `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`, mid }
}

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function ServiceMapPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [sp, setSp] = useSearchParams()
  const depth = Number(sp.get('depth') ?? 3)
  const simulate = sp.get('simulate') ?? ''
  const [data, setData] = useState<ServiceMapData | null>(null)
  const [err, setErr] = useState('')
  const [selected, setSelected] = useState(id)
  const [impact, setImpact] = useState<ImpactData | null>(null)
  const [incs, setIncs] = useState<Rec[]>([])
  const [chgs, setChgs] = useState<Rec[]>([])
  const [declaring, setDeclaring] = useState(false)

  const root = data?.nodes.find((n) => n.sys_id === data.root)
  usePageTitle(root ? `Service Map: ${root.name}` : 'Service Map')

  useEffect(() => {
    setSelected(simulate || id)
    setErr('')
    api.cmdbMap(id, depth).then(setData, (e: Error) => setErr(e.message))
  }, [id, depth, simulate])

  useEffect(() => {
    setImpact(null)
    if (simulate) api.cmdbImpact(simulate).then(setImpact, () => setImpact(null))
  }, [simulate])

  useEffect(() => {
    if (!selected) return
    api.list('incident', { query: `cmdb_ci=${selected}^stateNOTIN6,7,8^ORDERBYpriority`, limit: 5 }).then((r) => setIncs(r.result))
    api.list('change_request', { query: `cmdb_ci=${selected}^stateNOTIN3,4^ORDERBYstart_date`, limit: 5 }).then((r) => setChgs(r.result))
  }, [selected])

  const setParam = useCallback(
    (k: string, v: string) => {
      const next = new URLSearchParams(sp)
      if (v) next.set(k, v)
      else next.delete(k)
      setSp(next, { replace: true })
    },
    [sp, setSp],
  )

  const lay = useMemo(() => (data ? layout(data.nodes, data.edges) : null), [data])
  const blast = useMemo(() => new Set(impact ? impact.impacted.map((n) => n.sys_id) : []), [impact])
  const failed = impact?.ci.sys_id ?? ''
  const inBlast = (nid: string) => nid === failed || blast.has(nid)

  if (err) return <div className="sn-dashboard">Unable to load service map: {err}</div>
  if (!data || !lay) return <div className="sn-dashboard sm-muted">Loading service map...</div>

  const sel = data.nodes.find((n) => n.sys_id === selected) ?? root
  const declare = async () => {
    if (!impact) return
    setDeclaring(true)
    try {
      const inc = await api.declareOutage(impact.ci.sys_id)
      navigate(recordUrl('incident', inc.sys_id))
    } finally {
      setDeclaring(false)
    }
  }

  return (
    <div className="sm-page">
      <div className="sn-titlebar">
        <button className="sn-icon-btn dark" onClick={() => navigate('/map')} aria-label="Back to Service Health">
          <Icon name="chevronLeft" size={20} />
        </button>
        <h1>
          Service Map <span className="sm-muted">·</span> {root?.name}
        </h1>
        <div className="sn-titlebar-right">
          <div className="sm-picker">
            <ReferenceInput table="cmdb_ci" value="" display="" placeholder="Jump to CI..." onChange={(cid) => cid && navigate(`/map/${cid}`)} />
          </div>
          <label className="sm-muted" htmlFor="sm-depth">
            Levels
          </label>
          <select id="sm-depth" className="sn-input" value={depth} onChange={(e) => setParam('depth', e.target.value)}>
            {[1, 2, 3, 4, 5].map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
          <Link className="sn-btn" to={recordUrl('cmdb_ci', data.root)}>
            Open CI
          </Link>
        </div>
      </div>
      <div className="sm-body">
        <div className="sm-canvas">
          <div className="sm-legend">
            {(['ok', 'minor', 'degraded', 'critical'] as Health[]).map((h) => (
              <span key={h} className={`h-${h}`}>
                <i /> {HEALTH_LABEL[h]}
              </span>
            ))}
            <span className="sm-legend-impacted">
              <Icon name="bolt" size={12} /> impacted by a dependency
            </span>
            <span className="sm-muted">Click to inspect · double-click to re-centre</span>
          </div>
          {impact && (
            <div className="sm-sim-banner" data-testid="sim-banner">
              <Icon name="bolt" size={16} /> Simulating outage of <b>{impact.ci.name}</b>: {impact.services.length} business service{impact.services.length === 1 ? '' : 's'} and{' '}
              {impact.impacted.length} dependent CI{impact.impacted.length === 1 ? '' : 's'} affected
              <button className="sn-btn small" onClick={() => setParam('simulate', '')}>
                End simulation
              </button>
            </div>
          )}
          <svg width={lay.width} height={lay.height} className={`sm-svg ${impact ? 'simulating' : ''}`} data-testid="service-map">
            <defs>
              <marker id="sm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="#8a96a3" />
              </marker>
              <marker id="sm-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="#e8443b" />
              </marker>
            </defs>
            {data.edges.map((e) => {
              const p = lay.pos.get(e.parent) as Pos
              const c = lay.pos.get(e.child) as Pos
              const { d, mid } = edgePath(p, c)
              const hot = impact && blast.has(e.parent) && inBlast(e.child)
              const focus = sel && (e.parent === sel.sys_id || e.child === sel.sys_id)
              return (
                <g key={e.sys_id} className={`sm-edge ${hot ? 'hot' : ''} ${focus ? 'focus' : ''} ${impact && !hot ? 'dim' : ''}`}>
                  <path d={d} markerEnd={`url(#${hot ? 'sm-arrow-hot' : 'sm-arrow'})`}>
                    <title>{`${data.nodes.find((n) => n.sys_id === e.parent)?.name} ${e.label} ${data.nodes.find((n) => n.sys_id === e.child)?.name}`}</title>
                  </path>
                  {(focus || hot) && (
                    <g transform={`translate(${mid.x} ${mid.y})`} className="sm-edge-label">
                      <rect x={-e.label.length * 3.4 - 6} y={-9} width={e.label.length * 6.8 + 12} height={18} rx={9} />
                      <text textAnchor="middle" dy="4">
                        {e.label}
                      </text>
                    </g>
                  )}
                </g>
              )
            })}
            {data.nodes.map((n) => {
              const p = lay.pos.get(n.sys_id) as Pos
              const cls = ['sm-node', `h-${n.health}`]
              if (n.sys_id === data.root) cls.push('root')
              if (sel?.sys_id === n.sys_id) cls.push('selected')
              if (n.sys_id === failed) cls.push('failed')
              else if (blast.has(n.sys_id)) cls.push('impacted')
              else if (impact) cls.push('dim')
              return (
                <g
                  key={n.sys_id}
                  className={cls.join(' ')}
                  transform={`translate(${p.x} ${p.y})`}
                  onClick={() => setSelected(n.sys_id)}
                  onDoubleClick={() => n.sys_id !== data.root && navigate(`/map/${n.sys_id}${sp.get('depth') ? `?depth=${depth}` : ''}`)}
                  data-testid={`node-${n.name}`}
                >
                  <title>{`${n.name} (${n.class_label}) - ${HEALTH_LABEL[n.health]}: ${signalText(n)}`}</title>
                  <rect className="sm-node-box" width={NW} height={NH} rx={6} />
                  <rect className="sm-node-strip" width={6} height={NH} rx={3} />
                  <g transform="translate(16 12)" className="sm-node-icon">
                    <Icon name={CLASS_ICON[n.sys_class_name] ?? 'info'} size={20} />
                  </g>
                  <text x={44} y={25} className="sm-node-name">
                    {trunc(n.name, 19)}
                  </text>
                  <text x={44} y={44} className="sm-node-sub">
                    {n.class_label}
                    {n.environment && n.environment !== 'production' ? ` · ${n.environment}` : ''}
                  </text>
                  {n.incidents > 0 && (
                    <g transform={`translate(${NW - 8} -8)`} className={`sm-badge p${n.top_priority}`}>
                      <circle r={11} />
                      <text textAnchor="middle" dy="4">
                        {n.incidents}
                      </text>
                    </g>
                  )}
                  {n.changes > 0 && (
                    <g transform={`translate(${NW - (n.incidents ? 44 : 22)} -8)`} className={`sm-badge chg ${n.implementing ? 'impl' : ''}`}>
                      <rect x={-13} y={-9} width={26} height={18} rx={4} />
                      <text textAnchor="middle" dy="4">
                        CHG
                      </text>
                    </g>
                  )}
                  {RANK[n.rollup] > RANK[n.health] && (
                    <g transform={`translate(${NW - 24} ${NH - 24})`} className={`sm-rollup h-${n.rollup}`}>
                      <Icon name="bolt" size={16} />
                    </g>
                  )}
                </g>
              )
            })}
          </svg>
        </div>
        {sel && (
          <aside className="sm-panel" data-testid="map-panel">
            <div className="sm-panel-head">
              <Icon name={CLASS_ICON[sel.sys_class_name] ?? 'info'} size={22} />
              <div>
                <h2>{sel.name}</h2>
                <div className="sm-muted">{sel.class_label}</div>
              </div>
            </div>
            <div className="sm-pills">
              <HealthPill h={sel.health} />
              {RANK[sel.rollup] > RANK[sel.health] && <HealthPill h={sel.rollup} prefix="Rolled up: " />}
            </div>
            <dl className="sm-dl">
              <dt>Signals</dt>
              <dd>{signalText(sel)}</dd>
              <dt>Environment</dt>
              <dd>{sel.environment || '-'}</dd>
              {sel.ip_address && (
                <>
                  <dt>IP address</dt>
                  <dd>{sel.ip_address}</dd>
                </>
              )}
              <dt>Support group</dt>
              <dd>{sel.support_group_dv || '-'}</dd>
            </dl>
            <div className="sm-actions">
              <Link className="sn-btn" to={recordUrl('cmdb_ci', sel.sys_id)}>
                Open record
              </Link>
              {sel.sys_id !== data.root && (
                <button className="sn-btn" onClick={() => navigate(`/map/${sel.sys_id}`)}>
                  Centre map here
                </button>
              )}
              {failed === sel.sys_id ? (
                <button className="sn-btn" onClick={() => setParam('simulate', '')}>
                  End simulation
                </button>
              ) : (
                <button className="sn-btn danger-outline" onClick={() => setParam('simulate', sel.sys_id)} data-testid="simulate-outage">
                  <Icon name="bolt" size={14} /> Simulate outage
                </button>
              )}
            </div>

            {impact && impact.ci.sys_id === sel.sys_id && (
              <section className="sm-blast" data-testid="blast-radius">
                <h3>Blast radius</h3>
                <div className="sm-blast-stats">
                  <div>
                    <b>{impact.services.length}</b>
                    <span>business services</span>
                  </div>
                  <div>
                    <b>{impact.impacted.length}</b>
                    <span>dependent CIs</span>
                  </div>
                  <div>
                    <b>{impact.incidents.length}</b>
                    <span>open incidents</span>
                  </div>
                </div>
                {impact.services.length > 0 && (
                  <ul className="sm-list">
                    {impact.services.map((s) => (
                      <li key={s.sys_id}>
                        <Icon name="cloud" size={14} /> <b>{s.name}</b>
                        <div className="sm-path">via {s.path.slice(1, -1).join(' → ') || 'direct dependency'}</div>
                      </li>
                    ))}
                  </ul>
                )}
                {impact.changes.length > 0 && (
                  <div className="sm-warn">
                    <b>{impact.changes.length} open change{impact.changes.length > 1 ? 's' : ''} in scope</b>
                    {impact.changes.slice(0, 4).map((c) => (
                      <div key={c.sys_id}>
                        <Link className="sn-link-subtle" to={recordUrl('change_request', c.sys_id)}>
                          {String(c.number)}
                        </Link>{' '}
                        {c.state_label} · {c.ci_name}
                      </div>
                    ))}
                  </div>
                )}
                <button className="sn-btn danger block" disabled={declaring} onClick={declare} data-testid="declare-outage">
                  Declare major incident
                </button>
              </section>
            )}

            <section>
              <h3>
                Open incidents
                <Link className="sn-link-subtle" to={listUrl('incident', `cmdb_ci=${sel.sys_id}^stateNOTIN6,7,8`)}>
                  View all
                </Link>
              </h3>
              {incs.length === 0 ? (
                <div className="sm-muted">None</div>
              ) : (
                <ul className="sm-list">
                  {incs.map((r) => (
                    <li key={r.sys_id}>
                      <Link className="sn-link" to={recordUrl('incident', r.sys_id)}>
                        {String(r.number)}
                      </Link>{' '}
                      <Cell table="incident" field="priority" rec={r} />
                      <div className="sm-path">{String(r.short_description)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h3>Open changes</h3>
              {chgs.length === 0 ? (
                <div className="sm-muted">None</div>
              ) : (
                <ul className="sm-list">
                  {chgs.map((r) => (
                    <li key={r.sys_id}>
                      <Link className="sn-link" to={recordUrl('change_request', r.sys_id)}>
                        {String(r.number)}
                      </Link>{' '}
                      <Cell table="change_request" field="state" rec={r} />
                      <div className="sm-path">{String(r.short_description)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        )}
      </div>
    </div>
  )
}
