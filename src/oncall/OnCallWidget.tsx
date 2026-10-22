import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { endsIn, initials, oncallApi } from './api.ts'
import type { OnCallNow } from './api.ts'
import './oncall.css'

export function OnCallWidget() {
  const [rows, setRows] = useState<OnCallNow[] | null>(null)
  useEffect(() => {
    oncallApi
      .current(true)
      .then(setRows)
      .catch(() => setRows([]))
  }, [])
  return (
    <section className="sn-widget wide" data-testid="oncall-widget">
      <h3>
        On Call Now
        <Link className="sn-link small" to="/oncall">
          View schedule
        </Link>
      </h3>
      <div className="oc-widget-list">
        {rows === null && <span className="muted">Loading…</span>}
        {rows?.length === 0 && <span className="muted">No active rotas</span>}
        {rows?.map((g) => (
          <Link key={g.group.sys_id} to="/oncall" className={`oc-widget-item ${g.override ? 'ovr' : ''}`}>
            <span className="oc-avatar small">{initials(g.primary.name)}</span>
            <span className="oc-widget-text">
              <span className="oc-widget-group">{g.group.name}</span>
              <span className="oc-widget-name">
                {g.primary.name}
                {g.override && <span className="oc-badge">override</span>}
              </span>
              <span className="muted small">ends in {endsIn(g.shift_end)}</span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  )
}
