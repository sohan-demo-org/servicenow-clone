import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { isAgent, useAuth } from './auth.tsx'
import { notificationUrl, notificationsApi } from './notifications.ts'
import type { AppNotification } from './notifications.ts'

export function useOpenNotification() {
  const { user } = useAuth()
  const navigate = useNavigate()
  return useCallback(
    async (n: AppNotification) => {
      if (n.read !== 'true') await notificationsApi.markRead(n.sys_id).catch(() => {})
      navigate(notificationUrl(n, isAgent(user)))
    },
    [navigate, user],
  )
}
