import { TABLES, choiceLabel, getField } from '../shared/schema.ts'
import type { Rec } from './api.ts'

export function displayValue(table: string, rec: Rec, field: string): string {
  const v = rec[field]
  if (v == null || v === '') return ''
  const def = getField(table, field)
  if (!def) return String(v)
  switch (def.type) {
    case 'reference':
      return rec._dv?.[field] ?? String(v)
    case 'choice':
      return choiceLabel(table, field, String(v))
    case 'currency':
      return `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    case 'datetime':
      return formatDate(String(v))
    default:
      return String(v)
  }
}

/** Server stores UTC as `YYYY-MM-DD HH:MM:SS`; show it in local time in the same shape. */
export function formatDate(v: string): string {
  const d = parseDate(v)
  if (!d) return v
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null
  const d = new Date(`${v.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

export function nowStr(d: Date = new Date()): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

export function toInputDate(v: string | null | undefined): string {
  const d = parseDate(v ?? '')
  if (!d) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fromInputDate(v: string): string {
  if (!v) return ''
  return new Date(v).toISOString().slice(0, 19).replace('T', ' ')
}

export function timeAgo(v: string): string {
  const d = parseDate(v)
  if (!d) return v
  const s = Math.round((Date.now() - d.getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function recordTitle(table: string, rec: Rec | null): string {
  const t = TABLES[table]
  if (!t || !rec) return ''
  return String(rec[t.displayField] ?? '')
}

export const listUrl = (table: string, query?: string) => `/list/${table}${query ? `?sysparm_query=${encodeURIComponent(query)}` : ''}`
export const recordUrl = (table: string, id: string, query?: string) => `/record/${table}/${id}${query ? `?${query}` : ''}`

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('')
}

const HISTORY_KEY = 'sn-clone-history'
export interface HistoryItem {
  table: string
  id: string
  title: string
  subtitle: string
  at: number
}

export function pushHistory(item: Omit<HistoryItem, 'at'>) {
  const list = getHistory().filter((h) => h.id !== item.id)
  list.unshift({ ...item, at: Date.now() })
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 15)))
}

export function getHistory(): HistoryItem[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as HistoryItem[]
  } catch {
    return []
  }
}
