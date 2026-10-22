import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Rec } from '../api.ts'
import { useAuth } from '../auth.tsx'
import { APPROVER_STATE_LABEL, approvalsApi } from '../approvals.ts'
import type { Decision } from '../approvals.ts'
import { formatDate, recordUrl } from '../util.ts'
import { ApprovalDecision } from './ApprovalDecision.tsx'
import { Icon } from './Icon.tsx'
import '../approvals.css'

/** "Approvers" section on change_request / sc_req_item forms, with decision buttons for a pending approver. */
export function ApproversSection({ table, id, version, onDecided }: { table: string; id: string; version?: string; onDecided: (doc: Rec, decision: Decision) => void }) {
  const { user } = useAuth()
  const [rows, setRows] = useState<Rec[]>([])
  const [round, setRound] = useState(0)
  const [showOld, setShowOld] = useState(false)
  const [deciding, setDeciding] = useState<Decision | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(() => approvalsApi.forDocument(table, id), [table, id])
  const apply = (r: { result: Rec[]; round: number }) => {
    setRows(r.result)
    setRound(r.round)
  }

  useEffect(() => {
    let alive = true
    load().then((r) => {
      if (!alive) return
      setRows(r.result)
      setRound(r.round)
    })
    return () => {
      alive = false
    }
  }, [load, version])

  const mine = rows.find((r) => r.approver === user?.sys_id && r.state === 'requested')
  const current = rows.filter((r) => Number(r.iteration) === round)
  const older = rows.filter((r) => Number(r.iteration) !== round)
  const shown = showOld ? [...current, ...older] : current

  const submit = async (comment: string) => {
    if (!mine || !deciding) return
    setBusy(true)
    setError('')
    try {
      const r = await approvalsApi.decide(mine.sys_id, deciding, comment)
      setDeciding(null)
      apply(await load())
      onDecided(r.document, deciding)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sn-appr-section" data-testid="approvers-section">
      <div className="sn-appr-section-head">
        Approvers <span className="muted">({current.length})</span>
        <span className="muted small" style={{ marginLeft: 'auto' }}>
          Any one approval approves · any rejection rejects
        </span>
      </div>
      {mine && (
        <div className="sn-appr-mine" data-testid="my-pending-approval">
          <Icon name="info" size={16} />
          <span className="grow">Your approval is requested{mine.due_date ? ` · due ${formatDate(String(mine.due_date))}` : ''}.</span>
          <button className="sn-btn success" onClick={() => setDeciding('approved')} data-testid="form-approve">
            Approve
          </button>
          <button className="sn-btn danger-outline" onClick={() => setDeciding('rejected')} data-testid="form-reject">
            Reject
          </button>
        </div>
      )}
      {mine && deciding && <ApprovalDecision key={deciding} decision={deciding} busy={busy} onSubmit={submit} onCancel={() => setDeciding(null)} />}
      {error && <div className="sn-msg error">{error}</div>}
      {rows.length === 0 ? (
        <div className="muted" style={{ padding: 12 }}>
          No approvers. Approvers are created when approval is requested.
        </div>
      ) : (
        <table className="sn-table compact">
          <thead>
            <tr>
              <th>Approver</th>
              <th>State</th>
              <th>Comments</th>
              <th>Due date</th>
              <th>Decided on</th>
              <th>Round</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.sys_id} className={Number(r.iteration) !== round ? 'sn-appr-old' : ''} data-testid="approver-row">
                <td>
                  <Link to={recordUrl('sysapproval_approver', r.sys_id)}>{r._dv?.approver ?? ''}</Link>
                  {r.approver === user?.sys_id && <span className="muted small"> (you)</span>}
                </td>
                <td>
                  <span className={`sn-appr-state ${String(r.state)}`}>{APPROVER_STATE_LABEL[String(r.state)] ?? String(r.state)}</span>
                </td>
                <td>{String(r.comments ?? '')}</td>
                <td>{formatDate(String(r.due_date ?? ''))}</td>
                <td>{formatDate(String(r.decided_on ?? ''))}</td>
                <td>{String(r.iteration ?? '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {older.length > 0 && (
        <button className="sn-link" style={{ margin: '6px 12px 10px', background: 'none', border: 0 }} onClick={() => setShowOld(!showOld)}>
          {showOld ? 'Hide' : 'Show'} {older.length} approver{older.length === 1 ? '' : 's'} from earlier rounds
        </button>
      )}
    </div>
  )
}
