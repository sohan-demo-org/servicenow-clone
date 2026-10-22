import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api.ts'
import type { Rec, StatRow } from '../api.ts'
import { usePageTitle } from '../components/Layout.tsx'
import { Cell } from '../components/ListTable.tsx'
import { listUrl, parseDate, recordUrl } from '../util.ts'
import { useAuth } from '../auth.tsx'
import { OnCallWidget } from '../oncall/OnCallWidget.tsx'

const ACTIVE = 'stateNOTIN6,7,8'
const COLORS = ['#e8443b', '#f5a623', '#f8d24a', '#5aa1e3', '#81b5a1', '#9b8ae0', '#7d8b99', '#3ec1c9']
const PRI_COLORS: Record<string, string> = { '1': '#e8443b', '2': '#f5a623', '3': '#f8d24a', '4': '#5aa1e3', '5': '#81b5a1' }

function Tile({ label, query, table = 'incident', tone }: { label: string; query: string; table?: string; tone?: string }) {
  const [n, setN] = useState<number | null>(null)
  useEffect(() => {
    api.list(table, { query, limit: 1 }).then((r) => setN(r.total))
  }, [table, query])
  return (
    <Link to={listUrl(table, query)} className={`sn-kpi ${tone ?? ''}`} data-testid={`kpi-${label}`}>
      <div className="sn-kpi-value">{n ?? '–'}</div>
      <div className="sn-kpi-label">{label}</div>
    </Link>
  )
}

function BarChart({ data, onClick, colorFor }: { data: StatRow[]; onClick: (r: StatRow) => void; colorFor?: (r: StatRow, i: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.count))
  return (
    <div className="sn-bars">
      {data.map((d, i) => (
        <button key={d.value} className="sn-bar" onClick={() => onClick(d)} title={`${d.label}: ${d.count}`}>
          <span className="sn-bar-count">{d.count}</span>
          <span className="sn-bar-fill" style={{ height: `${(d.count / max) * 150}px`, background: colorFor?.(d, i) ?? COLORS[i % COLORS.length] }} />
          <span className="sn-bar-label">{d.label}</span>
        </button>
      ))}
    </div>
  )
}

function Donut({ data, onClick }: { data: StatRow[]; onClick: (r: StatRow) => void }) {
  const total = data.reduce((s, d) => s + d.count, 0) || 1
  const R = 60
  const C = 2 * Math.PI * R
  const offsets = data.map((_, i) => data.slice(0, i).reduce((s, d) => s + (d.count / total) * C, 0))
  return (
    <div className="sn-donut">
      <svg width="170" height="170" viewBox="0 0 170 170">
        <g transform="translate(85 85) rotate(-90)">
          {data.map((d, i) => {
            const len = (d.count / total) * C
            const el = (
              <circle
                key={d.value}
                r={R}
                fill="none"
                stroke={COLORS[(i + 3) % COLORS.length]}
                strokeWidth="26"
                strokeDasharray={`${len} ${C - len}`}
                strokeDashoffset={-offsets[i]}
                style={{ cursor: 'pointer' }}
                onClick={() => onClick(d)}
              >
                <title>{`${d.label}: ${d.count}`}</title>
              </circle>
            )
            return el
          })}
        </g>
        <text x="85" y="82" textAnchor="middle" className="sn-donut-total">
          {total}
        </text>
        <text x="85" y="100" textAnchor="middle" className="sn-donut-sub">
          total
        </text>
      </svg>
      <ul className="sn-legend">
        {data.map((d, i) => (
          <li key={d.value} onClick={() => onClick(d)}>
            <span style={{ background: COLORS[(i + 3) % COLORS.length] }} />
            {d.label} <b>{d.count}</b>
          </li>
        ))}
      </ul>
    </div>
  )
}

function HBars({ data, onClick }: { data: StatRow[]; onClick: (r: StatRow) => void }) {
  const max = Math.max(1, ...data.map((d) => d.count))
  return (
    <div className="sn-hbars">
      {data.map((d, i) => (
        <button key={d.value} className="sn-hbar" onClick={() => onClick(d)}>
          <span className="sn-hbar-label">{d.label}</span>
          <span className="sn-hbar-track">
            <span style={{ width: `${(d.count / max) * 100}%`, background: COLORS[(i + 4) % COLORS.length] }} />
          </span>
          <b>{d.count}</b>
        </button>
      ))}
    </div>
  )
}

function Trend({ rows }: { rows: Rec[] }) {
  const days = 14
  const buckets = Array.from({ length: days }, (_, i) => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - (days - 1 - i))
    return { d, n: 0 }
  })
  for (const r of rows) {
    const t = parseDate(String(r.opened_at ?? ''))
    if (!t) continue
    const day = new Date(t)
    day.setHours(0, 0, 0, 0)
    const b = buckets.find((x) => x.d.getTime() === day.getTime())
    if (b) b.n++
  }
  const max = Math.max(1, ...buckets.map((b) => b.n))
  const W = 520
  const H = 150
  const pts = buckets.map((b, i) => [20 + (i * (W - 40)) / (days - 1), H - 20 - (b.n / max) * (H - 40)])
  return (
    <svg className="sn-trend" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {[0, 0.5, 1].map((g) => (
        <line key={g} x1="20" x2={W - 20} y1={20 + g * (H - 40)} y2={20 + g * (H - 40)} stroke="#e3e6e8" />
      ))}
      <polygon points={`20,${H - 20} ${pts.map((p) => p.join(',')).join(' ')} ${W - 20},${H - 20}`} fill="rgba(129,181,161,0.25)" />
      <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke="#3d7e6a" strokeWidth="2.5" />
      {pts.map((p, i) => (
        <g key={i}>
          <circle cx={p[0]} cy={p[1]} r="3.5" fill="#3d7e6a">
            <title>{`${buckets[i].d.toLocaleDateString()}: ${buckets[i].n}`}</title>
          </circle>
          {i % 2 === 1 && (
            <text x={p[0]} y={H - 4} textAnchor="middle" className="sn-trend-label">
              {buckets[i].d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </text>
          )}
        </g>
      ))}
    </svg>
  )
}

