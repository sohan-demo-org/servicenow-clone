export type Rec = Record<string, string | number | null> & { sys_id: string; _dv?: Record<string, string> }

export interface ListResult {
  result: Rec[]
  total: number
}

export interface JournalEntry {
  sys_id: string
  element: 'work_notes' | 'comments' | 'audit'
  value: string
  sys_created_by: string
  sys_created_on: string
}

export interface StatRow {
  value: string
  label: string
  count: number
}

export interface Conflict {
  type: 'ci_already_scheduled' | 'assignee_already_scheduled' | 'blackout' | 'invalid_window'
  label: string
  message: string
  related?: { table: string; sys_id: string; display: string; start_date: string; end_date: string }
}

export interface ScheduleSlot {
  sys_id?: string
  cmdb_ci?: string | null
  assigned_to?: string | null
  start_date?: string | null
  end_date?: string | null
}

export interface ChangeScheduleData {
  changes: Rec[]
  blackouts: Rec[]
  conflicts: Record<string, Conflict[]>
}

export class ApiError extends Error {
  detail: string
  constructor(message: string, detail: string) {
    super(message)
    this.detail = detail
  }
}

let currentUserId: string | null = null
export function setApiUser(id: string | null) {
  currentUserId = id
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (currentUserId) headers['X-User'] = currentUserId
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  if (res.status === 204) return undefined as T
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(json?.error?.message ?? res.statusText, json?.error?.detail ?? '')
  return json as T
}

export const api = {
  login: (user_name: string, password: string) => req<{ result: Rec }>('POST', '/api/login', { user_name, password }).then((r) => r.result),
  list: (table: string, params: { query?: string; text?: string; limit?: number; offset?: number } = {}) => {
    const sp = new URLSearchParams()
    if (params.query) sp.set('sysparm_query', params.query)
    if (params.text) sp.set('sysparm_text', params.text)
    sp.set('sysparm_limit', String(params.limit ?? 20))
    sp.set('sysparm_offset', String(params.offset ?? 0))
    return req<ListResult>('GET', `/api/now/table/${table}?${sp}`)
  },
  get: (table: string, id: string) => req<{ result: Rec }>('GET', `/api/now/table/${table}/${id}`).then((r) => r.result),
  create: (table: string, body: Record<string, unknown>) => req<{ result: Rec }>('POST', `/api/now/table/${table}`, body).then((r) => r.result),
  update: (table: string, id: string, body: Record<string, unknown>) => req<{ result: Rec }>('PATCH', `/api/now/table/${table}/${id}`, body).then((r) => r.result),
  remove: (table: string, id: string) => req<void>('DELETE', `/api/now/table/${table}/${id}`),
  journal: (table: string, id: string) => req<{ result: JournalEntry[] }>('GET', `/api/now/journal/${table}/${id}`).then((r) => r.result),
  addJournal: (table: string, id: string, element: 'work_notes' | 'comments', value: string) =>
    req<{ result: JournalEntry }>('POST', `/api/now/journal/${table}/${id}`, { element, value }).then((r) => r.result),
  stats: (table: string, groupBy: string, query?: string) => {
    const sp = new URLSearchParams({ sysparm_group_by: groupBy })
    if (query) sp.set('sysparm_query', query)
    return req<{ result: StatRow[] }>('GET', `/api/now/stats/${table}?${sp}`).then((r) => r.result)
  },
  order: (itemId: string, body: { quantity: number; requested_for?: string; variables?: Record<string, string> }) =>
    req<{ result: Rec }>('POST', `/api/now/catalog/${itemId}/order`, body).then((r) => r.result),
  approve: (table: string, id: string, decision: 'approved' | 'rejected', comment?: string) =>
    req<{ result: Rec }>('POST', `/api/now/approval/${table}/${id}`, { decision, comment }).then((r) => r.result),
  kbView: (id: string) => req<{ result: Rec }>('POST', `/api/now/kb/${id}/view`).then((r) => r.result),
  kbHelpful: (id: string) => req<{ result: Rec }>('POST', `/api/now/kb/${id}/helpful`).then((r) => r.result),
  changeSchedule: (from: string, to: string) =>
    req<{ result: ChangeScheduleData }>('GET', `/api/now/change_schedule?${new URLSearchParams({ from, to })}`).then((r) => r.result),
  changeConflicts: (slot: ScheduleSlot) => req<{ result: Conflict[] }>('POST', '/api/now/change_schedule/conflicts', slot).then((r) => r.result),
  nextWindow: (id: string, after?: string) =>
    req<{ result: { start_date: string; end_date: string } }>('POST', `/api/now/change_schedule/${id}/next_window`, { after }).then((r) => r.result),
  search: (q: string) =>
    req<{ result: { table: string; label: string; total: number; records: Rec[] }[] }>('GET', `/api/now/search?q=${encodeURIComponent(q)}`).then((r) => r.result),
}
