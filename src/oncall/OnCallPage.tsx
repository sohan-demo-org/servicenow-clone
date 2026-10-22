import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError } from '../api.ts'
import { usePageTitle } from '../components/Layout.tsx'
import { ReferenceInput } from '../components/ReferenceInput.tsx'
import { formatDate, fromInputDate, listUrl, parseDate, recordUrl, toInputDate } from '../util.ts'
import { MEMBER_COLORS, endsIn, initials, oncallApi } from './api.ts'
import type { OnCallNow, OnCallSchedule } from './api.ts'
import './oncall.css'

const DAYS = 14
const DAY = 86400000
const ms = (utc: string) => parseDate(utc)?.getTime() ?? 0
const utcStr = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ')
const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
const dayLabel = (t: number) => new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })

function Person({ label, name, sub, tone }: { label: string; name?: string; sub?: string; tone?: string }) {
  return (
    <div className={`oc-person ${tone ?? ''}`}>
      <span className={`oc-avatar ${tone === 'primary' ? '' : 'small'}`}>{name ? initials(name) : '–'}</span>
      <div>
        <div className="oc-person-label">{label}</div>
        <div className="oc-person-name">{name ?? '—'}</div>
        {sub && <div className="oc-person-sub">{sub}</div>}
      </div>
    </div>
  )
}

function NowCard({ oc, onOverride }: { oc: OnCallNow; onOverride: () => void }) {
  return (
    <div className={`oc-card ${oc.override ? 'ovr' : ''}`} data-testid={`oncall-card-${oc.group.name}`}>
      <div className="oc-card-head">
        <div>
          <div className="oc-card-group">{oc.group.name}</div>
          <div className="oc-card-rota">
            {oc.rota.rotation_type === 'daily' ? 'Daily' : 'Weekly'} rotation · handoff {oc.rota.handoff_time} {oc.rota.timezone}
          </div>
        </div>
        <span className="oc-ends" title={`Shift ends ${formatDate(oc.shift_end)}`}>
          Shift ends in <b>{endsIn(oc.shift_end)}</b>
        </span>
      </div>
      <Person label="Primary" name={oc.primary.name} tone="primary" sub={oc.override ? (oc.scheduled.sys_id === oc.primary.sys_id ? 'Override' : `Override · covering ${oc.scheduled.name}`) : 'Scheduled rotation'} />
      {oc.override && (
        <div className="oc-ovr-note" data-testid="oncall-override-note">
          <span className="oc-badge">override</span> {oc.override.reason} · until {formatDate(oc.override.end).slice(5, 16)}
        </div>
      )}
      <div className="oc-card-row">
        <Person label="Secondary" name={oc.secondary?.name} />
        <Person label="Escalation" name={oc.manager?.name} sub="Group manager" />
      </div>
      <div className="oc-card-foot">
        <span className="muted small">{oc.escalation.map((e) => e.name.split(' ')[0]).filter((n, i, a) => n !== a[i - 1]).join(' → ')}</span>
        <button className="sn-btn small" onClick={onOverride}>
          Add override
        </button>
      </div>
    </div>
  )
}

