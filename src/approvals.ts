import { useEffect, useSyncExternalStore } from 'react'
import { getApiUser } from './api.ts'
import type { Rec } from './api.ts'

export type Decision = 'approved' | 'rejected'

export interface ApprovalDoc {
  number: string
  short_description: string | null
  approval: string
  state: string
  state_label: string
  requested_by: string | null
  requested_by_name: string
  risk?: string
  risk_label?: string
  type_label?: string
  cmdb_ci_name?: string
  group_name?: string
  start_date?: string | null
  price?: number
  quantity?: number
  item_name?: string
  stage_label?: string
}

export type ApprovalItem = Rec & { document: ApprovalDoc; others: { approver: string; state: string }[] }

export interface BulkResult {
  sys_id: string
  ok: boolean
  number?: string
  error?: string
}

const listeners = new Set<() => void>()
let pending = 0

function setPending(n: number) {
  pending = n
  for (const l of listeners) l()
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const u = getApiUser()
  if (u) headers['X-User'] = u
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error([json?.error?.message, json?.error?.detail].filter(Boolean).join(': ') || res.statusText)
  return json as T
}

export const approvalsApi = {
  mine: async (view: 'pending' | 'history') => {
    const r = await call<{ result: ApprovalItem[]; pending: number }>('GET', `/api/now/approvals/mine?view=${view}`)
    setPending(r.pending)
    return r.result
  },
  forDocument: (table: string, id: string) => call<{ result: Rec[]; round: number }>('GET', `/api/now/approvals/document/${table}/${id}`),
  decide: async (id: string, decision: Decision, comment: string) => {
    const r = await call<{ result: { approval: Rec; document: Rec } }>('POST', `/api/now/approvals/${id}`, { decision, comment })
    void refreshApprovalCount()
    return r.result
  },
  bulk: async (ids: string[], decision: Decision, comment = '') => {
    const r = await call<{ result: BulkResult[] }>('POST', '/api/now/approvals/bulk', { ids, decision, comment })
    void refreshApprovalCount()
    return r.result
  },
}

export async function refreshApprovalCount(): Promise<void> {
  if (!getApiUser()) return setPending(0)
  const r = await call<{ result: { pending: number } }>('GET', '/api/now/approvals/count').catch(() => null)
  if (r) setPending(r.result.pending)
}

/** Live count of the current user's pending approvals, shared by the navigator and header. */
export function useApprovalCount(userId: string | undefined): number {
  const n = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => pending,
  )
  useEffect(() => {
    void refreshApprovalCount()
    const t = setInterval(() => void refreshApprovalCount(), 30000)
    return () => clearInterval(t)
  }, [userId])
  return n
}

export const APPROVER_STATE_LABEL: Record<string, string> = { requested: 'Requested', approved: 'Approved', rejected: 'Rejected', cancelled: 'No Longer Required' }
