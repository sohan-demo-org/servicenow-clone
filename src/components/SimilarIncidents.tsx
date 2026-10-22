import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { choiceLabel } from '../../shared/schema.ts'
import { apiRequest } from '../api.ts'
import { recordUrl, timeAgo } from '../util.ts'
import '../similar.css'

export interface ProblemRef {
  sys_id: string
  number: string
  short_description: string
  state: string
}

interface Match {
  sys_id: string
  number: string
  short_description: string
  state: string
  priority: string
  opened_at: string
  score: number
  reasons: string[]
  resolved: boolean
  close_code: string | null
  close_notes: string | null
  problem: ProblemRef | null
}

interface SimilarResult {
  matches: Match[]
  kb: { sys_id: string; number: string; short_description: string; score: number; reasons: string[] }[]
  problems: (ProblemRef & { score: number; reasons: string[]; linked: boolean })[]
}

export function ScoreBar({ score }: { score: number }) {
  const pct = Math.round(score * 100)
  return (
    <span className="sim-score" title={`Similarity score ${score}`}>
      <span className="sim-track">
        <span className={`sim-fill ${pct >= 50 ? '' : pct >= 38 ? 'mid' : 'low'}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      <span className="sim-pct">{pct}%</span>
    </span>
  )
}

interface Props {
  incidentId: string
  problemId: string
  onApply: (closeCode: string, closeNotes: string, from: string) => void
  onLinkProblem: (problem: ProblemRef) => void
}

export function SimilarIncidents({ incidentId, problemId, onApply, onLinkProblem }: Props) {
  const [data, setData] = useState<SimilarResult | null>(null)
  const [open, setOpen] = useState(true)
  const [applied, setApplied] = useState('')

  useEffect(() => {
    let live = true
    apiRequest<{ result: SimilarResult }>('GET', `/api/now/similar/incident/${incidentId}`)
      .then((r) => live && setData(r.result))
      .catch(() => live && setData({ matches: [], kb: [], problems: [] }))
    return () => {
      live = false
    }
  }, [incidentId, problemId])

  const matches = data?.matches ?? []
  return (
    <div className="sim-panel" data-testid="similar-panel">
      <div className="sim-head" onClick={() => setOpen(!open)}>
        <b>Similar Incidents</b>
        <span className="sim-count">{data ? matches.length : '…'}</span>
        <span className="muted">Matched on description, configuration item, category, assignment group and recency</span>
        <span className="sim-toggle">{open ? 'Hide ▲' : 'Show ▼'}</span>
      </div>
      {open && (
        <div className="sim-body">
          <div className="sim-matches">
            {data && matches.length === 0 && <div className="sim-empty">No similar incidents found.</div>}
            {matches.map((m) => (
              <div className="sim-match" key={m.sys_id} data-testid="similar-match">
                <div className="sim-row">
                  <Link className="sn-link" to={recordUrl('incident', m.sys_id)}>
                    {m.number}
                  </Link>
                  <span className="sim-sd" title={m.short_description}>
                    {m.short_description}
                  </span>
                  <span className={`sim-state ${m.resolved ? 'resolved' : 'open'}`}>{choiceLabel('incident', 'state', m.state)}</span>
                  <span className="muted small" title={m.opened_at}>
                    {timeAgo(m.opened_at)}
                  </span>
                  <ScoreBar score={m.score} />
                </div>
                <div className="sim-reasons">
                  {m.reasons.map((r) => (
                    <span className="sim-chip" key={r}>
                      {r}
                    </span>
                  ))}
                  {m.problem && <span className="sim-chip">problem: {m.problem.number}</span>}
                </div>
                {m.resolved && m.close_notes && (
                  <div className="sim-res" data-testid="suggested-resolution">
                    <div className="sim-res-head">
                      <b>Suggested resolution</b>
                      <span className="muted">{m.close_code}</span>
                      <button
                        className="sn-btn small"
                        data-testid="apply-resolution"
                        onClick={() => {
                          onApply(m.close_code ?? 'Solved (Permanently)', m.close_notes ?? '', m.number)
                          setApplied(m.sys_id)
                          setTimeout(() => document.querySelector('.sn-tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
                        }}
                      >
                        {applied === m.sys_id ? '✓ Applied' : 'Apply resolution'}
                      </button>
                    </div>
                    <p>{m.close_notes}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="sim-side">
            <div>
              <h4>Related Problems</h4>
              {data && data.problems.length === 0 && <div className="muted small">No related problems.</div>}
              {data?.problems.map((p) => (
                <div className="sim-item" key={p.sys_id} data-testid="related-problem">
                  <div className="sim-item-top">
                    <Link className="sn-link" to={recordUrl('problem', p.sys_id)}>
                      {p.number}
                    </Link>
                    {p.sys_id === problemId ? (
                      <span className="sim-linked">Linked</span>
                    ) : (
                      <button className="sn-btn small" data-testid="link-problem" onClick={() => onLinkProblem(p)}>
                        Link to problem
                      </button>
                    )}
                  </div>
                  <span>{p.short_description}</span>
                  <span className="muted small">{p.reasons.join(' · ')}</span>
                </div>
              ))}
            </div>
            <div>
              <h4>Knowledge Articles</h4>
              {data && data.kb.length === 0 && <div className="muted small">No matching articles.</div>}
              {data?.kb.map((k) => (
                <div className="sim-item" key={k.sys_id}>
                  <div className="sim-item-top">
                    <Link className="sn-link" to={`/sp/kb/${k.sys_id}`}>
                      {k.number}
                    </Link>
                    <span className="muted small" style={{ marginLeft: 'auto' }}>
                      {Math.round(k.score * 100)}% match
                    </span>
                  </div>
                  <span>{k.short_description}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
