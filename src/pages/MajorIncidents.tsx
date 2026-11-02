import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { MIM_UPDATE_CADENCE_MIN, getField } from '../../shared/schema.ts'
import { ApiError, api } from '../api.ts'
import type { MajorIncident, TimelineEntry, Workbench } from '../api.ts'
import { CommsText } from '../components/ActivityStream.tsx'
import { Icon } from '../components/Icon.tsx'
import { usePageTitle } from '../components/Layout.tsx'
import { displayValue, formatDate, initials, parseDate, recordUrl, timeAgo } from '../util.ts'

type Kind = 'initial' | 'update' | 'resolution'
const AUDIENCES = ['All employees', 'All affected users', 'IT leadership', 'Customer-facing teams']
const CLOSE_CODES = getField('incident', 'close_code')?.choices ?? []

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${h}:${p(m)}:${p(s % 60)}`
}

function short(ms: number): string {
  const m = Math.floor(Math.abs(ms) / 60000)
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${Math.floor((Math.abs(ms) % 60000) / 1000)}s`
}

function isOpen(inc: MajorIncident) {
  return !['6', '7', '8'].includes(String(inc.state))
}

function elapsedMs(inc: MajorIncident, now: number) {
  const start = parseDate(String(inc.opened_at ?? ''))?.getTime() ?? now
  const end = isOpen(inc) ? now : (parseDate(String(inc.resolved_at ?? ''))?.getTime() ?? now)
  return end - start
}

function NextUpdate({ inc, now, big }: { inc: MajorIncident; now: number; big?: boolean }) {
  if (!isOpen(inc) || !inc._next_update_due) return <span className="sn-mim-due done">No further updates due</span>
  const left = (parseDate(inc._next_update_due)?.getTime() ?? now) - now
  const tone = left < 0 ? 'overdue' : left < 10 * 60000 ? 'soon' : 'ok'
  return (
    <span className={`sn-mim-due ${tone} ${big ? 'big' : ''}`} data-testid="mim-next-update">
      {left < 0 ? `Overdue ${short(left)}` : `Due in ${short(left)}`}
    </span>
  )
}

