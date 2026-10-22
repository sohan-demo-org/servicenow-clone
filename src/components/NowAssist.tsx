import { useState } from 'react'
import { Link } from 'react-router-dom'
import { getField } from '../../shared/schema.ts'
import { ApiError, api } from '../api.ts'
import type { AssistKbDraft, AssistResolve, AssistResult, AssistSkill, AssistSource, AssistSummary, Rec } from '../api.ts'
import { formatDate, recordUrl } from '../util.ts'
import { Icon } from './Icon.tsx'

export const ASSIST_SKILLS: Record<string, AssistSkill[]> = {
  incident: ['summarize', 'resolve', 'kb_draft'],
  problem: ['summarize'],
  change_request: ['summarize'],
  sc_req_item: ['summarize'],
}

const SKILL_META: Record<AssistSkill, { title: string; blurb: string; action: string }> = {
  summarize: { title: 'Summarize', blurb: 'Catch up on the record, activity and caller sentiment', action: 'Generate summary' },
  resolve: { title: 'Suggest resolution', blurb: 'Steps grounded in knowledge articles and past incidents', action: 'Suggest a resolution' },
  kb_draft: { title: 'Draft KB article', blurb: 'Turn this incident into reusable knowledge', action: 'Draft article' },
}

interface Props {
  table: string
  id: string
  rec: Rec
  onClose: () => void
  onPostWorkNote: (text: string) => Promise<void>
  onApplyResolution: (closeCode: string, closeNotes: string) => void
  onCreateKb: (draft: AssistKbDraft) => Promise<Rec>
}

type Results = Partial<{ summarize: AssistResult<AssistSummary>; resolve: AssistResult<AssistResolve>; kb_draft: AssistResult<AssistKbDraft> }>

function Sources({ sources }: { sources: AssistSource[] }) {
  if (!sources.length) return null
  return (
    <div className="na-sources">
      <div className="na-label">Sources</div>
      {sources.map((s) => (
        <Link key={s.sys_id} to={recordUrl(s.table, s.sys_id)} className="na-source" title={s.title} data-testid="na-source">
          <Icon name={s.table === 'kb_knowledge' ? 'book' : 'list'} size={12} />
          <b>{s.number}</b>
          <span>{s.title}</span>
        </Link>
      ))}
    </div>
  )
}