export function Dashboard() {
  usePageTitle('ITSM Overview')
  const navigate = useNavigate()
  const { user } = useAuth()
  const [byPriority, setByPriority] = useState<StatRow[]>([])
  const [byState, setByState] = useState<StatRow[]>([])
  const [byCategory, setByCategory] = useState<StatRow[]>([])
  const [byGroup, setByGroup] = useState<StatRow[]>([])
  const [changes, setChanges] = useState<StatRow[]>([])
  const [recent, setRecent] = useState<Rec[]>([])
  const [trend, setTrend] = useState<Rec[]>([])

  useEffect(() => {
    api.stats('incident', 'priority', ACTIVE).then((r) => setByPriority([...r].sort((a, b) => a.value.localeCompare(b.value))))
    api.stats('incident', 'state').then(setByState)
    api.stats('incident', 'category', ACTIVE).then(setByCategory)
    api.stats('incident', 'assignment_group', ACTIVE).then(setByGroup)
    api.stats('change_request', 'state').then(setChanges)
    api.list('incident', { query: `priorityIN1,2^${ACTIVE}^ORDERBYpriority^ORDERBYDESCopened_at`, limit: 8 }).then((r) => setRecent(r.result))
    api.list('incident', { query: 'opened_at>javascript:gs.daysAgo(14)', limit: 1000 }).then((r) => setTrend(r.result))
  }, [])

  const drill = (table: string, field: string, base = '') => (r: StatRow) =>
    navigate(listUrl(table, [base, r.value ? `${field}=${r.value}` : `${field}ISEMPTY`].filter(Boolean).join('^')))

  return (
    <div className="sn-dashboard">
      <div className="sn-dash-head">
        <div>
          <h1>ITSM Overview</h1>
          <div className="muted">Welcome back, {String(user?.name ?? '')}. Here is what is happening across IT today.</div>
        </div>
        <div className="sn-dash-actions">
          <Link className="sn-btn primary" to={recordUrl('incident', '-1')}>
            Create Incident
          </Link>
          <Link className="sn-btn" to="/sp">
            Service Portal
          </Link>
        </div>
      </div>

      <div className="sn-kpis">
        <Tile label="Open Incidents" query={ACTIVE} />
        <Tile label="Critical (P1)" query={`priority=1^${ACTIVE}`} tone="red" />
        <Tile label="Unassigned" query={`assigned_toISEMPTY^${ACTIVE}`} tone="amber" />
        <Tile label="Assigned to me" query={`assigned_to=javascript:gs.getUserID()^${ACTIVE}`} />
        <Tile label="Changes awaiting approval" table="change_request" query="approval=requested" tone="blue" />
        <Tile label="Open requests" table="sc_req_item" query="stateIN1,2" />
      </div>

      <div className="sn-widgets">
        <section className="sn-widget">
          <h3>Open Incidents by Priority</h3>
          <BarChart data={byPriority} onClick={drill('incident', 'priority', ACTIVE)} colorFor={(r) => PRI_COLORS[r.value] ?? '#999'} />
        </section>
        <section className="sn-widget">
          <h3>Incidents by State</h3>
          <Donut data={byState} onClick={drill('incident', 'state')} />
        </section>
        <section className="sn-widget">
          <h3>Incidents Opened · Last 14 Days</h3>
          <Trend rows={trend} />
        </section>
        <section className="sn-widget">
          <h3>Open Incidents by Category</h3>
          <HBars data={byCategory} onClick={drill('incident', 'category', ACTIVE)} />
        </section>
        <section className="sn-widget">
          <h3>Open Incidents by Assignment Group</h3>
          <HBars data={byGroup} onClick={drill('incident', 'assignment_group', ACTIVE)} />
        </section>
        <section className="sn-widget">
          <h3>Change Requests by State</h3>
          <HBars data={changes} onClick={drill('change_request', 'state')} />
        </section>
        <OnCallWidget />
        <section className="sn-widget wide">
          <h3>
            Critical &amp; High Priority Open Incidents
            <Link className="sn-link small" to={listUrl('incident', `priorityIN1,2^${ACTIVE}`)}>
              View all
            </Link>
          </h3>
          <table className="sn-table compact">
            <thead>
              <tr>
                <th>Number</th>
                <th>Priority</th>
                <th>Short description</th>
                <th>State</th>
                <th>Assignment group</th>
                <th>Assigned to</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.sys_id}>
                  <td>
                    <Link className="sn-link" to={recordUrl('incident', r.sys_id)}>
                      {String(r.number)}
                    </Link>
                  </td>
                  {['priority', 'short_description', 'state', 'assignment_group', 'assigned_to'].map((f) => (
                    <td key={f}>
                      <Cell table="incident" field={f} rec={r} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  )
}
