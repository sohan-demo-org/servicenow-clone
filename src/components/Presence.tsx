import { useEffect, useRef, useState } from 'react'
import { api, clientId } from '../api.ts'
import type { RecordEvent, Viewer } from '../api.ts'
import { getField } from '../../shared/schema.ts'
import { initials } from '../util.ts'

const PALETTE = ['#e8743b', '#7b61ff', '#19a979', '#ed4a7b', '#278efc', '#c99a00', '#13a4b4', '#945ecf']

// oxlint-disable-next-line react/only-export-components
export function presenceColor(userId: string): string {
  let h = 0
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

/**
 * Joins the live presence room for a record: reports which fields this tab is editing and
 * returns everyone else who has the record open. `onEvent` receives changes made by other tabs.
 */
// oxlint-disable-next-line react/only-export-components
export function usePresence(table: string, id: string, enabled: boolean, editing: string[], onEvent: (e: RecordEvent) => void) {
  const [viewers, setViewers] = useState<Viewer[]>([])
  const [connected, setConnected] = useState(false)
  const onEventRef = useRef(onEvent)
  const editingRef = useRef(editing)
  useEffect(() => {
    onEventRef.current = onEvent
    editingRef.current = editing
  })
  const editingKey = editing.join(',')

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return
    const es = new EventSource(api.presenceStreamUrl(table, id))
    es.addEventListener('hello', () => {
      setConnected(true)
      if (editingRef.current.length) api.setEditing(table, id, editingRef.current).catch(() => {})
    })
    es.addEventListener('presence', (m) => setViewers((JSON.parse((m as MessageEvent).data) as { viewers: Viewer[] }).viewers))
    es.addEventListener('record', (m) => {
      const ev = JSON.parse((m as MessageEvent).data) as RecordEvent
      if (ev.client !== clientId) onEventRef.current(ev)
    })
    es.onerror = () => setConnected(false)
    return () => {
      es.close()
      setConnected(false)
      setViewers([])
    }
  }, [table, id, enabled])

  useEffect(() => {
    if (!enabled || !connected) return
    const t = setTimeout(() => api.setEditing(table, id, editingKey ? editingKey.split(',') : []).catch(() => {}), 250)
    return () => clearTimeout(t)
  }, [table, id, enabled, connected, editingKey])

  return { viewers: viewers.filter((v) => v.client !== clientId), connected }
}

export function PresenceBar({ table, viewers, connected, selfId }: { table: string; viewers: Viewer[]; connected: boolean; selfId?: string }) {
  const label = (v: Viewer) => (v.user.sys_id === selfId ? 'You (another tab)' : v.user.name)
  const fields = (v: Viewer) => v.editing.map((f) => getField(table, f)?.label ?? f).join(', ')
  return (
    <div className="sn-presence" data-testid="presence-bar">
      <span className={`sn-live ${connected ? 'on' : ''}`} title={connected ? 'Live updates connected' : 'Live updates disconnected'}>
        <i /> {connected ? 'Live' : 'Offline'}
      </span>
      {viewers.length > 0 && (
        <div className="sn-presence-stack">
          {viewers.slice(0, 5).map((v) => (
            <span
              key={v.client}
              className={`sn-presence-avatar ${v.editing.length ? 'editing' : ''}`}
              style={{ '--pc': presenceColor(v.user.sys_id) } as React.CSSProperties}
              title={v.editing.length ? `${label(v)} is editing ${fields(v)}` : `${label(v)} is viewing`}
              data-testid="presence-avatar"
            >
              {initials(v.user.name)}
              {v.editing.length > 0 && <b className="sn-presence-pen">✎</b>}
            </span>
          ))}
          {viewers.length > 5 && <span className="sn-presence-avatar more">+{viewers.length - 5}</span>}
        </div>
      )}
      {viewers.length > 0 && (
        <span className="sn-presence-text" data-testid="presence-text">
          {viewers.length === 1
            ? `${label(viewers[0])} is ${viewers[0].editing.length ? 'editing' : 'viewing'}`
            : `${viewers.length} others here`}
        </span>
      )}
    </div>
  )
}
