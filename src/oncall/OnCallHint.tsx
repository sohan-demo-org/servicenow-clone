import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { oncallApi } from './api.ts'
import type { OnCallNow } from './api.ts'
import './oncall.css'

/** "On call: <name>" hint shown beside an incident's assignment group. */
export function OnCallHint({ groupId }: { groupId: string }) {
  const [oc, setOc] = useState<OnCallNow | null>(null)
  useEffect(() => {
    let live = true
    oncallApi
      .current()
      .then((all) => live && setOc(all.find((g) => g.group.sys_id === groupId) ?? null))
      .catch(() => live && setOc(null))
    return () => {
      live = false
    }
  }, [groupId])
  if (!oc || oc.group.sys_id !== groupId) return null
  return (
    <Link to="/oncall" className="oc-hint" data-testid="oncall-hint" title={`Escalation: ${oc.escalation.map((e) => e.name).join(' → ')}`}>
      <span className="oc-dot" />
      On call: <b>{oc.primary.name}</b>
      {oc.override && <span className="oc-badge">override</span>}
    </Link>
  )
}
