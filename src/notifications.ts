import { req } from './api.ts'
import { recordUrl } from './util.ts'

export type NotificationType = 'assigned' | 'state_change' | 'mention' | 'comment'

export interface AppNotification {
  sys_id: string
  recipient: string
  type: NotificationType
  source_table: string
  document_id: string
  document_number: string
  message: string
  actor: string | null
  actor_name: string | null
  read: 'true' | 'false'
  sys_created_on: string
}

export interface NotificationList {
  result: AppNotification[]
  total: number
  unread: number
  by_type: { type: NotificationType; total: number; unread: number }[]
}

export const TYPE_LABELS: Record<NotificationType, string> = {
  assigned: 'Assigned to me',
  state_change: 'State changes',
  mention: 'Mentions',
  comment: 'Comments',
}

/** Fired after any read-state change so the bell and the full page stay in sync. */
export const NOTIFICATIONS_CHANGED = 'sn-notifications-changed'
const changed = () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED))

export const notificationsApi = {
  list: (params: { limit?: number; type?: string; unread?: boolean } = {}) => {
    const sp = new URLSearchParams({ limit: String(params.limit ?? 20) })
    if (params.type) sp.set('type', params.type)
    if (params.unread) sp.set('unread', 'true')
    return req<NotificationList>('GET', `/api/now/notifications?${sp}`)
  },
  unreadCount: () => req<{ result: { unread: number } }>('GET', '/api/now/notifications/unread_count').then((r) => r.result.unread),
  markRead: (id: string) => req<{ result: { unread: number } }>('POST', `/api/now/notifications/${id}/read`).then((r) => (changed(), r.result.unread)),
  markAllRead: () => req<{ result: { unread: number } }>('POST', '/api/now/notifications/read_all').then((r) => (changed(), r.result.unread)),
}

export function notificationUrl(n: AppNotification, agent: boolean): string {
  return agent ? recordUrl(n.source_table, n.document_id) : `/sp/ticket/${n.source_table}/${n.document_id}`
}
