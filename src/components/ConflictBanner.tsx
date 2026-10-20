import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.ts'
import type { Conflict, ScheduleSlot } from '../api.ts'
import { recordUrl } from '../util.ts'

/** Live change-conflict check for the values currently on the change form (including unsaved edits). */
export function ConflictBanner({ slot, inactive }: { slot: ScheduleSlot; inactive: boolean }) {
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null)
  const { sys_id, cmdb_ci, assigned_to, start_date, end_date } = slot
  const ready = Boolean(start_date && end_date) && !inactive

  useEffect(() => {
    if (!ready) return
    let live = true
    const t = setTimeout(() => {
      api
        .changeConflicts({ sys_id, cmdb_ci, assigned_to, start_date, end_date })
        .then((r) => live && setConflicts(r))
        .catch(() => {})
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [ready, sys_id, cmdb_ci, assigned_to, start_date, end_date])

  if (!ready || !conflicts) return null
  const scheduleLink = sys_id ? (
    <Link className="sn-link-subtle" to={`/change/schedule?focus=${sys_id}`}>
      View on Change Schedule
    </Link>
  ) : null
  if (!conflicts.length)
    return (
      <div className="cs-banner ok" data-testid="conflict-banner-ok">
        <b>No scheduling conflicts</b> for the planned window. {scheduleLink}
      </div>
    )
  return (
    <div className="cs-banner bad" data-testid="conflict-banner">
      <div>
        <b>
          {conflicts.length} scheduling conflict{conflicts.length > 1 ? 's' : ''}
        </b>{' '}
        {scheduleLink}
      </div>
      <ul>
        {conflicts.map((c, i) => (
          <li key={i}>
            <span className="cs-banner-label">{c.label}:</span> {c.message}
            {c.related && (
              <>
                {' '}
                (<Link className="sn-link-subtle" to={recordUrl(c.related.table, c.related.sys_id)}>{c.related.display}</Link>)
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
