import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { choiceLabel } from '../../shared/schema.ts'
import { api, apiRequest } from '../api.ts'
import type { Rec } from '../api.ts'
import { usePageTitle } from '../components/Layout.tsx'
import type { ProblemRef } from '../components/SimilarIncidents.tsx'
import { recordUrl, timeAgo } from '../util.ts'
import '../similar.css'

interface ClusterIncident {
  sys_id: string
  number: string
  short_description: string
  opened_at: string
  priority: string
  state: string
  problem: ProblemRef | null
}

interface Cluster {
  id: string
  size: number
  cohesion: number
  suggested_title: string
  top_terms: string[]
  cmdb_ci: { sys_id: string; name: string; count: number } | null
  category: string | null
  subcategory: string | null
  assignment_group: { sys_id: string; name: string } | null
  oldest_opened: string
  newest_opened: string
  spark: number[]
  existing_problem: ProblemRef | null
  related_problem: ProblemRef | null
  incidents: ClusterIncident[]
}

interface ClusterResult {
  threshold: number
  open_incidents: number
  clusters: Cluster[]
}

const LEVELS: [string, number][] = [
  ['Loose', 0.38],
  ['Balanced', 0.45],
  ['Strict', 0.55],
]

function Sparkline({ data }: { data: number[] }) {
  const w = 112
  const h = 28
  const max = Math.max(1, ...data)
  const bw = w / data.length
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-label="Incidents opened per day, last 14 days">
      <line x1="0" y1={h - 0.5} x2={w} y2={h - 0.5} stroke="#d4d8dc" />
      {data.map((v, i) => {
        const bh = v ? Math.max(3, (v / max) * (h - 4)) : 0
        return <rect key={i} x={i * bw + 1} y={h - 1 - bh} width={bw - 2} height={bh} rx="1" fill={i >= data.length - 3 ? '#e2a92b' : '#81b5a1'} />
      })}
    </svg>
  )
}

