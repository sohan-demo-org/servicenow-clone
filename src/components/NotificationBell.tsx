import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Icon } from './Icon.tsx'
import { useAuth } from '../auth.tsx'
import { useOpenNotification } from '../useOpenNotification.ts'
import { formatDate, timeAgo } from '../util.ts'
import { NOTIFICATIONS_CHANGED, notificationsApi } from '../notifications.ts'
import type { AppNotification, NotificationType } from '../notifications.ts'
import '../notifications.css'

const POLL_MS = 10_000

const TYPE_PATHS: Partial<Record<NotificationType, string>> = {
  assigned: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-4 0-8 2-8 5v1h16v-1c0-3-4-5-8-5z',
  state_change: 'M12 4V1L8 5l4 4V6a6 6 0 0 1 6 6h2a8 8 0 0 0-8-8zm-6 8H4a8 8 0 0 0 8 8v3l4-4-4-4v3a6 6 0 0 1-6-6z',
  comment: 'M4 4h16v12H8l-4 4z',
}

export function NotificationIcon({ type }: { type: NotificationType }) {
  const path = TYPE_PATHS[type]
  return (
    <span className={`sn-notif-icon ${type}`} aria-hidden="true">
      {path ? (
        <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor">
          <path d={path} />
        </svg>
      ) : (
        '@'
      )}
    </span>
  )
}

export function NotificationRow({ n, onOpen, children }: { n: AppNotification; onOpen: (n: AppNotification) => void; children?: React.ReactNode }) {
  const unread = n.read !== 'true'
  return (
    <div
      role="button"
      tabIndex={0}
      className={`sn-notif-item ${unread ? 'unread' : ''}`}
      data-testid="notif-item"
      data-unread={unread}
      onClick={() => onOpen(n)}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(n)}
    >
      <NotificationIcon type={n.type} />
      <div className="sn-notif-body">
        <div className="sn-notif-msg">{n.message}</div>
        <div className="sn-notif-meta">
          {n.document_number && <b>{n.document_number}</b>}
          {n.actor_name && <> · {n.actor_name}</>} · <span title={formatDate(n.sys_created_on)}>{timeAgo(n.sys_created_on)}</span>
        </div>
      </div>
      {children}
      {unread && <span className="sn-notif-dot" title="Unread" />}
    </div>
  )
}

export function NotificationBell() {
  const { user } = useAuth()
  const location = useLocation()
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<AppNotification[] | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const openNotification = useOpenNotification()

  const refreshCount = useCallback(() => {
    notificationsApi.unreadCount().then(setUnread, () => {})
  }, [])
  const refreshList = useCallback(() => {
    notificationsApi.list({ limit: 8 }).then((r) => {
      setItems(r.result)
      setUnread(r.unread)
    }, () => {})
  }, [])

  useEffect(() => {
    refreshCount()
    const t = window.setInterval(refreshCount, POLL_MS)
    window.addEventListener(NOTIFICATIONS_CHANGED, refreshCount)
    window.addEventListener('focus', refreshCount)
    return () => {
      window.clearInterval(t)
      window.removeEventListener(NOTIFICATIONS_CHANGED, refreshCount)
      window.removeEventListener('focus', refreshCount)
    }
  }, [refreshCount, user?.sys_id, location.pathname])

  useEffect(() => {
    if (!open) return
    refreshList()
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open, refreshList])

  const onOpen = async (n: AppNotification) => {
    setOpen(false)
    await openNotification(n)
  }

  return (
    <div className="sn-notif-wrap" ref={ref}>
      <button className="sn-icon-btn" title="Notifications" aria-label={`Notifications, ${unread} unread`} onClick={() => setOpen(!open)} data-testid="notif-bell">
        <Icon name="bell" size={20} />
        {unread > 0 && (
          <span className="sn-badge" data-testid="notif-badge">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="sn-dropdown right sn-notif-panel" data-testid="notif-panel">
          <div className="sn-notif-head">
            <b>Notifications {unread > 0 && <span className="muted">({unread} unread)</span>}</b>
            <button
              className="sn-notif-link"
              disabled={unread === 0}
              data-testid="notif-mark-all"
              onClick={async () => {
                await notificationsApi.markAllRead()
                refreshList()
              }}
            >
              Mark all as read
            </button>
          </div>
          <div className="sn-notif-list">
            {items === null && <div className="sn-notif-empty">Loading…</div>}
            {items?.length === 0 && <div className="sn-notif-empty">You're all caught up.</div>}
            {items?.map((n) => <NotificationRow key={n.sys_id} n={n} onOpen={onOpen} />)}
          </div>
          <Link to="/notifications" className="sn-notif-footer" onClick={() => setOpen(false)} data-testid="notif-view-all">
            View all notifications
          </Link>
        </div>
      )}
    </div>
  )
}
