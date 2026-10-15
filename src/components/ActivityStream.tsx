import { useState } from 'react'
import type { JournalEntry } from '../api.ts'
import { formatDate, initials, timeAgo } from '../util.ts'

interface Props {
  entries: JournalEntry[]
  onPost: (element: 'work_notes' | 'comments', value: string) => Promise<void>
  allowWorkNotes: boolean
  hideAudit?: boolean
}

export function ActivityStream({ entries, onPost, allowWorkNotes, hideAudit }: Props) {
  const [workNotes, setWorkNotes] = useState(allowWorkNotes)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<'all' | 'work_notes' | 'comments' | 'audit'>('all')
  const visible = entries.filter((e) => (hideAudit ? e.element !== 'audit' : true)).filter((e) => (allowWorkNotes ? true : e.element === 'comments')).filter((e) => filter === 'all' || e.element === filter)

  const post = async () => {
    if (!text.trim()) return
    setBusy(true)
    try {
      await onPost(workNotes ? 'work_notes' : 'comments', text.trim())
      setText('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sn-activity">
      <div className={`sn-compose ${workNotes ? 'work' : ''}`}>
        <textarea
          className="sn-input"
          rows={3}
          placeholder={workNotes ? 'Work notes (internal, visible to fulfillers only)' : 'Additional comments (customer visible)'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="journal-input"
        />
        <div className="sn-compose-bar">
          {allowWorkNotes && (
            <label className="sn-check">
              <input type="checkbox" checked={workNotes} onChange={(e) => setWorkNotes(e.target.checked)} data-testid="work-notes-toggle" /> Work notes
            </label>
          )}
          <button className="sn-btn primary" disabled={busy || !text.trim()} onClick={post} data-testid="journal-post">
            Post
          </button>
        </div>
      </div>
      <div className="sn-activity-head">
        <b>Activities: {visible.length}</b>
        {allowWorkNotes && (
          <div className="sn-seg">
            {(['all', 'work_notes', 'comments', 'audit'] as const).map((f) => (
              <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : f === 'work_notes' ? 'Work notes' : f === 'comments' ? 'Comments' : 'Field changes'}
              </button>
            ))}
          </div>
        )}
      </div>
      <ul className="sn-stream" data-testid="activity-stream">
        {visible.map((e) => (
          <li key={e.sys_id} className={`sn-entry ${e.element}`}>
            <div className="sn-avatar sm">{initials(e.sys_created_by)}</div>
            <div className="sn-entry-body">
              <div className="sn-entry-meta">
                <b>{e.sys_created_by}</b>
                <span className="sn-entry-type">{e.element === 'work_notes' ? 'Work notes' : e.element === 'comments' ? 'Additional comments' : 'Field changes'}</span>
                <span className="muted" title={formatDate(e.sys_created_on)}>
                  {timeAgo(e.sys_created_on)}
                </span>
              </div>
              {e.element === 'audit' ? (
                <table className="sn-audit">
                  <tbody>
                    {(JSON.parse(e.value) as { label: string; old: string; new: string }[]).map((c, i) => (
                      <tr key={i}>
                        <td className="lbl">{c.label}</td>
                        <td>
                          <b>{c.new || '(empty)'}</b>
                          {c.old && <span className="muted"> was {c.old}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
