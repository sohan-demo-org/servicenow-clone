import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { getField } from '../../shared/schema.ts'
import { ApiError, api } from '../api.ts'
import type { Rec } from '../api.ts'
import { useAuth } from '../auth.tsx'
import { Icon } from '../components/Icon.tsx'
import { usePageTitle } from '../components/Layout.tsx'
import { PriorityDot } from '../components/ListTable.tsx'
import { formatHours, initials, listUrl, recordUrl, slaInfo } from '../util.ts'

const COLUMNS = [
  { state: '1', label: 'New' },
  { state: '2', label: 'In Progress' },
  { state: '3', label: 'On Hold' },
  { state: '6', label: 'Resolved' },
]
const COLUMN_STATES = COLUMNS.map((c) => c.state)
const PRIORITIES = ['1', '2', '3', '4', '5']
const RESOLVED_LIMIT = 25
const REFRESH_MS = 15000

type Lanes = 'none' | 'priority' | 'assignment_group'
type SlaFilter = '' | 'breached' | 'risk'

interface Lane {
  key: string
  label: string
  rows: Rec[]
}

const stateLabel = (s: string) => COLUMNS.find((c) => c.state === s)?.label ?? s

function SlaChip({ rec, now }: { rec: Rec; now: number }) {
  const sla = slaInfo(rec, now)
  if (!sla) return null
  const text = sla.stopped ? (sla.breached ? 'SLA breached' : 'SLA met') : sla.breached ? `-${formatHours(sla.left)}` : formatHours(sla.left)
  return (
    <span className={`sn-kb-sla ${sla.tone}`} title={`Resolution SLA: ${sla.hours}h target, ${sla.pct}% elapsed`} data-testid="sla-chip">
      <Icon name="clock" size={12} />
      {text}
    </span>
  )
}

function ResolveDialog({ rec, onCancel, onSubmit }: { rec: Rec; onCancel: () => void; onSubmit: (code: string, notes: string) => void }) {
  const codes = getField('incident', 'close_code')?.choices ?? []
  const [code, setCode] = useState(codes[0]?.value ?? '')
  const [notes, setNotes] = useState('')
  return (
    <div className="sn-modal-backdrop" onClick={onCancel}>
      <form
        className="sn-modal"
        role="dialog"
        aria-label="Resolve incident"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (code && notes.trim()) onSubmit(code, notes.trim())
        }}
      >
        <h2>
          Resolve {String(rec.number)}
          <button type="button" className="sn-icon-btn dark" onClick={onCancel} aria-label="Close">
            <Icon name="close" />
          </button>
        </h2>
        <p className="muted">{String(rec.short_description)}</p>
        <label>
          <span>
            <span className="sn-mand">*</span>Resolution code
          </span>
          <select className="sn-input" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Resolution code">
            {codes.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>
            <span className={`sn-mand ${notes.trim() ? 'filled' : ''}`}>*</span>Resolution notes
          </span>
          <textarea autoFocus className="sn-input" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Resolution notes" />
        </label>
        <div className="sn-modal-actions">
          <button type="button" className="sn-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="sn-btn primary" disabled={!code || !notes.trim()}>
            Resolve
          </button>
        </div>
      </form>
    </div>
  )
}

