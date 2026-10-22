import { useState } from 'react'
import type { Decision } from '../approvals.ts'

/** Inline comment box for an approve/reject decision. A comment is mandatory when rejecting. */
export function ApprovalDecision({ decision, busy, onSubmit, onCancel }: { decision: Decision; busy?: boolean; onSubmit: (comment: string) => void; onCancel: () => void }) {
  const [comment, setComment] = useState('')
  const [touched, setTouched] = useState(false)
  const reject = decision === 'rejected'
  const missing = reject && !comment.trim()
  return (
    <div className="sn-appr-decide" data-testid="approval-decision">
      <div className="col">
        <textarea
          autoFocus
          value={comment}
          className={touched && missing ? 'invalid' : ''}
          placeholder={reject ? 'Reason for rejection (required)' : 'Comment (optional)'}
          aria-label={reject ? 'Rejection comment' : 'Approval comment'}
          onChange={(e) => setComment(e.target.value)}
          data-testid="approval-comment"
        />
        {touched && missing && <div className="hint">A comment is required to reject.</div>}
      </div>
      <button
        className={`sn-btn ${reject ? 'danger' : 'success'}`}
        disabled={busy}
        onClick={() => {
          setTouched(true)
          if (!missing) onSubmit(comment.trim())
        }}
        data-testid="approval-confirm"
      >
        {reject ? 'Confirm reject' : 'Confirm approve'}
      </button>
      <button className="sn-btn" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </div>
  )
}
