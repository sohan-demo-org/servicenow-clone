import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { APPROVER_STATE_LABEL, approvalsApi, useApprovalCount } from '../approvals.ts'
import type { ApprovalItem, Decision } from '../approvals.ts'
import { useAuth } from '../auth.tsx'
import { ApprovalDecision } from '../components/ApprovalDecision.tsx'
import { Icon } from '../components/Icon.tsx'
import { usePageTitle } from '../components/Layout.tsx'
import { formatDate, parseDate, recordUrl, timeAgo } from '../util.ts'
import '../approvals.css'

type View = 'pending' | 'history'
type Kind = 'all' | 'change_request' | 'sc_req_item'
interface Msg {
  type: 'success' | 'error' | 'info'
  text: string
}

const money = (n: unknown) => `$${Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const typeLabel = (t: string) => (t === 'change_request' ? 'Change' : 'Requested Item')

function DocMeta({ a, now }: { a: ApprovalItem; now: number }) {
  const d = a.document
  const due = parseDate(String(a.due_date ?? ''))
  const overdue = a.state === 'requested' && due && due.getTime() < now
  return (
    <div className="sn-appr-meta">
      <span>
        Requested by <b>{d.requested_by_name || '—'}</b>
      </span>
      {a.source_table === 'change_request' ? (
        <>
          <span>
            Risk <b className={`sn-appr-risk-${d.risk}`}>{d.risk_label}</b>
          </span>
          {d.cmdb_ci_name && (
            <span>
              CI <b>{d.cmdb_ci_name}</b>
            </span>
          )}
          {d.start_date && (
            <span>
              Planned start <b>{formatDate(String(d.start_date))}</b>
            </span>
          )}
        </>
      ) : (
        <>
          <span>
            Price <b>{money(d.price)}</b>
          </span>
          <span>
            Item <b>{d.item_name}</b>
            {Number(d.quantity) > 1 ? ` × ${d.quantity}` : ''}
          </span>
        </>
      )}
      <span title={formatDate(String(a.sys_created_on ?? ''))}>
        Age <b>{timeAgo(String(a.sys_created_on ?? ''))}</b>
      </span>
      {a.state === 'requested' && due && (
        <span className={overdue ? 'sn-appr-overdue' : ''}>
          Due <b className={overdue ? 'sn-appr-overdue' : ''}>{formatDate(String(a.due_date))}</b>
          {overdue ? ' (overdue)' : ''}
        </span>
      )}
    </div>
  )
}

export function ApprovalsPage() {
  usePageTitle('My Approvals')
  const { user } = useAuth()
  const count = useApprovalCount(user?.sys_id)
  const [view, setView] = useState<View>('pending')
  const [kind, setKind] = useState<Kind>('all')
  const [items, setItems] = useState<ApprovalItem[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deciding, setDeciding] = useState<{ id: string; decision: Decision } | null>(null)
  const [busy, setBusy] = useState(false)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [now, setNow] = useState(() => Date.now())

  const apply = useCallback((r: ApprovalItem[]) => {
    setItems(r)
    setNow(Date.now())
    setSelected((s) => new Set([...s].filter((id) => r.some((a) => a.sys_id === id))))
  }, [])
  const load = async (v: View) => apply(await approvalsApi.mine(v))

  useEffect(() => {
    let alive = true
    approvalsApi.mine(view).then((r) => alive && apply(r))
    return () => {
      alive = false
    }
  }, [apply, view])

  const shown = (items ?? []).filter((a) => kind === 'all' || a.source_table === kind)
  const allSelected = shown.length > 0 && shown.every((a) => selected.has(a.sys_id))

  const decideOne = async (a: ApprovalItem, decision: Decision, comment: string) => {
    setBusy(true)
    try {
      const r = await approvalsApi.decide(a.sys_id, decision, comment)
      const docState = r.document.approval === decision ? ` — ${typeLabel(String(a.source_table))} is now ${decision}` : ''
      setMsgs([{ type: 'success', text: `${decision === 'approved' ? 'Approved' : 'Rejected'} ${a.document.number}${docState}` }])
      setDeciding(null)
      await load(view)
    } catch (e) {
      setMsgs([{ type: 'error', text: e instanceof Error ? e.message : String(e) }])
    } finally {
      setBusy(false)
    }
  }

  const bulkApprove = async () => {
    const ids = shown.filter((a) => selected.has(a.sys_id)).map((a) => a.sys_id)
    if (!ids.length) return
    setBusy(true)
    try {
      const r = await approvalsApi.bulk(ids, 'approved')
      const ok = r.filter((x) => x.ok)
      const failed = r.filter((x) => !x.ok)
      const out: Msg[] = []
      if (ok.length) out.push({ type: 'success', text: `Approved ${ok.length} record${ok.length === 1 ? '' : 's'}: ${ok.map((x) => x.number).join(', ')}` })
      if (failed.length) out.push({ type: 'error', text: `${failed.length} could not be approved: ${failed.map((x) => x.error).join('; ')}` })
      setMsgs(out)
      setSelected(new Set())
      await load(view)
    } finally {
      setBusy(false)
    }
  }

  const toggle = (id: string) => {
    const s = new Set(selected)
    if (s.has(id)) s.delete(id)
    else s.add(id)
    setSelected(s)
  }

  return (
    <div className="sn-page-pad" data-testid="approvals-page">
      <div className="sn-appr-head">
        <h1 className="sn-h1">My Approvals</h1>
        <div className="sn-appr-policy">
          <Icon name="info" size={14} /> Any one approver can approve a record; a single rejection rejects it. Rejections need a comment.
        </div>
      </div>
      {msgs.map((m, i) => (
        <div key={i} className={`sn-msg ${m.type}`} style={{ margin: '0 0 10px' }} data-testid="approvals-msg">
          <span>{m.text}</span>
          <button onClick={() => setMsgs(msgs.filter((_, j) => j !== i))} aria-label="Dismiss">
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
      <div className="sn-tab-bar sn-appr-tabs">
        <button className={view === 'pending' ? 'on' : ''} onClick={() => setView('pending')} data-testid="tab-pending">
          Pending<span className={`sn-appr-count ${count ? '' : 'zero'}`}>{count}</span>
        </button>
        <button className={view === 'history' ? 'on' : ''} onClick={() => setView('history')} data-testid="tab-history">
          History
        </button>
      </div>

      <div className="sn-appr-toolbar">
        {view === 'pending' && (
          <input
            type="checkbox"
            aria-label="Select all"
            checked={allSelected}
            onChange={() => setSelected(allSelected ? new Set() : new Set(shown.map((a) => a.sys_id)))}
            data-testid="select-all"
          />
        )}
        <div className="sn-appr-filter">
          {(['all', 'change_request', 'sc_req_item'] as Kind[]).map((k) => (
            <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
              {k === 'all' ? 'All' : k === 'change_request' ? 'Changes' : 'Requested Items'}
            </button>
          ))}
        </div>
        <span className="grow" />
        {view === 'pending' && (
          <button className="sn-btn success" disabled={busy || !shown.some((a) => selected.has(a.sys_id))} onClick={bulkApprove} data-testid="bulk-approve">
            Approve selected ({shown.filter((a) => selected.has(a.sys_id)).length})
          </button>
        )}
      </div>

      {items === null ? (
        <div className="sn-appr-list sn-loading">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="sn-appr-list sn-empty-state" data-testid="approvals-empty">
          {view === 'pending' ? 'Nothing waiting on you. Approvals assigned to you will appear here.' : 'No decided approvals yet.'}
        </div>
      ) : view === 'pending' ? (
        <div className="sn-appr-list">
          {shown.map((a) => (
            <div key={a.sys_id} className={`sn-appr-card ${selected.has(a.sys_id) ? 'selected' : ''}`} data-testid="approval-card" data-number={a.document.number}>
              <input type="checkbox" aria-label={`Select ${a.document.number}`} checked={selected.has(a.sys_id)} onChange={() => toggle(a.sys_id)} />
              <div>
                <div className="sn-appr-title">
                  <span className={`sn-appr-type ${a.source_table === 'sc_req_item' ? 'ritm' : ''}`}>{typeLabel(String(a.source_table))}</span>
                  <Link to={recordUrl(String(a.source_table), String(a.document_id))} data-testid="approval-doc-link">
                    {a.document.number}
                  </Link>
                  <span className="muted small">{a.document.state_label}</span>
                </div>
                <div className="sn-appr-sd">{a.document.short_description}</div>
                <DocMeta a={a} now={now} />
              </div>
              <div className="sn-appr-actions">
                <button className="sn-btn success" disabled={busy} onClick={() => setDeciding({ id: a.sys_id, decision: 'approved' })} data-testid="approve-btn">
                  Approve
                </button>
                <button className="sn-btn danger-outline" disabled={busy} onClick={() => setDeciding({ id: a.sys_id, decision: 'rejected' })} data-testid="reject-btn">
                  Reject
                </button>
              </div>
              {deciding?.id === a.sys_id && (
                <ApprovalDecision
                  key={deciding.decision}
                  decision={deciding.decision}
                  busy={busy}
                  onSubmit={(c) => decideOne(a, deciding.decision, c)}
                  onCancel={() => setDeciding(null)}
                />
              )}
            </div>
          ))}
        </div>
      ) : (
        <table className="sn-table" data-testid="approvals-history">
          <thead>
            <tr>
              <th>Number</th>
              <th>Type</th>
              <th>Short description</th>
              <th>Requested by</th>
              <th>My decision</th>
              <th>Comments</th>
              <th>Decided</th>
              <th>Record status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => (
              <tr key={a.sys_id} data-testid="history-row">
                <td>
                  <Link className="sn-link" to={recordUrl(String(a.source_table), String(a.document_id))}>
                    {a.document.number}
                  </Link>
                </td>
                <td>{typeLabel(String(a.source_table))}</td>
                <td>{a.document.short_description}</td>
                <td>{a.document.requested_by_name}</td>
                <td>
                  <span className={`sn-appr-state ${String(a.state)}`}>{APPROVER_STATE_LABEL[String(a.state)]}</span>
                </td>
                <td>{String(a.comments ?? '')}</td>
                <td title={formatDate(String(a.decided_on ?? ''))}>{timeAgo(String(a.decided_on ?? a.sys_updated_on ?? ''))}</td>
                <td>
                  {a.document.state_label} · {a.document.approval}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