export function NowAssist({ table, id, rec, onClose, onPostWorkNote, onApplyResolution, onCreateKb }: Props) {
  const skills = ASSIST_SKILLS[table] ?? []
  const [active, setActive] = useState<AssistSkill>(skills[0])
  const [results, setResults] = useState<Results>({})
  const [loading, setLoading] = useState<AssistSkill | null>(null)
  const [error, setError] = useState('')
  const [done, setDone] = useState<Record<string, string>>({})
  const [kbRec, setKbRec] = useState<Rec | null>(null)
  const [feedback, setFeedback] = useState<Record<string, 'up' | 'down'>>({})
  const [showTimeline, setShowTimeline] = useState(false)

  const run = async (skill: AssistSkill) => {
    setActive(skill)
    setError('')
    setLoading(skill)
    setDone((d) => ({ ...d, [skill]: '' }))
    try {
      const r = await api.assist<never>(skill, table, id)
      setResults((p) => ({ ...p, [skill]: r }))
      if (skill === 'kb_draft') setKbRec(null)
    } catch (e) {
      setError((e as ApiError).message)
    } finally {
      setLoading(null)
    }
  }

  const act = async (key: string, fn: () => Promise<void> | void, msg: string) => {
    await fn()
    setDone((d) => ({ ...d, [key]: msg }))
  }

  const pick = (skill: AssistSkill) => {
    setActive(skill)
    if (!results[skill] && loading !== skill) run(skill)
  }

  const res = results[active]
  const resolved = ['6', '7'].includes(String(rec.state))

  return (
    <aside className="na-panel" data-testid="now-assist" aria-label="Now Assist">
      <div className="na-head">
        <span className="na-logo">
          <Icon name="sparkle" size={18} />
        </span>
        <div>
          <b>Now Assist</b>
          <div className="na-sub">GenAI for {String(rec.number ?? '')}</div>
        </div>
        <button className="sn-icon-btn" onClick={onClose} aria-label="Close Now Assist">
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="na-skills" role="tablist">
        {skills.map((s) => (
          <button key={s} role="tab" aria-selected={active === s} className={`na-skill ${active === s ? 'on' : ''}`} onClick={() => pick(s)} data-testid={`na-skill-${s}`}>
            <b>{SKILL_META[s].title}</b>
            <span>{SKILL_META[s].blurb}</span>
          </button>
        ))}
      </div>

      <div className="na-body">
        {active === 'kb_draft' && !resolved && !res && loading !== 'kb_draft' && (
          <div className="na-hint">Tip: KB drafts are best once the incident is resolved and has resolution notes.</div>
        )}
        {error && <div className="sn-msg error na-msg">{error}</div>}
        {loading === active && (
          <div className="na-loading" data-testid="na-loading">
            <div className="na-thinking">
              <Icon name="sparkle" size={14} /> Now Assist is reading the record, activity and knowledge base…
            </div>
            <div className="na-shimmer w90" />
            <div className="na-shimmer w70" />
            <div className="na-shimmer w80" />
            <div className="na-shimmer w50" />
          </div>
        )}
        {!res && loading !== active && (
          <div className="na-empty">
            <button className="na-generate" onClick={() => run(active)} data-testid="na-generate">
              <Icon name="sparkle" size={14} /> {SKILL_META[active].action}
            </button>
          </div>
        )}

        {res && loading !== active && (
          <div className="na-result" data-testid={`na-result-${active}`}>
            {active === 'summarize' &&
              (() => {
                const o = (res as AssistResult<AssistSummary>).output
                return (
                  <>
                    <div className="na-headline">{o.headline}</div>
                    <span className={`na-chip ${o.sentiment}`} data-testid="na-sentiment">
                      Caller sentiment: {o.sentiment}
                    </span>
                    <p className="na-text" data-testid="na-summary">
                      {o.summary}
                    </p>
                    <div className="na-label">Recommended next steps</div>
                    <ul className="na-list">
                      {o.next_steps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                    {o.timeline.length > 0 && (
                      <>
                        <button className="na-link" onClick={() => setShowTimeline(!showTimeline)}>
                          {showTimeline ? 'Hide' : 'Show'} recent activity ({o.timeline.length})
                        </button>
                        {showTimeline && (
                          <ol className="na-timeline">
                            {o.timeline.map((t, i) => (
                              <li key={i}>
                                <small>
                                  {formatDate(t.when)} · {t.who}
                                </small>
                                <div>{t.what}</div>
                              </li>
                            ))}
                          </ol>
                        )}
                      </>
                    )}
                    <div className="na-actions">
                      <button
                        className="sn-btn primary"
                        disabled={Boolean(done.summarize)}
                        data-testid="na-post-summary"
                        onClick={() => act('summarize', () => onPostWorkNote(`Now Assist summary:\n${o.summary}\n\nNext steps:\n${o.next_steps.map((s) => `- ${s}`).join('\n')}`), 'Posted to work notes')}
                      >
                        Post as work note
                      </button>
                      <button className="sn-btn" onClick={() => act('summarize-copy', () => navigator.clipboard?.writeText(o.summary), 'Copied')}>
                        <Icon name="copy" size={13} /> Copy
                      </button>
                    </div>
                  </>
                )
              })()}

            {active === 'resolve' &&
              (() => {
                const o = (res as AssistResult<AssistResolve>).output
                const level = o.confidence >= 70 ? 'high' : o.confidence >= 45 ? 'med' : 'low'
                return (
                  <>
                    <div className="na-confidence" data-testid="na-confidence">
                      <div className="na-conf-top">
                        <span className="na-label">Confidence</span>
                        <b className={level}>{o.confidence}%</b>
                      </div>
                      <div className="na-conf-track">
                        <span className={level} style={{ width: `${o.confidence}%` }} />
                      </div>
                    </div>
                    <p className="na-text">{o.rationale}</p>
                    <div className="na-label">Suggested steps</div>
                    <ol className="na-list numbered" data-testid="na-steps">
                      {o.steps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                    <Sources sources={o.sources} />
                    {o.close_notes && (
                      <div className="na-preview">
                        <div className="na-label">Proposed resolution · {o.close_code}</div>
                        <div className="na-preview-text">{o.close_notes}</div>
                      </div>
                    )}
                    <div className="na-actions">
                      {!resolved && o.close_notes && (
                        <button className="sn-btn primary" data-testid="na-apply-resolution" onClick={() => act('resolve', () => onApplyResolution(o.close_code, o.close_notes), 'Applied to Resolution Information')}>
                          Apply to resolution
                        </button>
                      )}
                      <button
                        className="sn-btn"
                        disabled={Boolean(done['resolve-note'])}
                        data-testid="na-post-steps"
                        onClick={() => act('resolve-note', () => onPostWorkNote(`Now Assist suggested resolution (${o.confidence}% confidence):\n${o.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\nSources: ${o.sources.map((s) => s.number).join(', ') || 'none'}`), 'Posted to work notes')}
                      >
                        Post steps as work note
                      </button>
                    </div>
                  </>
                )
              })()}

            {active === 'kb_draft' &&
              (() => {
                const o = (res as AssistResult<AssistKbDraft>).output
                return (
                  <>
                    <div className="na-headline" data-testid="na-kb-title">
                      {o.short_description}
                    </div>
                    <span className="na-chip neutral">Category: {getField('kb_knowledge', 'kb_category')?.choices?.find((c) => c.value === o.kb_category)?.label ?? o.kb_category}</span>
                    <div className="na-article" data-testid="na-kb-text">
                      {o.text}
                    </div>
                    <Sources sources={o.sources} />
                    <div className="na-actions">
                      {kbRec ? (
                        <Link className="sn-btn primary" to={recordUrl('kb_knowledge', kbRec.sys_id)} data-testid="na-open-kb">
                          Open {String(kbRec.number)}
                        </Link>
                      ) : (
                        <button
                          className="sn-btn primary"
                          data-testid="na-create-kb"
                          onClick={() =>
                            act(
                              'kb_draft',
                              async () => {
                                setKbRec(await onCreateKb(o))
                              },
                              'Draft article created',
                            )
                          }
                        >
                          Create draft article
                        </button>
                      )}
                    </div>
                  </>
                )
              })()}

            {done[active] || done[`${active}-note`] || done[`${active}-copy`] ? (
              <div className="na-done" data-testid="na-done">
                <Icon name="check" size={13} /> {done[active] || done[`${active}-note`] || done[`${active}-copy`]}
              </div>
            ) : null}

            <div className="na-foot">
              <div className="na-feedback">
                <span>Helpful?</span>
                <button className={feedback[active] === 'up' ? 'on' : ''} onClick={() => setFeedback({ ...feedback, [active]: 'up' })} aria-label="Helpful">
                  <Icon name="thumb" size={13} />
                </button>
                <button className={`down ${feedback[active] === 'down' ? 'on' : ''}`} onClick={() => setFeedback({ ...feedback, [active]: 'down' })} aria-label="Not helpful">
                  <Icon name="thumb" size={13} />
                </button>
                <button className="na-regen" onClick={() => run(active)} data-testid="na-regenerate" title="Regenerate">
                  <Icon name="refresh" size={13} /> Regenerate
                </button>
              </div>
              <div className="na-meta" data-testid="na-meta">
                {res.provider === 'Built-in' ? 'Built-in engine (no LLM configured)' : `${res.model} via ${res.provider}`} · {(res.latency_ms / 1000).toFixed(1)}s
                {res.fallback_reason && <> · LLM unavailable, used fallback</>}
              </div>
              <div className="na-disclaimer">AI-generated content can be inaccurate. Review before sharing with customers.</div>
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
