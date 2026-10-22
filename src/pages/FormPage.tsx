import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { SLA_HOURS, SUBCATEGORY, TABLES, calcPriority, getField } from '../../shared/schema.ts'
import type { FieldDef, FormSection } from '../../shared/schema.ts'
import { ApiError, api } from '../api.ts'
import type { JournalEntry, Rec } from '../api.ts'
import { ActivityStream } from '../components/ActivityStream.tsx'
import { Icon } from '../components/Icon.tsx'
import { usePageTitle } from '../components/Layout.tsx'
import { MiniList } from '../components/ListTable.tsx'
import { ReferenceInput } from '../components/ReferenceInput.tsx'
import { OnCallHint } from '../oncall/OnCallHint.tsx'
import { isAgent, useAuth } from '../auth.tsx'
import { parseQuery } from '../query.ts'
import { displayValue, formatDate, fromInputDate, parseDate, pushHistory, recordUrl, toInputDate } from '../util.ts'

type Draft = Record<string, string | null>
interface Msg {
  type: 'info' | 'error' | 'success'
  text: string
}

function SlaBar({ rec }: { rec: Rec }) {
  const opened = parseDate(String(rec.opened_at ?? ''))
  if (!opened) return null
  const hours = SLA_HOURS[String(rec.priority ?? '5')] ?? 120
  const end = parseDate(String(rec.resolved_at ?? '')) ?? new Date()
  const elapsed = (end.getTime() - opened.getTime()) / 3600000
  const pct = Math.min(100, Math.round((elapsed / hours) * 100))
  const stopped = Boolean(rec.resolved_at)
  const breached = elapsed > hours
  const left = hours - elapsed
  const fmt = (h: number) => (Math.abs(h) >= 24 ? `${Math.floor(Math.abs(h) / 24)}d ${Math.floor(Math.abs(h) % 24)}h` : `${Math.floor(Math.abs(h))}h ${Math.floor((Math.abs(h) * 60) % 60)}m`)
  return (
    <div className="sn-sla" data-testid="sla-bar">
      <div className="sn-sla-label">
        <b>Resolution SLA</b> <span className="muted">P{String(rec.priority)} · {hours}h target</span>
        <span className={`sn-sla-status ${breached ? 'bad' : stopped ? 'ok' : ''}`}>
          {stopped ? (breached ? 'Completed (breached)' : 'Completed') : breached ? `Breached ${fmt(left)} ago` : `${fmt(left)} remaining`}
        </span>
      </div>
      <div className="sn-sla-track">
        <div className={`sn-sla-fill ${breached ? 'bad' : pct > 75 ? 'warn' : 'ok'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function FormPage() {
  const { table = '', id = '' } = useParams()
  const [sp] = useSearchParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const def = TABLES[table]
  const isNew = id === '-1'
  const [rec, setRec] = useState<Rec | null>(null)
  const [draft, setDraft] = useState<Draft>({})
  const [dv, setDv] = useState<Record<string, string>>({})
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [invalid, setInvalid] = useState<Set<string>>(new Set())
  const [journal, setJournal] = useState<JournalEntry[]>([])
  const [tab, setTab] = useState(0)
  const [relTab, setRelTab] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const agent = isAgent(user)

  const title = isNew ? `New ${def?.label ?? ''}` : rec ? `${def?.label} - ${displayValue(table, rec, def.displayField)}` : (def?.label ?? '')
  usePageTitle(title)

  const loadJournal = useCallback(async () => {
    if (!def?.journal || isNew) return
    setJournal(await api.journal(table, id))
  }, [def, isNew, table, id])

  useEffect(() => {
    if (!def) return
    setMsgs([])
    setInvalid(new Set())
    setTab(0)
    setRelTab(0)
    setNotFound(false)
    if (isNew) {
      const defaults: Draft = {}
      const names: Record<string, string> = {}
      if (table === 'incident') Object.assign(defaults, { state: '1', impact: '3', urgency: '3', priority: '5', contact_type: 'phone' })
      if (table === 'problem') Object.assign(defaults, { state: '101', impact: '3', urgency: '3', priority: '5' })
      if (table === 'change_request') Object.assign(defaults, { state: '-5', type: 'normal', risk: '3', impact: '3', approval: 'not requested', requested_by: user?.sys_id ?? null })
      if (table === 'kb_knowledge') Object.assign(defaults, { workflow_state: 'draft', author: user?.sys_id ?? null })
      if (table === 'sc_req_item') Object.assign(defaults, { requested_for: user?.sys_id ?? null, quantity: '1', state: '1' })
      if (table === 'sc_cat_item' || table === 'sys_user') defaults.active = 'true'
      if (defaults.requested_by || defaults.author || defaults.requested_for) {
        for (const k of ['requested_by', 'author', 'requested_for']) if (defaults[k]) names[k] = String(user?.name ?? '')
      }
      const fromQuery = parseQuery(sp.get('sysparm_query') ?? '').conditions.filter((c) => c.op === '=')
      for (const c of fromQuery) {
        defaults[c.field] = c.value
        const f = getField(table, c.field)
        if (f?.type === 'reference' && f.ref) {
          const refTable = f.ref
          api
            .get(refTable, c.value)
            .then((r) => setDv((p) => ({ ...p, [c.field]: String(r[TABLES[refTable].displayField] ?? '') })))
            .catch(() => {})
        }
      }
      setRec(null)
      setDraft(defaults)
      setDv(names)
      setJournal([])
      return
    }
    let live = true
    api
      .get(table, id)
      .then((r) => {
        if (!live) return
        setRec(r)
        setDraft({})
        setDv(r._dv ?? {})
        pushHistory({ table, id, title: displayValue(table, r, def.displayField), subtitle: String(r.short_description ?? def.label) })
      })
      .catch(() => live && setNotFound(true))
    loadJournal()
    return () => {
      live = false
    }
  }, [table, id, isNew, def, sp, user, loadJournal])

  const value = (f: string): string => {
    if (f in draft) return draft[f] ?? ''
    const v = rec?.[f]
    return v == null ? '' : String(v)
  }

  const setField = (f: string, v: string | null, display?: string) => {
    const next: Draft = { ...draft, [f]: v }
    if ((table === 'incident' || table === 'problem') && (f === 'impact' || f === 'urgency')) {
      next.priority = calcPriority(f === 'impact' ? v : value('impact'), f === 'urgency' ? v : value('urgency'))
    }
    if (f === 'category' && table === 'incident') next.subcategory = ''
    setDraft(next)
    if (display !== undefined) setDv({ ...dv, [f]: display })
    if (invalid.has(f) && v) {
      const s = new Set(invalid)
      s.delete(f)
      setInvalid(s)
    }
  }

  const changed = useMemo(() => Object.keys(draft).filter((k) => String(draft[k] ?? '') !== String(rec?.[k] ?? '')), [draft, rec])

  const missingMandatory = (extra: string[] = []): FieldDef[] =>
    def.fields.filter((f) => (f.mandatory || extra.includes(f.name)) && !f.readOnly && !value(f.name))

  const save = async (opts: { stay?: boolean; extra?: Draft; requireFields?: string[]; successMsg?: string } = {}): Promise<Rec | null> => {
    const extraKeys = Object.keys(opts.extra ?? {})
    const merged: Draft = { ...draft, ...(opts.extra ?? {}) }
    const missing = missingMandatory(opts.requireFields)
    if (missing.length) {
      setInvalid(new Set(missing.map((f) => f.name)))
      setMsgs([{ type: 'error', text: `The following mandatory fields are not filled in: ${missing.map((f) => f.label).join(', ')}` }])
      return null
    }
    setBusy(true)
    try {
      let result: Rec
      if (isNew) {
        const body: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(merged)) if (v !== '' && v != null) body[k] = v
        result = await api.create(table, body)
        navigate(recordUrl(table, result.sys_id), { replace: true })
        return result
      }
      const body: Record<string, unknown> = {}
      for (const k of [...changed, ...extraKeys]) body[k] = merged[k]
      if (!Object.keys(body).length && !opts.extra) {
        if (!opts.stay) navigate(-1)
        return rec
      }
      result = await api.update(table, id, body)
      setRec(result)
      setDraft({})
      setDv(result._dv ?? {})
      setInvalid(new Set())
      await loadJournal()
      if (!opts.stay) {
        navigate(-1)
      } else {
        setMsgs([{ type: 'success', text: opts.successMsg ?? `${def.label} ${displayValue(table, result, def.displayField)} updated` }])
      }
      return result
    } catch (e) {
      const err = e as ApiError
      setMsgs([{ type: 'error', text: `${err.message}${err.detail ? `: ${err.detail}` : ''}` }])
      return null
    } finally {
      setBusy(false)
    }
  }

  const resolve = async () => {
    const tabs = def.tabs ?? []
    const resIdx = tabs.findIndex((t) => t.title === 'Resolution Information')
    if (resIdx >= 0) setTab(resIdx + (def.journal ? 1 : 0))
    setDraft((d) => ({ ...d, state: '6' }))
    if (!value('close_code') || !value('close_notes')) {
      setInvalid(new Set(['close_code', 'close_notes'].filter((f) => !value(f))))
      setMsgs([{ type: 'error', text: 'The following mandatory fields are not filled in: Resolution code, Resolution notes' }])
      return
    }
    await save({ stay: true, extra: { state: '6' }, successMsg: `Incident ${value('number')} resolved` })
  }

  const createProblem = async () => {
    if (!rec) return
    const p = await api.create('problem', {
      short_description: rec.short_description,
      description: rec.description,
      category: rec.category,
      cmdb_ci: rec.cmdb_ci,
      impact: rec.impact,
      urgency: rec.urgency,
      assignment_group: rec.assignment_group,
    })
    await api.update('incident', id, { problem_id: p.sys_id, work_notes: `Problem ${p.number} created from this incident.` })
    navigate(recordUrl('problem', p.sys_id))
  }

  const approve = async (decision: 'approved' | 'rejected') => {
    const r = await api.approve(table, id, decision)
    setRec(r)
    setDraft({})
    setDv(r._dv ?? {})
    await loadJournal()
    setMsgs([{ type: 'success', text: `${def.label} ${String(r.number)} ${decision}` }])
  }

  const del = async () => {
    if (!confirm(`Delete this ${def.label}?`)) return
    await api.remove(table, id)
    navigate(`/list/${table}`)
  }

  if (!def) return <div className="sn-page-pad">Unknown table “{table}”.</div>
  if (notFound) return <div className="sn-page-pad sn-msg error">Record not found</div>
  if (!isNew && !rec) return <div className="sn-loading">Loading…</div>

  const state = value('state')
  const approval = value('approval')

  const renderField = (name: string, full = false) => {
    const f = getField(table, name)
    if (!f) return null
    const v = value(name)
    const ro = f.readOnly || (name === 'number' && !isNew)
    const fid = `f-${name}`
    let input
    if (ro && f.type !== 'boolean') {
      const shown = f.type === 'reference' ? (dv[name] ?? v) : f.type === 'choice' || f.type === 'datetime' || f.type === 'currency' ? displayValue(table, { sys_id: '', [name]: v }, name) : v
      input = f.type === 'text' ? <textarea id={fid} className="sn-input" readOnly value={shown} rows={4} /> : <input id={fid} className="sn-input" readOnly value={shown || (name === 'number' && isNew ? '(assigned on submit)' : '')} />
    } else if (f.type === 'text') {
      input = <textarea id={fid} className="sn-input" rows={name === 'text' ? 12 : 4} value={v} onChange={(e) => setField(name, e.target.value)} />
    } else if (f.type === 'choice') {
      const choices = name === 'subcategory' && table === 'incident' && value('category') ? (SUBCATEGORY[value('category')] ?? f.choices) : f.choices
      input = (
        <select id={fid} className="sn-input" value={v} onChange={(e) => setField(name, e.target.value)}>
          <option value="">-- None --</option>
          {choices?.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      )
    } else if (f.type === 'reference' && f.ref) {
      input = <ReferenceInput id={fid} table={f.ref} value={v} display={dv[name] ?? ''} refQuery={f.refQuery} onChange={(rid, d) => setField(name, rid || null, d)} />
    } else if (f.type === 'boolean') {
      input = <input id={fid} type="checkbox" className="sn-checkbox" disabled={ro} checked={v === 'true'} onChange={(e) => setField(name, e.target.checked ? 'true' : 'false')} />
    } else if (f.type === 'datetime') {
      input = <input id={fid} type="datetime-local" className="sn-input" value={toInputDate(v)} onChange={(e) => setField(name, fromInputDate(e.target.value))} />
    } else if (f.type === 'integer' || f.type === 'currency') {
      input = <input id={fid} type="number" className="sn-input" value={v} onChange={(e) => setField(name, e.target.value)} />
    } else {
      input = <input id={fid} className="sn-input" value={v} onChange={(e) => setField(name, e.target.value)} />
    }
    const mandatory = f.mandatory || (state === '6' && table === 'incident' && (name === 'close_code' || name === 'close_notes'))
    return (
      <div className={`sn-field ${full ? 'full' : ''} ${invalid.has(name) ? 'invalid' : ''}`} key={name}>
        <label htmlFor={fid}>
          {mandatory && <span className={`sn-mand ${v ? 'filled' : ''}`}>*</span>}
          {f.label}
        </label>
        <div className="sn-field-input">
          {input}
          {table === 'incident' && name === 'assignment_group' && v && <OnCallHint groupId={v} />}
        </div>
      </div>
    )
  }

  const renderSection = (s: FormSection, key: string | number) => (
    <div className="sn-section" key={key}>
      {(s.left.length > 0 || s.right.length > 0) && (
        <div className="sn-cols">
          <div className="sn-col">{s.left.map((n) => renderField(n))}</div>
          <div className="sn-col">{s.right.map((n) => renderField(n))}</div>
        </div>
      )}
      {s.full?.map((n) => renderField(n, true))}
    </div>
  )

  const tabs: { title: string; body: React.ReactNode }[] = []
  if (def.journal && !isNew) {
    tabs.push({
      title: 'Notes',
      body: (
        <ActivityStream
          entries={journal}
          allowWorkNotes={agent}
          onPost={async (el, text) => {
            await api.addJournal(table, id, el, text)
            await loadJournal()
          }}
        />
      ),
    })
  }
  for (const t of def.tabs ?? []) tabs.push({ title: t.title ?? '', body: renderSection(t, t.title ?? '') })

  const buttons: React.ReactNode[] = []
  if (isNew) {
    buttons.push(
      <button key="submit" className="sn-btn primary" disabled={busy} onClick={() => save()} data-testid="form-submit">
        Submit
      </button>,
    )
  } else {
    buttons.push(
      <button key="update" className="sn-btn primary" disabled={busy} onClick={() => save()} data-testid="form-update">
        Update
      </button>,
      <button key="save" className="sn-btn" disabled={busy} onClick={() => save({ stay: true })} data-testid="form-save">
        Save
      </button>,
    )
    if (table === 'incident' && agent) {
      if (!['6', '7', '8'].includes(String(rec?.state))) {
        buttons.push(
          <button key="resolve" className="sn-btn" onClick={resolve} data-testid="form-resolve">
            Resolve
          </button>,
        )
        if (!rec?.problem_id)
          buttons.push(
            <button key="prb" className="sn-btn" onClick={createProblem}>
              Create Problem
            </button>,
          )
      } else if (String(rec?.state) === '6') {
        buttons.push(
          <button key="reopen" className="sn-btn" onClick={() => save({ stay: true, extra: { state: '2' }, successMsg: 'Incident reopened' })}>
            Reopen Incident
          </button>,
        )
      }
    }
    if (table === 'change_request' && agent) {
      const s = String(rec?.state)
      if ((s === '-5' || s === '-4') && rec?.approval !== 'approved')
        buttons.push(
          <button key="reqappr" className="sn-btn" onClick={() => save({ stay: true, extra: { state: '-3' }, successMsg: 'Approval requested from the Change Advisory Board' })}>
            Request Approval
          </button>,
        )
      const next: Record<string, [string, string]> = { '-2': ['-1', 'Implement'], '-1': ['0', 'Review'], '0': ['3', 'Close'] }
      if (next[s])
        buttons.push(
          <button key="next" className="sn-btn" onClick={() => save({ stay: true, extra: { state: next[s][0] } })}>
            {next[s][1]}
          </button>,
        )
    }
    if ((table === 'change_request' || table === 'sc_req_item') && approval === 'requested' && agent) {
      buttons.push(
        <button key="approve" className="sn-btn success" onClick={() => approve('approved')} data-testid="form-approve">
          Approve
        </button>,
        <button key="reject" className="sn-btn danger-outline" onClick={() => approve('rejected')}>
          Reject
        </button>,
      )
    }
    if (table === 'kb_knowledge') {
      if (rec?.workflow_state !== 'published')
        buttons.push(
          <button key="pub" className="sn-btn" onClick={() => save({ stay: true, extra: { workflow_state: 'published' }, successMsg: 'Article published' })}>
            Publish
          </button>,
        )
      buttons.push(
        <Link key="view" className="sn-btn" to={`/sp/kb/${id}`}>
          View Article
        </Link>,
      )
    }
    if (agent)
      buttons.push(
        <button key="del" className="sn-btn danger" onClick={del}>
          Delete
        </button>,
      )
  }

  return (
    <div className="sn-form-page">
      <div className="sn-titlebar form">
        <button className="sn-icon-btn dark" onClick={() => navigate(-1)} aria-label="Back">
          <Icon name="chevronLeft" size={20} />
        </button>
        <div className="sn-form-title">
          <span className="sn-form-table">{def.label}</span>
          <b>{isNew ? 'New record' : displayValue(table, rec as Rec, def.displayField)}</b>
          {changed.length > 0 && !isNew && <span className="sn-dirty">● unsaved changes</span>}
        </div>
        <div className="sn-titlebar-right">{buttons}</div>
      </div>

      {msgs.map((m, i) => (
        <div key={i} className={`sn-msg ${m.type}`} role="alert" data-testid={`msg-${m.type}`}>
          <span>{m.text}</span>
          <button onClick={() => setMsgs(msgs.filter((_, j) => j !== i))} aria-label="Dismiss">
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}

      <div className="sn-form">
        {table === 'incident' && rec && <SlaBar rec={rec} />}
        {table === 'change_request' && rec && (
          <div className="sn-stepper">
            {['-5', '-4', '-3', '-2', '-1', '0', '3'].map((s) => {
              const order = ['-5', '-4', '-3', '-2', '-1', '0', '3']
              const cur = order.indexOf(String(rec.state))
              const idx = order.indexOf(s)
              return (
                <div key={s} className={`sn-step ${idx < cur ? 'done' : idx === cur ? 'current' : ''}`}>
                  <span className="dot">{idx < cur ? <Icon name="check" size={12} /> : idx + 1}</span>
                  {getField('change_request', 'state')?.choices?.find((c) => c.value === s)?.label}
                </div>
              )
            })}
          </div>
        )}
        {def.form.map((s, i) => renderSection(s, i))}

        {tabs.length > 0 && (
          <div className="sn-tabs">
            <div className="sn-tab-bar" role="tablist">
              {tabs.map((t, i) => (
                <button key={t.title} role="tab" aria-selected={tab === i} className={tab === i ? 'on' : ''} onClick={() => setTab(i)}>
                  {t.title}
                </button>
              ))}
            </div>
            <div className="sn-tab-body">{tabs[tab]?.body}</div>
          </div>
        )}

        {!isNew && (
          <div className="sn-form-foot">
            <div className="sn-titlebar-right">{buttons}</div>
            <div className="muted small">
              Created {formatDate(String(rec?.sys_created_on ?? ''))} by {String(rec?.sys_created_by ?? '')} · Updated {formatDate(String(rec?.sys_updated_on ?? ''))} by{' '}
              {String(rec?.sys_updated_by ?? '')}
            </div>
          </div>
        )}
      </div>

      {!isNew && def.related && def.related.length > 0 && (
        <div className="sn-related">
          <div className="sn-tab-bar">
            {def.related.map((r, i) => (
              <button key={r.label} className={relTab === i ? 'on' : ''} onClick={() => setRelTab(i)}>
                {r.label}
              </button>
            ))}
          </div>
          {def.related[relTab] && (
            <MiniList
              key={relTab}
              table={def.related[relTab].table}
              query={`${def.related[relTab].field}=${id}`}
              newQuery={`${def.related[relTab].field}=${id}`}
            />
          )}
        </div>
      )}
    </div>
  )
}