export function IncidentBoard() {
  usePageTitle('Incident Board')
  const { user } = useAuth()
  const navigate = useNavigate()
  const [sp, setSp] = useSearchParams()
  const [rows, setRows] = useState<Rec[] | null>(null)
  const [groups, setGroups] = useState<Rec[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCell, setOverCell] = useState<string | null>(null)
  const [resolving, setResolving] = useState<{ rec: Rec; extra: Record<string, unknown> } | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const busy = useRef(false)
  useEffect(() => {
    busy.current = Boolean(dragId || resolving)
  }, [dragId, resolving])

  const group = sp.get('group') ?? ''
  const mine = sp.get('mine') === '1'
  const lanes = (sp.get('lanes') ?? 'none') as Lanes
  const slaFilter = (sp.get('sla') ?? '') as SlaFilter
  const pris = useMemo(() => new Set((sp.get('pri') ?? '').split(',').filter(Boolean)), [sp])
  const text = sp.get('q') ?? ''

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(sp)
    if (value) next.set(key, value)
    else next.delete(key)
    setSp(next, { replace: true })
  }

  const load = useCallback(async () => {
    const [active, resolved] = await Promise.all([
      api.list('incident', { query: 'stateIN1,2,3^ORDERBYpriority^ORDERBYopened_at', limit: 500 }),
      api.list('incident', { query: `state=6^ORDERBYDESCresolved_at`, limit: RESOLVED_LIMIT }),
    ])
    setRows([...active.result, ...resolved.result])
  }, [])

  useEffect(() => {
    load()
    api.list('sys_user_group', { limit: 100 }).then((r) => setGroups(r.result))
    const poll = setInterval(() => {
      if (!busy.current && document.visibilityState === 'visible') load()
    }, REFRESH_MS)
    const tick = setInterval(() => setNow(Date.now()), 30000)
    return () => {
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [load])

  useEffect(() => {
    if (!msg) return
    const t = setTimeout(() => setMsg(null), 4000)
    return () => clearTimeout(t)
  }, [msg])

  const visible = useMemo(() => {
    const q = text.trim().toLowerCase()
    return (rows ?? []).filter((r) => {
      if (group && r.assignment_group !== group) return false
      if (mine && r.assigned_to !== user?.sys_id) return false
      if (pris.size && !pris.has(String(r.priority))) return false
      if (slaFilter && String(r.state) !== '6') {
        const sla = slaInfo(r, now)
        if (slaFilter === 'breached' && !sla?.breached) return false
        if (slaFilter === 'risk' && sla?.tone !== 'warn') return false
      } else if (slaFilter) return false
      if (q && !`${r.number} ${r.short_description} ${r._dv?.caller_id ?? ''} ${r._dv?.cmdb_ci ?? ''} ${r._dv?.assigned_to ?? ''}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [rows, group, mine, pris, slaFilter, text, user, now])

  const stats = useMemo(() => {
    const active = visible.filter((r) => String(r.state) !== '6')
    const infos = active.map((r) => slaInfo(r, now))
    return {
      active: active.length,
      breached: infos.filter((s) => s?.breached).length,
      risk: infos.filter((s) => s?.tone === 'warn').length,
      unassigned: active.filter((r) => !r.assigned_to).length,
    }
  }, [visible, now])

  const laneList: Lane[] = useMemo(() => {
    if (lanes === 'priority') {
      return PRIORITIES.map((p) => ({ key: p, label: getField('incident', 'priority')?.choices?.find((c) => c.value === p)?.label ?? p, rows: visible.filter((r) => String(r.priority) === p) })).filter(
        (l) => l.rows.length,
      )
    }
    if (lanes === 'assignment_group') {
      const keys = [...new Set(visible.map((r) => String(r.assignment_group ?? '')))]
      return keys
        .map((k) => ({ key: k, label: k ? (visible.find((r) => r.assignment_group === k)?._dv?.assignment_group ?? k) : '(no group)', rows: visible.filter((r) => String(r.assignment_group ?? '') === k) }))
        .sort((a, b) => a.label.localeCompare(b.label))
    }
    return [{ key: '', label: '', rows: visible }]
  }, [visible, lanes])

  async function apply(rec: Rec, body: Record<string, unknown>, dv: Record<string, string> = {}) {
    const before = rows
    setRows((rs) => (rs ?? []).map((r) => (r.sys_id === rec.sys_id ? ({ ...r, ...body, _dv: { ...r._dv, ...dv } } as Rec) : r)))
    try {
      const updated = await api.update('incident', rec.sys_id, body)
      setRows((rs) => (rs ?? []).map((r) => (r.sys_id === rec.sys_id ? updated : r)))
      setFlashId(rec.sys_id)
      const parts: string[] = []
      if (String(updated.state) !== String(rec.state)) parts.push(`moved to ${stateLabel(String(updated.state))}`)
      if (updated.assignment_group !== rec.assignment_group) parts.push(`reassigned to ${updated._dv?.assignment_group ?? 'no group'}`)
      if (updated.assigned_to !== rec.assigned_to) parts.push(`assigned to ${updated._dv?.assigned_to || 'nobody'}`)
      setMsg({ kind: 'success', text: `${rec.number} ${parts.join(', ') || 'updated'}` })
    } catch (e) {
      setRows(before)
      setMsg({ kind: 'error', text: e instanceof ApiError ? `${e.message}${e.detail ? `: ${e.detail}` : ''}` : String(e) })
    }
  }

  function move(rec: Rec, toState: string, laneKey?: string) {
    const extra: Record<string, unknown> = {}
    const dv: Record<string, string> = {}
    if (lanes === 'assignment_group' && laneKey !== undefined && laneKey !== String(rec.assignment_group ?? '')) {
      extra.assignment_group = laneKey || null
      extra.assigned_to = null
      dv.assignment_group = laneList.find((l) => l.key === laneKey)?.label ?? ''
      dv.assigned_to = ''
    }
    const stateChanged = toState !== String(rec.state)
    if (!stateChanged && !Object.keys(extra).length) return
    if (stateChanged && toState === '6') {
      setResolving({ rec, extra })
      return
    }
    apply(rec, stateChanged ? { ...extra, state: toState } : extra, dv)
  }

  const recOf = (id: string | null) => rows?.find((r) => r.sys_id === id)

  const onDrop = (e: DragEvent, state: string, laneKey: string) => {
    e.preventDefault()
    const rec = recOf(e.dataTransfer.getData('text/plain') || dragId)
    setDragId(null)
    setOverCell(null)
    if (rec) move(rec, state, laneKey)
  }

  const onCardKey = (e: KeyboardEvent, rec: Rec) => {
    if (e.key === 'Enter') navigate(recordUrl('incident', rec.sys_id))
    if (e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault()
      const idx = COLUMN_STATES.indexOf(String(rec.state)) + (e.key === 'ArrowRight' ? 1 : -1)
      if (idx >= 0 && idx < COLUMN_STATES.length) move(rec, COLUMN_STATES[idx])
    }
  }

  const togglePri = (p: string) => {
    const next = new Set(pris)
    if (next.has(p)) next.delete(p)
    else next.add(p)
    setParam('pri', [...next].sort().join(','))
  }

  const renderCard = (r: Rec) => {
    const assignee = r._dv?.assigned_to ?? ''
    return (
      <div
        key={r.sys_id}
        className={`sn-kb-card p${r.priority} ${dragId === r.sys_id ? 'dragging' : ''} ${flashId === r.sys_id ? 'flash' : ''}`}
        draggable
        tabIndex={0}
        data-testid={`card-${r.number}`}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', r.sys_id)
          e.dataTransfer.effectAllowed = 'move'
          setDragId(r.sys_id)
        }}
        onDragEnd={() => {
          setDragId(null)
          setOverCell(null)
        }}
        onAnimationEnd={() => setFlashId(null)}
        onKeyDown={(e) => onCardKey(e, r)}
        title="Drag to change state (or focus and press Shift+Arrow)"
      >
        <div className="sn-kb-card-top">
          <span className="sn-pri" title={getField('incident', 'priority')?.choices?.find((c) => c.value === String(r.priority))?.label}>
            <PriorityDot value={String(r.priority)} />
            <b>P{String(r.priority)}</b>
          </span>
          <Link className="sn-link" to={recordUrl('incident', r.sys_id)} draggable={false}>
            {String(r.number)}
          </Link>
          <SlaChip rec={r} now={now} />
        </div>
        <div className="sn-kb-card-desc">{String(r.short_description ?? '')}</div>
        <div className="sn-kb-card-meta muted small">
          {r._dv?.cmdb_ci && <span>{r._dv.cmdb_ci}</span>}
          {r._dv?.caller_id && <span>{r._dv.caller_id}</span>}
        </div>
        <div className="sn-kb-card-foot">
          {lanes !== 'assignment_group' && r._dv?.assignment_group && <span className="sn-kb-tag">{r._dv.assignment_group}</span>}
          {assignee ? (
            <span className="sn-kb-assignee" title={`Assigned to ${assignee}`}>
              <span className="sn-avatar sm">{initials(assignee)}</span>
            </span>
          ) : String(r.state) !== '6' ? (
            <button className="sn-btn small sn-kb-claim" onClick={() => apply(r, { assigned_to: user?.sys_id }, { assigned_to: String(user?.name ?? '') })}>
              Assign to me
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="sn-kb-page">
      <div className="sn-titlebar">
        <h1>Incident Board</h1>
        <div className="sn-titlebar-right sn-kb-controls">
          <input className="sn-input" placeholder="Search cards" aria-label="Search cards" value={text} onChange={(e) => setParam('q', e.target.value)} />
          <select className="sn-input" aria-label="Assignment group" value={group} onChange={(e) => setParam('group', e.target.value)}>
            <option value="">All groups</option>
            {groups.map((g) => (
              <option key={g.sys_id} value={g.sys_id}>
                {String(g.name)}
              </option>
            ))}
          </select>
          <div className="sn-seg" role="group" aria-label="Priority filter">
            {PRIORITIES.map((p) => (
              <button key={p} className={pris.has(p) ? 'on' : ''} onClick={() => togglePri(p)} aria-pressed={pris.has(p)}>
                P{p}
              </button>
            ))}
          </div>
          <label className="sn-check">
            <input type="checkbox" checked={mine} onChange={(e) => setParam('mine', e.target.checked ? '1' : '')} />
            Assigned to me
          </label>
          <select className="sn-input" aria-label="Swimlanes" value={lanes} onChange={(e) => setParam('lanes', e.target.value === 'none' ? '' : e.target.value)}>
            <option value="none">No swimlanes</option>
            <option value="priority">Swimlanes: Priority</option>
            <option value="assignment_group">Swimlanes: Assignment group</option>
          </select>
          <Link className="sn-btn" to={listUrl('incident', 'stateNOTIN6,7,8')}>
            <Icon name="list" size={14} /> List view
          </Link>
        </div>
      </div>

      {msg && (
        <div className={`sn-msg ${msg.kind}`} role="status" data-testid="board-msg">
          <span>{msg.text}</span>
          <button onClick={() => setMsg(null)} aria-label="Dismiss">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      <div className="sn-kb-stats">
        <div className="sn-kb-stat">
          <b>{stats.active}</b> active
        </div>
        <button className={`sn-kb-stat bad ${slaFilter === 'breached' ? 'on' : ''}`} onClick={() => setParam('sla', slaFilter === 'breached' ? '' : 'breached')} data-testid="stat-breached">
          <b>{stats.breached}</b> SLA breached
        </button>
        <button className={`sn-kb-stat warn ${slaFilter === 'risk' ? 'on' : ''}`} onClick={() => setParam('sla', slaFilter === 'risk' ? '' : 'risk')} data-testid="stat-risk">
          <b>{stats.risk}</b> at risk
        </button>
        <div className="sn-kb-stat">
          <b>{stats.unassigned}</b> unassigned
        </div>
        <span className="muted small sn-kb-hint">Drag cards between columns · Shift+Arrow on a focused card · auto-refreshes every {REFRESH_MS / 1000}s</span>
      </div>

      {!rows ? (
        <div className="sn-empty-state">Loading…</div>
      ) : (
        <div className="sn-kb-board">
          <div className="sn-kb-head">
            {COLUMNS.map((c) => {
              const colRows = visible.filter((r) => String(r.state) === c.state)
              const breached = c.state === '6' ? 0 : colRows.filter((r) => slaInfo(r, now)?.breached).length
              return (
                <div key={c.state} className={`sn-kb-col-head s-incident-${c.state}`}>
                  <span className={`sn-state s-incident-${c.state}`}>{c.label}</span>
                  <span className="sn-kb-count">{colRows.length}</span>
                  {breached > 0 && <span className="sn-kb-breach">{breached} breached</span>}
                  {c.state === '6' && <span className="muted small">latest {RESOLVED_LIMIT}</span>}
                </div>
              )
            })}
          </div>
          {laneList.map((lane) => (
            <div key={lane.key} className="sn-kb-lane" data-testid={lanes === 'none' ? undefined : `lane-${lane.label}`}>
              {lanes !== 'none' && (
                <div className="sn-kb-lane-title">
                  {lanes === 'priority' && <PriorityDot value={lane.key} />}
                  {lane.label} <span className="muted">({lane.rows.length})</span>
                </div>
              )}
              <div className="sn-kb-cols">
                {COLUMNS.map((c) => {
                  const cell = `${lane.key}|${c.state}`
                  const cards = lane.rows.filter((r) => String(r.state) === c.state)
                  return (
                    <div
                      key={c.state}
                      className={`sn-kb-col ${overCell === cell ? 'over' : ''}`}
                      data-testid={`col-${c.label}${lanes === 'none' ? '' : `-${lane.label}`}`}
                      onDragOver={(e) => {
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        if (overCell !== cell) setOverCell(cell)
                      }}
                      onDragLeave={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverCell(null)
                      }}
                      onDrop={(e) => onDrop(e, c.state, lane.key)}
                    >
                      {cards.map(renderCard)}
                      {!cards.length && <div className="sn-kb-empty">Drop here</div>}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
          {!visible.length && <div className="sn-empty-state">No incidents match these filters.</div>}
        </div>
      )}

      {resolving && (
        <ResolveDialog
          rec={resolving.rec}
          onCancel={() => setResolving(null)}
          onSubmit={(code, notes) => {
            const { rec, extra } = resolving
            setResolving(null)
            apply(rec, { ...extra, state: '6', close_code: code, close_notes: notes })
          }}
        />
      )}
    </div>
  )
}
