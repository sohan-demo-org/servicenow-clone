import { req } from '../api.ts'
import type { Rec } from '../api.ts'
import type { OnCallNow, OnCallSchedule } from '../../shared/oncall.ts'

export type { OnCallNow, OnCallSchedule }

let cache: { at: number; p: Promise<OnCallNow[]> } | null = null

export const oncallApi = {
  current: (fresh = false) => {
    if (fresh || !cache || Date.now() - cache.at > 30000) {
      cache = { at: Date.now(), p: req<{ result: OnCallNow[] }>('GET', '/api/now/oncall/current').then((r) => r.result) }
      cache.p.catch(() => (cache = null))
    }
    return cache.p
  },
  schedule: (groupId: string, days = 14, from?: string) =>
    req<{ result: OnCallSchedule }>('GET', `/api/now/oncall/${groupId}/schedule?days=${days}${from ? `&from=${encodeURIComponent(from)}` : ''}`).then((r) => r.result),
  addOverride: (groupId: string, body: { member: string; start: string; end: string; reason: string }) =>
    req<{ result: Rec }>('POST', `/api/now/oncall/${groupId}/override`, body).then((r) => {
      cache = null
      return r.result
    }),
}

export function endsIn(utc: string, now = Date.now()): string {
  const ms = Date.parse(`${utc.replace(' ', 'T')}Z`) - now
  if (Number.isNaN(ms)) return ''
  const h = Math.max(0, Math.floor(ms / 3600000))
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))}m`
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('')

export const MEMBER_COLORS = ['#5aa1e3', '#81b5a1', '#f5a623', '#9b8ae0', '#3ec1c9', '#e07a9b']