function ClusterCard({ c, onChanged }: { c: Cluster; onChanged: () => void }) {
  const navigate = useNavigate()
  const [title, setTitle] = useState(c.suggested_title)
  const [sel, setSel] = useState<Set<string>>(() => new Set(c.incidents.filter((i) => !i.problem).map((i) => i.sys_id)))
  const [busy, setBusy] = useState(false)
  const toggle = (id: string) => {
    const s = new Set(sel)
    if (s.has(id)) s.delete(id)
    else s.add(id)
    setSel(s)
  }
  const create = async () => {
    setBusy(true)
    try {
      const r = await apiRequest<{ result: { problem: Rec } }>('POST', '/api/now/clusters/incident/problem', { incident_ids: [...sel], short_description: title })
      navigate(recordUrl('problem', r.result.problem.sys_id))
    } finally {
      setBusy(false)
    }
  }
  const link = async (p: ProblemRef) => {
    setBusy(true)
    try {
      for (const id of sel) await api.update('incident', id, { problem_id: p.sys_id, work_notes: `Linked to Problem ${p.number} "${p.short_description}" from Incident Clusters.` })
      onChanged()
    } finally {
      setBusy(false)
    }
  }
  const prb = c.existing_problem ?? c.related_problem
  return (
    <div className="cl-card" data-testid="cluster-card">
      <div className="cl-card-head">
        <div className="cl-count">
          <b>{c.size}</b>
          <small>incidents</small>
        </div>
        <div className="cl-title">
          <input className="sn-input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Problem statement" data-testid="cluster-title" />
          <div className="cl-meta">
            {c.cmdb_ci && (
              <span>
                CI: <b>{c.cmdb_ci.name}</b> ({c.cmdb_ci.count}/{c.size})
              </span>
            )}
            {c.category && (
              <span>
                Category: <b>{choiceLabel('incident', 'category', c.category)}</b>
              </span>
            )}
            {c.assignment_group && (
              <span>
                Group: <b>{c.assignment_group.name}</b>
              </span>
            )}
            <span>
              Cohesion: <b>{Math.round(c.cohesion * 100)}%</b>
            </span>
          </div>
        </div>
      </div>
      <div className="cl-mid">
        <div className="cl-terms">
          {c.top_terms.map((t) => (
            <span className="cl-term" key={t}>
              {t}
            </span>
          ))}
        </div>
        <div className="cl-spark">
          <Sparkline data={c.spark} />
          <span>
            oldest {timeAgo(c.oldest_opened)} · newest {timeAgo(c.newest_opened)}
          </span>
        </div>
      </div>
      {prb && (
        <div className={`cl-prb ${c.existing_problem ? 'linked' : ''}`}>
          <span>
            {c.existing_problem ? 'Linked to ' : 'Possible existing problem: '}
            <Link className="sn-link" to={recordUrl('problem', prb.sys_id)}>
              {prb.number}
            </Link>{' '}
            {prb.short_description}
          </span>
          {sel.size > 0 && (
            <button className="sn-btn small" disabled={busy} onClick={() => link(prb)}>
              Link selected
            </button>
          )}
        </div>
      )}
      <ul className="cl-list">
        {c.incidents.map((i) => (
          <li key={i.sys_id}>
            <input type="checkbox" checked={sel.has(i.sys_id)} onChange={() => toggle(i.sys_id)} aria-label={`Select ${i.number}`} />
            <span className={`sn-pri-dot p${i.priority}`} title={choiceLabel('incident', 'priority', i.priority)} />
            <Link className="sn-link" to={recordUrl('incident', i.sys_id)}>
              {i.number}
            </Link>
            <span className="sim-sd" title={i.short_description}>
              {i.short_description}
            </span>
            {i.problem && <span className="sim-chip">{i.problem.number}</span>}
            <span className="muted">{choiceLabel('incident', 'state', i.state)}</span>
            <span className="muted">{timeAgo(i.opened_at)}</span>
          </li>
        ))}
      </ul>
      <div className="cl-foot">
        <span className="muted">{sel.size} selected</span>
        <button className="sn-btn primary" disabled={busy || sel.size === 0} onClick={create} data-testid="create-problem">
          Create Problem
        </button>
      </div>
    </div>
  )
}

export function IncidentClusters() {
  usePageTitle('Incident Clusters')
  const [threshold, setThreshold] = useState(0.45)
  const [data, setData] = useState<ClusterResult | null>(null)
  const load = useCallback(() => {
    apiRequest<{ result: ClusterResult }>('GET', `/api/now/clusters/incident?threshold=${threshold}`).then((r) => setData(r.result))
  }, [threshold])
  useEffect(load, [load])

  const clustered = data?.clusters.reduce((s, c) => s + c.size, 0) ?? 0
  return (
    <div>
      <div className="sn-titlebar">
        <h1>Incident Clusters</h1>
        <div className="sn-titlebar-right">
          <span className="muted small">Similarity</span>
          <div className="sn-seg">
            {LEVELS.map(([label, t]) => (
              <button key={label} className={threshold === t ? 'on' : ''} onClick={() => setThreshold(t)}>
                {label}
              </button>
            ))}
          </div>
          <button className="sn-btn" onClick={load}>
            Refresh
          </button>
        </div>
      </div>
      <div className="cl-page">
        {!data ? (
          <div className="sn-loading">Loading…</div>
        ) : (
          <>
            <div className="cl-summary" data-testid="cluster-summary">
              <span>
                <b>{data.clusters.length}</b> clusters
              </span>
              <span>
                <b>{clustered}</b> of {data.open_incidents} open incidents look related
              </span>
              <span className="muted small">Select incidents and create a Problem to investigate the shared root cause.</span>
            </div>
            {data.clusters.length === 0 && <div className="sn-empty">No clusters at this similarity level.</div>}
            <div className="cl-grid">
              {data.clusters.map((c) => (
                <ClusterCard key={`${c.id}-${threshold}`} c={c} onChanged={load} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