export function MajorIncidentList() {
  usePageTitle('Major Incidents')
  const now = useNow()
  const [active, setActive] = useState(true)
  const [rows, setRows] = useState<MajorIncident[] | null>(null)
  useEffect(() => {
    setRows(null)
    api.mim.list(active).then(setRows)
  }, [active])

  return (
    <div className="sn-dashboard">
      <div className="sn-dash-head">
        <div>
          <h1>Major Incidents</h1>
          <div className="muted">Promote an incident from its form to coordinate a war room, link related reports and keep stakeholders updated every {MIM_UPDATE_CADENCE_MIN} minutes.</div>
        </div>
        <div className="sn-dash-actions sn-seg">
          <button className={active ? 'on' : ''} onClick={() => setActive(true)}>
            Active
          </button>
          <button className={!active ? 'on' : ''} onClick={() => setActive(false)}>
            All
          </button>
        </div>
      </div>
      {!rows ? (
        <div className="sn-loading">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="sn-empty-state">No {active ? 'active ' : ''}major incidents. Use “Promote to Major Incident” on an incident form.</div>
      ) : (
        <div className="sn-mim-cards">
          {rows.map((m) => (
            <Link key={m.sys_id} to={`/mim/${m.sys_id}`} className={`sn-mim-card ${isOpen(m) ? '' : 'resolved'}`} data-testid="mim-card">
              <div className="sn-mim-card-head">
                <span className="sn-mim-tag">{isOpen(m) ? 'Major Incident' : 'Resolved'}</span>
                <b>{m.number}</b>
                <span className="sn-mim-clock">{clock(elapsedMs(m, now))}</span>
              </div>
              <div className="sn-mim-card-title">{m.short_description}</div>
              <div className="muted small">
                {m._dv?.cmdb_ci ?? 'No CI'} · {m._dv?.assignment_group ?? 'Unassigned'} · {m._dv?.assigned_to ?? 'No manager'}
              </div>
              <div className="sn-mim-card-stats">
                <span>
                  <b>{m._children}</b> child incidents
                </span>
                <span>
                  <b>{m._affected_users}</b> affected users
                </span>
                <span>
                  <b>{m._comms}</b> updates sent
                </span>
                <NextUpdate inc={m} now={now} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function template(kind: Kind, wb: Workbench, closeNotes = ''): string {
  const inc = wb.incident
  const svc = inc._dv?.cmdb_ci ?? 'a business service'
  const open = wb.children.filter((c) => !['6', '7', '8'].includes(String(c.state))).length
  if (kind === 'initial')
    return `We are aware of an issue affecting ${svc}: ${inc.short_description}.${inc.business_impact ? ` Impact: ${inc.business_impact}` : ''} IT is investigating. Next update in ${MIM_UPDATE_CADENCE_MIN} minutes.`
  if (kind === 'update')
    return `Update on ${svc}: the investigation is ongoing and ${open} related report${open === 1 ? ' is' : 's are'} linked to this incident. We will share the next update in ${MIM_UPDATE_CADENCE_MIN} minutes.`
  return `The issue affecting ${svc} has been resolved. ${closeNotes || 'Services are restored and being monitored.'} Thank you for your patience.`
}

const TL_FILTERS = [
  ['all', 'All'],
  ['comms', 'Stakeholder updates'],
  ['work_notes', 'Work notes'],
  ['comments', 'Comments'],
  ['audit', 'Field changes'],
] as const

function Timeline({ entries, parentId }: { entries: TimelineEntry[]; parentId: string }) {
  const [filter, setFilter] = useState<(typeof TL_FILTERS)[number][0]>('all')
  const visible = entries.filter((e) => filter === 'all' || e.element === filter)
  return (
    <div className="sn-widget">
      <h3>
        Timeline <span className="muted">{visible.length} entries across parent and children</span>
      </h3>
      <div className="sn-seg sn-mim-tl-filter">
        {TL_FILTERS.map(([k, label]) => (
          <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      <ul className="sn-stream" data-testid="mim-timeline">
        {visible.map((e) => (
          <li key={e.sys_id} className={`sn-entry ${e.element}`}>
            <div className="sn-avatar sm">{initials(e.sys_created_by)}</div>
            <div className="sn-entry-body">
              <div className="sn-entry-meta">
                <b>{e.sys_created_by}</b>
                <Link to={recordUrl('incident', e._source_id)} className={`sn-mim-src ${e._source_id === parentId ? 'parent' : ''}`}>
                  {e._source}
                </Link>
                <span className="muted" title={formatDate(e.sys_created_on)}>
                  {timeAgo(e.sys_created_on)}
                </span>
              </div>
              {e.element === 'comms' ? (
                <CommsText value={e.value} />
              ) : e.element === 'audit' ? (
                <div className="sn-entry-text muted">
                  {(JSON.parse(e.value) as { label: string; old: string; new: string }[]).map((c) => `${c.label}: ${c.old || '(empty)'} → ${c.new || '(empty)'}`).join(' · ')}
                </div>
              ) : (
                <div className="sn-entry-text">{e.value}</div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function MajorIncidentWorkbench() {
  const { id = '' } = useParams()
  const now = useNow()
  const [wb, setWb] = useState<Workbench | null>(null)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [kind, setKind] = useState<Kind>('update')
  const [audience, setAudience] = useState(AUDIENCES[0])
  const [text, setText] = useState('')
  const [resolving, setResolving] = useState(false)
  const [closeCode, setCloseCode] = useState(CLOSE_CODES[0]?.value ?? '')
  const [closeNotes, setCloseNotes] = useState('')
  const [sendResolution, setSendResolution] = useState(true)
  const [busy, setBusy] = useState(false)
  usePageTitle(wb ? `Major Incident - ${wb.incident.number}` : 'Major Incident')

  const load = useCallback(async () => {
    try {
      const r = await api.mim.get(id)
      setWb(r)
      setSelected((s) => new Set([...s].filter((x) => r.candidates.some((c) => c.sys_id === x))))
    } catch (e) {
      setErr((e as ApiError).detail || (e as ApiError).message)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  const run = async (fn: () => Promise<string>) => {
    setBusy(true)
    try {
      const text = await fn()
      setMsg({ type: 'success', text })
      await load()
    } catch (e) {
      const er = e as ApiError
      setMsg({ type: 'error', text: `${er.message}${er.detail ? `: ${er.detail}` : ''}` })
    } finally {
      setBusy(false)
    }
  }

  if (err) return <div className="sn-page-pad sn-msg error">{err}</div>
  if (!wb) return <div className="sn-loading">Loading…</div>
  const inc = wb.incident
  const open = isOpen(inc)

  const link = (ids: string[]) =>
    run(async () => {
      const r = await api.mim.link(id, ids)
      setSelected(new Set())
      return `Linked ${r.map((c) => c.number).join(', ')} to ${inc.number}`
    })

  const send = () =>
    run(async () => {
      const r = await api.mim.comms(id, { kind, audience, message: text.trim() })
      setText('')
      return `Stakeholder update sent to ${audience} and posted to ${r.notified} incident${r.notified === 1 ? '' : 's'}`
    })

  const resolve = () =>
    run(async () => {
      if (!closeNotes.trim()) throw new ApiError('Resolution notes are required', '')
      const openKids = wb.children.filter((c) => !['6', '7', '8'].includes(String(c.state))).length
      await api.update('incident', id, { state: '6', close_code: closeCode, close_notes: closeNotes.trim() })
      if (sendResolution) await api.mim.comms(id, { kind: 'resolution', audience, message: template('resolution', wb, closeNotes.trim()) })
      setResolving(false)
      return `${inc.number} resolved along with ${openKids} child incident${openKids === 1 ? '' : 's'}`
    })

  return (
    <div className="sn-dashboard sn-mim">
      <div className={`sn-mim-hero ${open ? '' : 'resolved'}`}>
        <div className="sn-mim-hero-main">
          <div className="sn-mim-hero-tags">
            <span className="sn-mim-tag">{open ? 'Major Incident' : 'Resolved'}</span>
            <Link to={recordUrl('incident', id)} className="sn-mim-number">
              {inc.number}
            </Link>
            <span>{displayValue('incident', inc, 'priority')}</span>
            <span>· {displayValue('incident', inc, 'state')}</span>
          </div>
          <h1>{inc.short_description}</h1>
          <div className="sn-mim-hero-meta">
            <span>
              <Icon name="database" size={13} /> {inc._dv?.cmdb_ci ?? 'No CI'}
            </span>
            <span>
              <Icon name="user" size={13} /> {inc._dv?.assigned_to ?? 'Unassigned'} ({inc._dv?.assignment_group ?? 'no group'})
            </span>
            <span>
              Promoted {timeAgo(String(inc.promoted_on ?? ''))} by {inc._dv?.promoted_by ?? 'System'}
            </span>
          </div>
        </div>
        <div className="sn-mim-hero-clock">
          <div className="muted small">{open ? 'Outage duration' : 'Total duration'}</div>
          <div className="sn-mim-clock big" data-testid="mim-clock">
            {clock(elapsedMs(inc, now))}
          </div>
          <div className="sn-mim-hero-actions">
            <Link className="sn-btn" to={recordUrl('incident', id)}>
              Open record
            </Link>
            {open && (
              <button className="sn-btn success" onClick={() => setResolving((r) => !r)} data-testid="mim-resolve-open">
                Resolve major incident
              </button>
            )}
          </div>
        </div>
      </div>

      {msg && (
        <div className={`sn-msg ${msg.type}`} role="alert" data-testid={`mim-msg-${msg.type}`}>
          <span>{msg.text}</span>
          <button onClick={() => setMsg(null)} aria-label="Dismiss">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      {resolving && open && (
        <div className="sn-widget sn-mim-resolve" data-testid="mim-resolve-panel">
          <h3>Resolve {inc.number}</h3>
          <p className="muted">
            Resolving the major incident also resolves its {wb.children.filter((c) => !['6', '7', '8'].includes(String(c.state))).length} open child incident(s) with the same resolution.
          </p>
          <div className="sn-mim-resolve-row">
            <label>
              Resolution code
              <select className="sn-input" value={closeCode} onChange={(e) => setCloseCode(e.target.value)}>
                {CLOSE_CODES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grow">
              Resolution notes
              <input className="sn-input" value={closeNotes} onChange={(e) => setCloseNotes(e.target.value)} placeholder="What fixed it?" data-testid="mim-close-notes" />
            </label>
          </div>
          <label className="sn-check">
            <input type="checkbox" checked={sendResolution} onChange={(e) => setSendResolution(e.target.checked)} /> Send resolution update to {audience}
          </label>
          <div className="sn-mim-resolve-row end">
            <button className="sn-btn" onClick={() => setResolving(false)}>
              Cancel
            </button>
            <button className="sn-btn success" disabled={busy || !closeNotes.trim()} onClick={resolve} data-testid="mim-resolve-confirm">
              Resolve all
            </button>
          </div>
        </div>
      )}

      <div className="sn-kpis sn-mim-kpis">
        <div className="sn-kpi red">
          <div className="sn-kpi-value">
            <NextUpdate inc={inc} now={now} big />
          </div>
          <div className="sn-kpi-label">Next stakeholder update ({MIM_UPDATE_CADENCE_MIN} min cadence)</div>
        </div>
        <div className="sn-kpi amber">
          <div className="sn-kpi-value">
            {inc._open_children}
            <span className="muted small"> / {inc._children}</span>
          </div>
          <div className="sn-kpi-label">Open child incidents</div>
        </div>
        <div className="sn-kpi blue">
          <div className="sn-kpi-value">{inc._affected_users}</div>
          <div className="sn-kpi-label">Affected users reporting</div>
        </div>
        <div className="sn-kpi">
          <div className="sn-kpi-value">{inc._comms}</div>
          <div className="sn-kpi-label">Stakeholder updates sent</div>
        </div>
        <div className="sn-kpi">
          <div className="sn-kpi-value">{wb.candidates.length}</div>
          <div className="sn-kpi-label">Suggested related incidents</div>
        </div>
      </div>

      <div className="sn-mim-grid">
        <div className="sn-mim-col">
          <div className="sn-widget">
            <h3>Business impact</h3>
            <p className="sn-mim-impact">{inc.business_impact || <span className="muted">Not captured. Add it on the incident form, Major Incident tab.</span>}</p>
          </div>

          <div className="sn-widget">
            <h3>
              Child incidents <span className="muted">{wb.children.length}</span>
            </h3>
            {wb.children.length === 0 ? (
              <div className="muted">No child incidents yet. Link suggested incidents below.</div>
            ) : (
              <table className="sn-mim-table" data-testid="mim-children">
                <tbody>
                  {wb.children.map((c) => (
                    <tr key={c.sys_id}>
                      <td>
                        <Link to={recordUrl('incident', c.sys_id)} className="sn-link">
                          {c.number}
                        </Link>
                      </td>
                      <td>{c.short_description}</td>
                      <td className="muted">{c._dv?.caller_id}</td>
                      <td>
                        <span className={`sn-mim-state s${c.state}`}>{displayValue('incident', c, 'state')}</span>
                      </td>
                      <td>
                        {open && (
                          <button className="sn-btn small" disabled={busy} onClick={() => run(async () => (await api.mim.unlink(id, c.sys_id), `Unlinked ${c.number}`))}>
                            Unlink
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {open && (
            <div className="sn-widget" data-testid="mim-candidates">
              <h3>
                Suggested related incidents
                <span className="sn-mim-actions">
                  <button className="sn-btn small" disabled={busy || selected.size === 0} onClick={() => link([...selected])} data-testid="mim-link-selected">
                    Link selected ({selected.size})
                  </button>
                  <button className="sn-btn small primary" disabled={busy || wb.candidates.length === 0} onClick={() => link(wb.candidates.map((c) => c.sys_id))}>
                    Link all
                  </button>
                </span>
              </h3>
              {wb.candidates.length === 0 ? (
                <div className="muted">No open, unlinked incidents match this CI or category.</div>
              ) : (
                <ul className="sn-mim-cands">
                  {wb.candidates.map((c) => (
                    <li key={c.sys_id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={selected.has(c.sys_id)}
                          onChange={(e) => {
                            const s = new Set(selected)
                            if (e.target.checked) s.add(c.sys_id)
                            else s.delete(c.sys_id)
                            setSelected(s)
                          }}
                        />
                        <span className="grow">
                          <Link to={recordUrl('incident', c.sys_id)} className="sn-link">
                            {c.number}
                          </Link>{' '}
                          {c.short_description}
                          <small className="muted">
                            {' '}
                            · {c._dv?.caller_id} · opened {timeAgo(String(c.opened_at ?? ''))}
                          </small>
                          <span className="sn-mim-reasons">
                            {c._reasons.map((r) => (
                              <span key={r}>{r}</span>
                            ))}
                          </span>
                        </span>
                      </label>
                      <button className="sn-btn small" disabled={busy} onClick={() => link([c.sys_id])}>
                        Link
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="sn-mim-col">
          {open && (
            <div className="sn-widget sn-mim-comms" data-testid="mim-comms">
              <h3>Stakeholder communication</h3>
              <div className="sn-mim-templates">
                {(['initial', 'update', 'resolution'] as const).map((k) => (
                  <button
                    key={k}
                    className={`sn-btn small ${kind === k ? 'primary' : ''}`}
                    onClick={() => {
                      setKind(k)
                      setText(template(k, wb))
                    }}
                    data-testid={`mim-template-${k}`}
                  >
                    {k === 'initial' ? 'Initial notice' : k === 'update' ? 'Status update' : 'Resolution notice'}
                  </button>
                ))}
                <select className="sn-input" value={audience} onChange={(e) => setAudience(e.target.value)} aria-label="Audience">
                  {AUDIENCES.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              </div>
              <textarea className="sn-input" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Pick a template or write an update…" data-testid="mim-comms-text" />
              <div className="sn-compose-bar">
                <span className="muted small">Posted to the major incident and as a comment on every child incident, so each caller sees it in the portal.</span>
                <button className="sn-btn primary" disabled={busy || !text.trim()} onClick={send} data-testid="mim-comms-send">
                  Send update
                </button>
              </div>
            </div>
          )}
          <Timeline entries={wb.timeline} parentId={id} />
        </div>
      </div>
    </div>
  )
}