function Timeline({ s, from, now, onOverride }: { s: OnCallSchedule; from: number; now: number; onOverride: () => void }) {
  const to = from + DAYS * DAY
  const pct = (t: number) => ((Math.min(Math.max(t, from), to) - from) / (to - from)) * 100
  const color = (member: string) => {
    const i = s.members.findIndex((m) => m.sys_id === member)
    return i < 0 ? '#7d8b99' : MEMBER_COLORS[i % MEMBER_COLORS.length]
  }
  const outsiders = [...new Map(s.segments.filter((g) => g.override && !s.members.some((m) => m.sys_id === g.member)).map((g) => [g.member, g.name])).entries()]
  return (
    <div className="oc-tl" data-testid={`oncall-timeline-${s.group.name}`}>
      <div className="oc-tl-head">
        <div>
          <Link className="sn-link" to={recordUrl('cmn_rota', s.rota.sys_id)}>
            {s.group.name}
          </Link>
          <span className="muted small"> · {s.rota.name}</span>
        </div>
        <div className="oc-legend">
          {s.members.map((m) => (
            <span key={m.sys_id}>
              <i style={{ background: color(m.sys_id) }} />
              {m.name}
            </span>
          ))}
          {outsiders.map(([id, name]) => (
            <span key={id}>
              <i style={{ background: color(id) }} />
              {name}
            </span>
          ))}
          <span>
            <i className="oc-ovr-swatch" />
            Override
          </span>
          <button className="sn-btn small" onClick={onOverride}>
            + Override
          </button>
        </div>
      </div>
      <div className="oc-tl-track">
        {Array.from({ length: DAYS }, (_, i) => (
          <span key={i} className="oc-tl-grid" style={{ left: `${(i / DAYS) * 100}%` }} />
        ))}
        {s.segments
          .filter((g) => ms(g.end) > from && ms(g.start) < to)
          .map((g) => {
            const a = ms(g.start)
            const b = ms(g.end)
            const title = `${g.name}${g.override ? ` (override: ${g.override.reason})` : ''}\n${formatDate(g.start).slice(0, 16)} → ${formatDate(g.end).slice(0, 16)}`
            return (
              <div
                key={`${g.start}-${g.member}`}
                className={`oc-seg ${g.override ? 'ovr' : ''}`}
                data-testid={g.override ? 'oncall-override-segment' : 'oncall-segment'}
                style={{ left: `${pct(a)}%`, width: `${pct(b) - pct(a)}%`, background: color(g.member) }}
                title={title}
              >
                <span>{g.override ? `⇄ ${g.name.split(' ')[0]}` : g.name.split(' ')[0]}</span>
              </div>
            )
          })}
        <span className="oc-now" style={{ left: `${pct(now)}%` }} title={`Now ${hhmm(now)}`} />
      </div>
    </div>
  )
}

interface Draft {
  group: string
  member: string
  memberName: string
  start: string
  end: string
  reason: string
}

