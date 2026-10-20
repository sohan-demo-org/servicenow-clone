import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { choiceLabel } from '../../shared/schema.ts'
import { ApiError, api } from '../api.ts'
import type { ChangeScheduleData, Conflict, Rec } from '../api.ts'
import { Icon } from '../components/Icon.tsx'
import { usePageTitle } from '../components/Layout.tsx'
import { isAgent, useAuth } from '../auth.tsx'
import { listUrl, nowStr, parseDate, recordUrl } from '../util.ts'

const HOUR = 3600000
const DAY = 24 * HOUR
const SNAP = HOUR / 2
const LABEL_W = 230
const LANE_H = 34
const INACTIVE = ['3', '4']

interface Pending {
  id: string
  start: number
  end: number
  conflicts: Conflict[] | null
  source: 'drag' | 'suggest'
}

interface Drag {
  id: string
  x0: number
  start: number
  end: number
  offset: number
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const ms = (v: unknown) => parseDate(String(v ?? ''))?.getTime() ?? NaN
const fmtDay = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
const fmtDayShort = (d: Date) => `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getDate()}`
const ROW_PAD = 18
const LABEL_MAX = 230
const barLabel = (c: Rec) => `${c.number} ${c.short_description ?? ''}`
const labelPx = (c: Rec) => Math.min(LABEL_MAX, barLabel(c).length * 6.6 + 26)
const fmtWhen = (t: number) => {
  const d = new Date(t)
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`
}
const fmtDur = (m: number) => {
  const h = m / HOUR
  return h >= 24 ? `${Math.floor(h / 24)}d ${Math.round(h % 24)}h` : `${Math.round(h * 10) / 10}h`
}

function ConflictList({ conflicts }: { conflicts: Conflict[] }) {
  return (
    <ul className="cs-conflicts">
      {conflicts.map((c, i) => (
        <li key={i} className={`cs-conflict ${c.type}`}>
          <b>{c.label}</b>
          <span>{c.message}</span>
          {c.related && (
            <Link className="sn-link-subtle small" to={recordUrl(c.related.table, c.related.sys_id)}>
              {c.related.display} · {fmtWhen(ms(c.related.start_date))} → {fmtWhen(ms(c.related.end_date))}
            </Link>
          )}
        </li>
      ))}
    </ul>
  )
}

export function ChangeSchedule() {
  usePageTitle('Change Schedule')
  const { user } = useAuth()
  const agent = isAgent(user)
  const [sp, setSp] = useSearchParams()
  const focus = sp.get('focus')
  const [rangeStart, setRangeStart] = useState(() => startOfDay(new Date(Date.now() - DAY)).getTime())
  const [days, setDays] = useState(14)
  const [data, setData] = useState<ChangeScheduleData | null>(null)
  const [selected, setSelected] = useState<string | null>(focus)
  const [showInactive, setShowInactive] = useState(false)
  const [conflictsOnly, setConflictsOnly] = useState(false)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [dragConflicts, setDragConflicts] = useState<Conflict[] | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [width, setWidth] = useState(900)
  const gridRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => Date.now())
  const rangeEnd = rangeStart + days * DAY
  const pxPerMs = width / (days * DAY)

  useLayoutEffect(() => {
    const el = gridRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.max(400, el.clientWidth - LABEL_W)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(t)
  }, [])

  const load = useCallback(async () => {
    const r = await api.changeSchedule(nowStr(new Date(rangeStart)), nowStr(new Date(rangeEnd)))
    setData(r)
    return r
  }, [rangeStart, rangeEnd])

  useEffect(() => {
    load()
  }, [load])

  // Deep link from a change form: jump the window to that change.
  useEffect(() => {
    if (!focus) return
    api
      .get('change_request', focus)
      .then((r) => {
        const s = ms(r.start_date)
        if (!Number.isNaN(s)) setRangeStart(startOfDay(new Date(s - DAY)).getTime())
        setSelected(focus)
      })
      .catch(() => {})
  }, [focus])

  const byId = useMemo(() => new Map((data?.changes ?? []).map((c) => [c.sys_id, c])), [data])
  const conflictsOf = useCallback((id: string) => data?.conflicts[id] ?? [], [data])

  const visible = useMemo(
    () =>
      (data?.changes ?? []).filter((c) => (showInactive || !INACTIVE.includes(String(c.state))) && (!conflictsOnly || conflictsOf(c.sys_id).length > 0)),
    [data, showInactive, conflictsOnly, conflictsOf],
  )

  const rows = useMemo(() => {
    const m = new Map<string, { key: string; label: string; ciClass: string; changes: Rec[]; lanes: Map<string, number>; laneCount: number }>()
    const row = (key: string, label: string) => {
      if (!m.has(key)) m.set(key, { key, label, ciClass: '', changes: [], lanes: new Map(), laneCount: 1 })
      return m.get(key)!
    }
    for (const c of visible) row(String(c.cmdb_ci ?? ''), c._dv?.cmdb_ci || '(No configuration item)').changes.push(c)
    for (const b of data?.blackouts ?? []) if (b.cmdb_ci && !conflictsOnly) row(String(b.cmdb_ci), b._dv?.cmdb_ci ?? '')
    for (const r of m.values()) {
      const laneEnds: number[] = []
      for (const c of [...r.changes].sort((a, b) => ms(a.start_date) - ms(b.start_date))) {
        const s = ms(c.start_date)
        const barPx = (ms(c.end_date) - s) * pxPerMs
        const extentPx = barPx >= labelPx(c) + 16 ? barPx : barPx + 6 + labelPx(c)
        let lane = laneEnds.findIndex((e) => e <= s)
        if (lane < 0) lane = laneEnds.length
        laneEnds[lane] = s + extentPx / pxPerMs
        r.lanes.set(c.sys_id, lane)
      }
      r.laneCount = Math.max(1, laneEnds.length)
    }
    return [...m.values()].sort((a, b) => {
      const first = (r: typeof a) => Math.min(...r.changes.map((c) => ms(c.start_date)), Infinity)
      return first(a) - first(b) || a.label.localeCompare(b.label)
    })
  }, [visible, data, conflictsOnly, pxPerMs])

  const x = (t: number) => (t - rangeStart) * pxPerMs
  const conflictedCount = (data?.changes ?? []).filter((c) => conflictsOf(c.sys_id).length > 0).length
  const activeCount = (data?.changes ?? []).filter((c) => !INACTIVE.includes(String(c.state))).length

  // Live conflict preview while dragging (debounced).
  const dragId = drag && drag.offset !== 0 ? drag.id : null
  const dragStart = drag ? drag.start + drag.offset : 0
  const dragEnd = drag ? drag.end + drag.offset : 0
  useEffect(() => {
    if (!dragId) return
    const c = byId.get(dragId)
    const t = setTimeout(() => {
      api
        .changeConflicts({ sys_id: dragId, cmdb_ci: c?.cmdb_ci as string, assigned_to: c?.assigned_to as string, start_date: nowStr(new Date(dragStart)), end_date: nowStr(new Date(dragEnd)) })
        .then(setDragConflicts)
        .catch(() => {})
    }, 120)
    return () => clearTimeout(t)
  }, [dragId, dragStart, dragEnd, byId])

  const onPointerDown = (e: ReactPointerEvent, c: Rec) => {
    if (e.button !== 0) return
    e.preventDefault()
    if (!agent || INACTIVE.includes(String(c.state)) || pending) {
      setSelected(c.sys_id)
      return
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setDragConflicts(null)
    setDrag({ id: c.sys_id, x0: e.clientX, start: ms(c.start_date), end: ms(c.end_date), offset: 0 })
  }
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag) return
    const offset = Math.round((e.clientX - drag.x0) / pxPerMs / SNAP) * SNAP
    if (offset !== drag.offset) setDrag({ ...drag, offset })
  }
  const onPointerUp = () => {
    if (!drag) return
    const d = drag
    setDrag(null)
    setSelected(d.id)
    if (d.offset === 0) return
    setPending({ id: d.id, start: d.start + d.offset, end: d.end + d.offset, conflicts: dragConflicts, source: 'drag' })
    const c = byId.get(d.id)
    api
      .changeConflicts({ sys_id: d.id, cmdb_ci: c?.cmdb_ci as string, assigned_to: c?.assigned_to as string, start_date: nowStr(new Date(d.start + d.offset)), end_date: nowStr(new Date(d.end + d.offset)) })
      .then((conflicts) => setPending((p) => (p && p.id === d.id ? { ...p, conflicts } : p)))
      .catch(() => {})
  }

  const suggest = async (id: string) => {
    setMsg(null)
    try {
      const w = await api.nextWindow(id)
      const start = ms(w.start_date)
      const end = ms(w.end_date)
      setPending({ id, start, end, conflicts: [], source: 'suggest' })
      if (start < rangeStart || end > rangeEnd) setRangeStart(startOfDay(new Date(start - DAY)).getTime())
    } catch (e) {
      setMsg({ type: 'error', text: (e as ApiError).message })
    }
  }

  const confirm = async () => {
    if (!pending) return
    const c = byId.get(pending.id)
    setBusy(true)
    try {
      const from = `${fmtWhen(ms(c?.start_date))} → ${fmtWhen(ms(c?.end_date))}`
      const to = `${fmtWhen(pending.start)} → ${fmtWhen(pending.end)}`
      const r = await api.update('change_request', pending.id, {
        start_date: nowStr(new Date(pending.start)),
        end_date: nowStr(new Date(pending.end)),
        work_notes: `Rescheduled on the Change Schedule${pending.source === 'suggest' ? ' (next conflict-free window)' : ''}.\nFrom: ${from}\nTo: ${to}`,
      })
      setPending(null)
      await load()
      setMsg({
        type: 'success',
        text: `${r.number} rescheduled to ${to}. ${r.conflict_status === 'conflict' ? 'It still has scheduling conflicts.' : 'No scheduling conflicts.'}`,
      })
    } catch (e) {
      const err = e as ApiError
      setMsg({ type: 'error', text: `${err.message}${err.detail ? `: ${err.detail}` : ''}` })
    } finally {
      setBusy(false)
    }
  }

  const shift = (n: number) => {
    setPending(null)
    setRangeStart((s) => s + n * DAY)
  }
  const selectedRec = selected ? byId.get(selected) : undefined
  const clearFocus = () => {
    if (focus) {
      sp.delete('focus')
      setSp(sp, { replace: true })
    }
  }

  const dayTicks = Array.from({ length: days }, (_, i) => new Date(rangeStart + i * DAY))
  const gridH = rows.reduce((h, r) => h + r.laneCount * LANE_H + ROW_PAD, 0)

  const renderBar = (c: Rec, lane: number) => {
    const inactive = INACTIVE.includes(String(c.state))
    const conflicts = conflictsOf(c.sys_id)
    const s = ms(c.start_date)
    const e = ms(c.end_date)
    const isDrag = drag?.id === c.sys_id && drag.offset !== 0
    const isPending = pending?.id === c.sys_id
    const ghost = isDrag ? { s: s + drag.offset, e: e + drag.offset, bad: (dragConflicts?.length ?? 0) > 0 } : isPending ? { s: pending.start, e: pending.end, bad: (pending.conflicts?.length ?? 0) > 0 } : null
    const top = 6 + lane * LANE_H
    const left = Math.max(0, x(s))
    const right = Math.min(width, x(e))
    const barW = Math.max(8, right - left)
    const inside = barW >= labelPx(c) + 16
    return (
      <div key={c.sys_id}>
        {right > 0 && left < width && (
          <div
            className={`cs-bar t-${c.type} ${conflicts.length ? 'conflict' : ''} ${inactive ? 'inactive' : ''} ${selected === c.sys_id ? 'selected' : ''} ${ghost ? 'moving' : ''} ${barW < 34 ? 'narrow' : ''}`}
            style={{ top, left, width: barW }}
            onPointerDown={(ev) => onPointerDown(ev, c)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => setDrag(null)}
            title={`${c.number}: ${c.short_description}\n${fmtWhen(s)} → ${fmtWhen(e)}${conflicts.length ? `\n${conflicts.length} conflict(s)` : ''}`}
            data-testid={`cs-bar-${c.number}`}
          >
            {conflicts.length > 0 && <span className="cs-warn">!</span>}
            {inside && (
              <>
                <b>{c.number}</b> <span className="cs-bar-text">{c.short_description}</span>
              </>
            )}
          </div>
        )}
        {!inside && right > 0 && left < width && !ghost && (
          <span className={`cs-bar-label ${conflicts.length ? 'conflict' : ''} ${inactive ? 'inactive' : ''}`} style={{ top, left: left + barW + 6, maxWidth: LABEL_MAX }} onClick={() => setSelected(c.sys_id)}>
            <b>{c.number}</b> {c.short_description}
          </span>
        )}
        {ghost && (
          <div className={`cs-ghost ${ghost.bad ? 'bad' : 'ok'}`} style={{ top, left: x(ghost.s), width: Math.max(8, x(ghost.e) - x(ghost.s)) }} data-testid="cs-ghost">
            <span>
              {fmtWhen(ghost.s)} → {new Date(ghost.e).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}
              {isDrag && dragConflicts && (dragConflicts.length ? ` · ${dragConflicts.length} conflict${dragConflicts.length > 1 ? 's' : ''}` : ' · clear')}
            </span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="cs-page">
      <div className="sn-titlebar">
        <h1>Change Schedule</h1>
        <div className="cs-range">
          <button className="sn-icon-btn dark" onClick={() => shift(-7)} aria-label="Previous week">
            <Icon name="chevronLeft" size={18} />
          </button>
          <button className="sn-btn small" onClick={() => { setPending(null); setRangeStart(startOfDay(new Date(Date.now() - DAY)).getTime()) }}>
            Today
          </button>
          <button className="sn-icon-btn dark" onClick={() => shift(7)} aria-label="Next week">
            <Icon name="chevronRight" size={18} />
          </button>
          <span className="cs-range-label">
            {fmtDay(new Date(rangeStart))} – {fmtDay(new Date(rangeEnd - 1))}
          </span>
        </div>
        <div className="sn-titlebar-right">
          <label className="sn-check small">
            <input type="checkbox" checked={conflictsOnly} onChange={(e) => setConflictsOnly(e.target.checked)} data-testid="cs-conflicts-only" /> Conflicts only
          </label>
          <label className="sn-check small">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show closed / canceled
          </label>
          <div className="sn-seg">
            {[7, 14, 28].map((d) => (
              <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>
                {d === 7 ? '1 week' : d === 14 ? '2 weeks' : '4 weeks'}
              </button>
            ))}
          </div>
          <Link className="sn-btn primary" to={recordUrl('change_request', '-1')}>
            New Change
          </Link>
        </div>
      </div>

      <div className="cs-summary">
        <div className="cs-chip">
          <b>{activeCount}</b> active changes in view
        </div>
        <button className={`cs-chip ${conflictedCount ? 'bad' : 'ok'}`} onClick={() => setConflictsOnly((v) => !v)} data-testid="cs-conflict-count">
          <b>{conflictedCount}</b> with conflicts
        </button>
        <Link className="cs-chip blackout" to={listUrl('cmn_schedule_blackout')}>
          <b>{data?.blackouts.length ?? 0}</b> blackout windows
        </Link>
        <div className="cs-legend">
          <span className="t-normal">Normal</span>
          <span className="t-standard">Standard</span>
          <span className="t-emergency">Emergency</span>
          <span className="lg-conflict">Conflict</span>
          <span className="lg-blackout">Blackout</span>
          {agent && <span className="muted small">Drag a bar to reschedule</span>}
        </div>
      </div>

      {msg && (
        <div className={`sn-msg ${msg.type}`} role="alert" data-testid={`msg-${msg.type}`}>
          <span>{msg.text}</span>
          <button onClick={() => setMsg(null)} aria-label="Dismiss">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      <div className="cs-body">
        <div className="cs-grid" ref={gridRef} data-testid="cs-grid">
          <div className="cs-head" style={{ paddingLeft: LABEL_W }}>
            {dayTicks.map((d) => (
              <div key={d.getTime()} className={`cs-day ${[0, 6].includes(d.getDay()) ? 'weekend' : ''} ${startOfDay(new Date(now)).getTime() === d.getTime() ? 'today' : ''}`} style={{ width: DAY * pxPerMs }}>
                {DAY * pxPerMs >= 105 ? fmtDay(d) : DAY * pxPerMs >= 44 ? fmtDayShort(d) : d.getDate()}
              </div>
            ))}
            {(data?.blackouts ?? [])
              .filter((b) => !b.cmdb_ci && x(ms(b.end_date)) > 0 && x(ms(b.start_date)) < width)
              .map((b) => (
                <Link key={b.sys_id} className="cs-head-blackout" to={recordUrl('cmn_schedule_blackout', b.sys_id)} style={{ left: LABEL_W + Math.max(0, x(ms(b.start_date))) }} title={`${b.name}\n${fmtWhen(ms(b.start_date))} → ${fmtWhen(ms(b.end_date))}`}>
                  {String(b.name)}
                </Link>
              ))}
          </div>
          <div className="cs-rows" style={{ minHeight: Math.max(gridH, 200) }}>
            <div className="cs-canvas" style={{ left: LABEL_W, width }}>
              {dayTicks.map((d) => (
                <div key={d.getTime()} className={`cs-col ${[0, 6].includes(d.getDay()) ? 'weekend' : ''}`} style={{ left: x(d.getTime()), width: DAY * pxPerMs }} />
              ))}
              {(data?.blackouts ?? [])
                .filter((b) => !b.cmdb_ci)
                .map((b) => (
                  <div key={b.sys_id} className="cs-blackout global" style={{ left: Math.max(0, x(ms(b.start_date))), width: Math.min(width, x(ms(b.end_date))) - Math.max(0, x(ms(b.start_date))) }} title={`${b.name}\n${fmtWhen(ms(b.start_date))} → ${fmtWhen(ms(b.end_date))}`}>
                  </div>
                ))}
              {now >= rangeStart && now <= rangeEnd && (
                <div className="cs-now" style={{ left: x(now) }}>
                  <span>Now</span>
                </div>
              )}
            </div>
            {rows.map((r) => (
              <div key={r.key} className="cs-row" style={{ height: r.laneCount * LANE_H + ROW_PAD }}>
                <div className="cs-row-label" style={{ width: LABEL_W }}>
                  {r.key ? (
                    <Link className="sn-link-subtle" to={recordUrl('cmdb_ci', r.key)}>
                      {r.label}
                    </Link>
                  ) : (
                    <span className="muted">{r.label}</span>
                  )}
                  <small>{r.changes.length} change{r.changes.length === 1 ? '' : 's'}</small>
                </div>
                <div className="cs-row-track" style={{ width }}>
                  {(data?.blackouts ?? [])
                    .filter((b) => b.cmdb_ci && b.cmdb_ci === r.key)
                    .map((b) => (
                      <div key={b.sys_id} className="cs-blackout ci" style={{ left: Math.max(0, x(ms(b.start_date))), width: Math.min(width, x(ms(b.end_date))) - Math.max(0, x(ms(b.start_date))) }} title={`${b.name}\n${fmtWhen(ms(b.start_date))} → ${fmtWhen(ms(b.end_date))}`}>
                        <span>{String(b.name)}</span>
                      </div>
                    ))}
                  {r.changes.map((c) => renderBar(c, r.lanes.get(c.sys_id) ?? 0))}
                </div>
              </div>
            ))}
            {data && rows.length === 0 && <div className="sn-empty-state">No changes scheduled in this window.</div>}
          </div>
        </div>

        <aside className="cs-panel" data-testid="cs-panel">
          {pending && byId.get(pending.id) ? (
            <div className="cs-card pending" data-testid="cs-pending">
              <h3>{pending.source === 'suggest' ? 'Suggested window' : 'Confirm reschedule'}</h3>
              <p>
                <b>{byId.get(pending.id)?.number}</b> {byId.get(pending.id)?.short_description}
              </p>
              <dl className="cs-dl">
                <dt>Current</dt>
                <dd className="strike">
                  {fmtWhen(ms(byId.get(pending.id)?.start_date))} → {fmtWhen(ms(byId.get(pending.id)?.end_date))}
                </dd>
                <dt>New</dt>
                <dd>
                  <b>
                    {fmtWhen(pending.start)} → {fmtWhen(pending.end)}
                  </b>
                </dd>
                <dt>Duration</dt>
                <dd>{fmtDur(pending.end - pending.start)}</dd>
              </dl>
              {pending.conflicts == null ? (
                <div className="muted small">Checking conflicts…</div>
              ) : pending.conflicts.length ? (
                <>
                  <div className="cs-verdict bad">
                    {pending.conflicts.length} conflict{pending.conflicts.length > 1 ? 's' : ''} in the new window
                  </div>
                  <ConflictList conflicts={pending.conflicts} />
                </>
              ) : (
                <div className="cs-verdict ok" data-testid="cs-verdict-ok">
                  <Icon name="check" size={14} /> No conflicts in the new window
                </div>
              )}
              <div className="cs-actions">
                <button className="sn-btn primary" disabled={busy || pending.conflicts == null} onClick={confirm} data-testid="cs-confirm">
                  {pending.conflicts?.length ? 'Reschedule anyway' : 'Reschedule'}
                </button>
                <button className="sn-btn" onClick={() => setPending(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : selectedRec ? (
            <div className="cs-card" data-testid="cs-detail">
              <div className="cs-card-head">
                <Link className="sn-link" to={recordUrl('change_request', selectedRec.sys_id)}>
                  {selectedRec.number}
                </Link>
                <span className={`cs-type t-${selectedRec.type}`}>{choiceLabel('change_request', 'type', String(selectedRec.type))}</span>
                <button className="sn-icon-btn dark" aria-label="Close" onClick={() => { setSelected(null); clearFocus() }}>
                  <Icon name="close" size={14} />
                </button>
              </div>
              <p className="cs-sd">{selectedRec.short_description}</p>
              <dl className="cs-dl">
                <dt>State</dt>
                <dd>{choiceLabel('change_request', 'state', String(selectedRec.state))}</dd>
                <dt>CI</dt>
                <dd>{selectedRec._dv?.cmdb_ci || '—'}</dd>
                <dt>Assigned to</dt>
                <dd>{selectedRec._dv?.assigned_to || '—'}</dd>
                <dt>Risk</dt>
                <dd>{choiceLabel('change_request', 'risk', String(selectedRec.risk))}</dd>
                <dt>Window</dt>
                <dd>
                  {fmtWhen(ms(selectedRec.start_date))} → {fmtWhen(ms(selectedRec.end_date))}
                </dd>
              </dl>
              {conflictsOf(selectedRec.sys_id).length ? (
                <>
                  <div className="cs-verdict bad">
                    {conflictsOf(selectedRec.sys_id).length} scheduling conflict{conflictsOf(selectedRec.sys_id).length > 1 ? 's' : ''}
                  </div>
                  <ConflictList conflicts={conflictsOf(selectedRec.sys_id)} />
                </>
              ) : INACTIVE.includes(String(selectedRec.state)) ? (
                <div className="muted small">Closed and canceled changes are not checked for conflicts.</div>
              ) : (
                <div className="cs-verdict ok">
                  <Icon name="check" size={14} /> No scheduling conflicts
                </div>
              )}
              <div className="cs-actions">
                {agent && !INACTIVE.includes(String(selectedRec.state)) && (
                  <button className="sn-btn primary" onClick={() => suggest(selectedRec.sys_id)} data-testid="cs-suggest">
                    Find next conflict-free window
                  </button>
                )}
                <Link className="sn-btn" to={recordUrl('change_request', selectedRec.sys_id)}>
                  Open record
                </Link>
              </div>
            </div>
          ) : (
            <div className="cs-card">
              <h3>Conflicts in view</h3>
              {conflictedCount === 0 ? (
                <div className="cs-verdict ok">
                  <Icon name="check" size={14} /> No scheduling conflicts
                </div>
              ) : (
                <ul className="cs-conflict-index">
                  {(data?.changes ?? [])
                    .filter((c) => conflictsOf(c.sys_id).length > 0)
                    .map((c) => (
                      <li key={c.sys_id}>
                        <button onClick={() => setSelected(c.sys_id)} data-testid={`cs-conflict-${c.number}`}>
                          <span className="cs-warn">!</span>
                          <span>
                            <b>{c.number}</b> {c.short_description}
                            <small>{[...new Set(conflictsOf(c.sys_id).map((x) => x.label))].join(' · ')}</small>
                          </span>
                        </button>
                      </li>
                    ))}
                </ul>
              )}
              <p className="muted small">Select a change to see details. Drag a bar to move it; the conflict checker runs live while you drag.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
