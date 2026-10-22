import { useCallback, useEffect, useState } from 'react'
import { NotificationRow } from '../components/NotificationBell.tsx'
import { useOpenNotification } from '../useOpenNotification.ts'
import { usePageTitle } from '../components/Layout.tsx'
import { NOTIFICATIONS_CHANGED, TYPE_LABELS, notificationsApi } from '../notifications.ts'
import type { NotificationList, NotificationType } from '../notifications.ts'

type Filter = 'all' | 'unread' | NotificationType
const FILTERS: Filter[] = ['all', 'unread', 'assigned', 'mention', 'state_change', 'comment']

export function NotificationsPage() {
  usePageTitle('Notifications')
  const [filter, setFilter] = useState<Filter>('all')
  const [data, setData] = useState<NotificationList | null>(null)
  const openNotification = useOpenNotification()

  const load = useCallback(() => {
    notificationsApi
      .list({ limit: 200, type: filter === 'all' || filter === 'unread' ? undefined : filter, unread: filter === 'unread' })
      .then(setData, () => {})
  }, [filter])

  useEffect(() => {
    load()
    window.addEventListener(NOTIFICATIONS_CHANGED, load)
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED, load)
  }, [load])

  const total = data?.by_type.reduce((s, t) => s + t.total, 0) ?? 0
  const count = (f: Filter) => (f === 'all' ? total : f === 'unread' ? (data?.unread ?? 0) : (data?.by_type.find((t) => t.type === f)?.total ?? 0))
  const unreadOf = (f: Filter) => (f === 'all' || f === 'unread' ? 0 : (data?.by_type.find((t) => t.type === f)?.unread ?? 0))

  return (
    <div>
      <div className="sn-titlebar">
        <h1>Notifications</h1>
        <span className="muted">{data ? `${data.unread} unread of ${total}` : ''}</span>
        <div className="sn-titlebar-right">
          <div className="sn-notif-tabs" role="tablist">
            {FILTERS.map((f) => (
              <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)} data-testid={`notif-filter-${f}`}>
                {f === 'all' ? 'All' : f === 'unread' ? 'Unread' : TYPE_LABELS[f]} <span className="muted">({count(f)})</span>
                {unreadOf(f) > 0 && <span className="cnt">{unreadOf(f)}</span>}
              </button>
            ))}
          </div>
          <button className="sn-btn" disabled={!data?.unread} onClick={() => notificationsApi.markAllRead()} data-testid="notif-page-mark-all">
            Mark all as read
          </button>
        </div>
      </div>
      <div className="sn-notif-page">
        <div className="sn-notif-card" data-testid="notif-page-list">
          {data === null && <div className="sn-notif-empty">Loading…</div>}
          {data?.result.length === 0 && <div className="sn-notif-empty">No notifications{filter !== 'all' ? ' match this filter' : ''}.</div>}
          {data?.result.map((n) => (
            <NotificationRow key={n.sys_id} n={n} onOpen={openNotification}>
              {n.read !== 'true' && (
                <div className="sn-notif-row-actions">
                  <button
                    className="sn-notif-link"
                    onClick={(e) => {
                      e.stopPropagation()
                      notificationsApi.markRead(n.sys_id)
                    }}
                  >
                    Mark read
                  </button>
                </div>
              )}
            </NotificationRow>
          ))}
        </div>
      </div>
    </div>
  )
}