function OverrideModal({ groups, draft, onClose, onSaved }: { groups: OnCallNow[]; draft: Draft; onClose: () => void; onSaved: (msg: string) => void }) {
  const [d, setD] = useState(draft)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<Draft>) => setD((p) => ({ ...p, ...patch }))
  const save = async () => {
    if (!d.group || !d.member || !d.start || !d.end) return setErr('Group, member, start and end are required.')
    if (d.end <= d.start) return setErr('End must be after start.')
    setBusy(true)
    try {
      await oncallApi.addOverride(d.group, { member: d.member, start: d.start, end: d.end, reason: d.reason })
      onSaved(`Override added: ${d.memberName} covers ${groups.find((g) => g.group.sys_id === d.group)?.group.name ?? ''}`)
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.message}${e.detail ? ` – ${e.detail}` : ''}` : String(e))
      setBusy(false)
    }
  }
  return (
    <div className="oc-modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="oc-modal" role="dialog" aria-label="Add override">
        <div className="oc-modal-head">
          Add on-call override
          <button className="oc-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="oc-modal-body">
          {err && <div className="sn-msg error">{err}</div>}
          <div className="sn-field">
            <label htmlFor="oc-group">Group</label>
            <select id="oc-group" className="sn-input" value={d.group} onChange={(e) => set({ group: e.target.value })}>
              {groups.map((g) => (
                <option key={g.group.sys_id} value={g.group.sys_id}>
                  {g.group.name}
                </option>
              ))}
            </select>
          </div>
          <div className="sn-field">
            <label htmlFor="oc-member">Covering member</label>
            <ReferenceInput id="oc-member" table="sys_user" refQuery="roleINitil,admin" value={d.member} display={d.memberName} onChange={(member, memberName) => set({ member, memberName })} />
          </div>
          <div className="sn-field">
            <label htmlFor="oc-start">Start</label>
            <input id="oc-start" type="datetime-local" className="sn-input" value={toInputDate(d.start)} onChange={(e) => set({ start: fromInputDate(e.target.value) })} />
          </div>
          <div className="sn-field">
            <label htmlFor="oc-end">End</label>
            <input id="oc-end" type="datetime-local" className="sn-input" value={toInputDate(d.end)} onChange={(e) => set({ end: fromInputDate(e.target.value) })} />
          </div>
          <div className="sn-field">
            <label htmlFor="oc-reason">Reason</label>
            <input id="oc-reason" className="sn-input" placeholder="e.g. PTO swap, sick day" value={d.reason} onChange={(e) => set({ reason: e.target.value })} />
          </div>
        </div>
        <div className="oc-modal-foot">
          <button className="sn-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="sn-btn primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save override'}
          </button>
        </div>
      </div>
    </div>
  )
}

interface Loaded {
  t: number
  current: OnCallNow[]
  schedules: OnCallSchedule[]
}

async function fetchAll(): Promise<Loaded> {
  const t = Date.now()
  const current = await oncallApi.current(true)
  const start = new Date(t)
  start.setHours(0, 0, 0, 0)
  const schedules = await Promise.all(current.map((g) => oncallApi.schedule(g.group.sys_id, DAYS, utcStr(start.getTime()))))
  return { t, current, schedules }
}

export function OnCallPage() {
  usePageTitle('On-Call Schedule')
  const [now, setNow] = useState(() => Date.now())
  const from = useMemo(() => {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }, [now])
  const [current, setCurrent] = useState<OnCallNow[] | null>(null)
  const [schedules, setSchedules] = useState<OnCallSchedule[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [msg, setMsg] = useState('')

  const apply = useCallback((d: Loaded) => {
    setNow(d.t)
    setCurrent(d.current)
    setSchedules(d.schedules)
  }, [])
  const load = useCallback(() => fetchAll().then(apply), [apply])

  useEffect(() => {
    let live = true
    fetchAll().then((d) => live && apply(d))
    const iv = setInterval(() => setNow(Date.now()), 60000)
    return () => {
      live = false
      clearInterval(iv)
    }
  }, [apply])

  const openOverride = (groupId?: string) => {
    const t = Math.floor(Date.now() / 60000) * 60000
    setDraft({ group: groupId ?? current?.[0]?.group.sys_id ?? '', member: '', memberName: '', start: utcStr(t), end: utcStr(t + 8 * 3600000), reason: '' })
  }

  const days = Array.from({ length: DAYS }, (_, i) => from + i * DAY)
  return (
    <div className="sn-page-pad oc-page">
      <div className="oc-page-head">
        <div>
          <h1 className="sn-h1">On-Call Schedule</h1>
          <div className="muted">Who is on call for each assignment group, and the rotation for the next {DAYS} days. P1/P2 incidents with no assignee go to the primary.</div>
        </div>
        <div className="oc-actions">
          <Link className="sn-btn" to={listUrl('cmn_rota', '')}>
            Rotas
          </Link>
          <Link className="sn-btn" to={listUrl('cmn_rota_override', '')}>
            Overrides
          </Link>
          <button className="sn-btn primary" onClick={() => openOverride()} disabled={!current?.length}>
            Add override
          </button>
        </div>
      </div>
      {msg && (
        <div className="sn-msg success" data-testid="oncall-msg">
          {msg}
          <button onClick={() => setMsg('')} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <h2 className="oc-h2">Who&apos;s on call now</h2>
      {current === null ? (
        <div className="muted">Loading…</div>
      ) : current.length === 0 ? (
        <div className="muted">No active rotas. Create one under On-Call › Rotas.</div>
      ) : (
        <div className="oc-cards">
          {current.map((oc) => (
            <NowCard key={oc.group.sys_id} oc={oc} onOverride={() => openOverride(oc.group.sys_id)} />
          ))}
        </div>
      )}

      <h2 className="oc-h2">Next {DAYS} days</h2>
      <div className="oc-timelines">
        <div className="oc-days">
          {days.map((d) => (
            <span key={d} className={new Date(d).getDay() % 6 === 0 ? 'wkend' : ''}>
              {dayLabel(d)}
            </span>
          ))}
        </div>
        {schedules.map((s) => (
          <Timeline key={s.group.sys_id} s={s} from={from} now={now} onOverride={() => openOverride(s.group.sys_id)} />
        ))}
      </div>

      {draft && current && (
        <OverrideModal
          groups={current}
          draft={draft}
          onClose={() => setDraft(null)}
          onSaved={(m) => {
            setDraft(null)
            setMsg(m)
            void load()
          }}
        />
      )}
    </div>
  )
}
