import { HttpError, getRecord, listJournal } from './db.ts'
import type { Db, Row } from './db.ts'
import { TABLES, choiceLabel } from '../shared/schema.ts'

/** Now Assist: GenAI skills (summarize, suggest resolution, draft KB) grounded in the record, its activity and the knowledge base. */

export type Skill = 'summarize' | 'resolve' | 'kb_draft'
export const SKILLS: Skill[] = ['summarize', 'resolve', 'kb_draft']

export interface LlmMessage {
  role: 'system' | 'user'
  content: string
}
export interface LlmResult {
  text: string
  model: string
  provider: string
}
export type LlmFn = (messages: LlmMessage[]) => Promise<LlmResult>

export interface Source {
  table: 'kb_knowledge' | 'incident'
  sys_id: string
  number: string
  title: string
  score: number
}

export interface TimelineItem {
  when: string
  who: string
  what: string
}

export interface SummaryOut {
  headline: string
  summary: string
  sentiment: 'frustrated' | 'neutral' | 'satisfied'
  timeline: TimelineItem[]
  next_steps: string[]
}
export interface ResolveOut {
  confidence: number
  rationale: string
  steps: string[]
  close_code: string
  close_notes: string
  sources: Source[]
}
export interface KbDraftOut {
  short_description: string
  kb_category: string
  text: string
  sources: Source[]
}

export interface AssistResponse {
  skill: Skill
  table: string
  sys_id: string
  provider: string
  model: string
  latency_ms: number
  fallback_reason?: string
  output: SummaryOut | ResolveOut | KbDraftOut
}

const SKILL_TABLES: Record<Skill, string[]> = {
  summarize: ['incident', 'problem', 'change_request', 'sc_req_item'],
  resolve: ['incident'],
  kb_draft: ['incident'],
}

const CLOSE_CODES = ['Solved (Permanently)', 'Solved (Work Around)', 'Not Solved (Not Reproducible)', 'Closed/Resolved by Caller']
const KB_CATEGORIES = ['email', 'network', 'hardware', 'software', 'security', 'hr']

const STOP = new Set(
  'a an and are as at be been but by can cannot for from has have i in is it its my not of on or since so that the this to was were will with after again every few keeps keep from when while user users our your all any'.split(' '),
)

export function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w))
}

interface Ctx {
  table: string
  rec: Row
  dv: Record<string, string>
  journal: { element: string; value: string; sys_created_by: string; sys_created_on: string }[]
  kb: Source[]
  kbText: Record<string, string>
  similar: (Source & { close_notes: string })[]
}

const s = (v: unknown) => (v == null ? '' : String(v))

function label(ctx: Ctx, field: string): string {
  const v = s(ctx.rec[field])
  if (!v) return ''
  return ctx.dv[field] ?? choiceLabel(ctx.table, field, v)
}

function buildContext(db: Db, table: string, id: string): Ctx {
  const rec = getRecord(db, table, id)
  const dv = ((rec as Record<string, unknown>)._dv ?? {}) as Record<string, string>
  const journal = (listJournal(db, id) as Ctx['journal']).slice().reverse()
  const query = tokens(`${s(rec.short_description)} ${s(rec.short_description)} ${s(rec.description)} ${s(rec.subcategory)} ${journal.filter((j) => j.element !== 'audit').map((j) => j.value).join(' ')}`)
  const qset = new Map<string, number>()
  for (const t of query) qset.set(t, (qset.get(t) ?? 0) + 1)

  const kbRows = db.prepare("SELECT sys_id, number, short_description, text, kb_category FROM kb_knowledge WHERE workflow_state = 'published'").all() as Row[]
  const docFreq = new Map<string, number>()
  const kbTok = kbRows.map((k) => new Set(tokens(`${s(k.short_description)} ${s(k.short_description)} ${s(k.text)}`)))
  for (const set of kbTok) for (const t of set) docFreq.set(t, (docFreq.get(t) ?? 0) + 1)
  const catMap: Record<string, string[]> = { network: ['network'], software: ['software', 'email'], hardware: ['hardware'], security: ['security'], database: ['software'], inquiry: [] }
  const kb = kbRows
    .map((k, i) => {
      let score = 0
      for (const [t, n] of qset) if (kbTok[i].has(t)) score += Math.min(n, 2) * Math.log(1 + kbRows.length / (docFreq.get(t) ?? 1))
      if ((catMap[s(rec.category)] ?? []).includes(s(k.kb_category))) score += 0.5
      return { table: 'kb_knowledge' as const, sys_id: s(k.sys_id), number: s(k.number), title: s(k.short_description), score: Math.round(score * 100) / 100 }
    })
    .filter((k) => k.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
  const kbText: Record<string, string> = {}
  for (const k of kbRows) if (kb.some((x) => x.sys_id === k.sys_id)) kbText[s(k.sys_id)] = s(k.text)

  let similar: Ctx['similar'] = []
  if (table === 'incident') {
    const rows = db
      .prepare("SELECT sys_id, number, short_description, close_notes, cmdb_ci, subcategory FROM incident WHERE sys_id != ? AND state IN ('6','7') AND close_notes IS NOT NULL")
      .all(id) as Row[]
    similar = rows
      .map((r) => {
        let score = 0
        if (rec.cmdb_ci && r.cmdb_ci === rec.cmdb_ci) score += 2
        if (rec.subcategory && r.subcategory === rec.subcategory) score += 1
        const t = new Set(tokens(s(r.short_description)))
        for (const w of qset.keys()) if (t.has(w)) score += 1
        return { table: 'incident' as const, sys_id: s(r.sys_id), number: s(r.number), title: s(r.short_description), score, close_notes: s(r.close_notes) }
      })
      .filter((r) => r.score >= 3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
  }
  return { table, rec, dv, journal, kb, kbText, similar }
}

function describeAudit(value: string): string {
  try {
    const diff = JSON.parse(value) as { label: string; old: string; new: string }[]
    return diff.map((d) => (d.old ? `${d.label} changed from ${d.old} to ${d.new || '(empty)'}` : `${d.label} set to ${d.new}`)).join('; ')
  } catch {
    return value
  }
}

function sentimentOf(ctx: Ctx): SummaryOut['sentiment'] {
  const caller = label(ctx, 'caller_id') || label(ctx, 'requested_for')
  const comments = ctx.journal.filter((j) => j.element === 'comments' && (!caller || j.sys_created_by === caller)).map((j) => j.value.toLowerCase())
  const last = comments.at(-1) ?? ''
  if (/thank|fixed|works now|resolved/.test(last)) return 'satisfied'
  if (comments.some((c) => /still|blocking|urgent|asap|any update|update on this|again|frustrat|unacceptable/.test(c))) return 'frustrated'
  return 'neutral'
}

// ---------- deterministic built-in engine ----------

function builtinSummary(ctx: Ctx): SummaryOut {
  const { rec, table } = ctx
  const def = TABLES[table]
  const who = label(ctx, 'caller_id') || label(ctx, 'requested_for') || label(ctx, 'requested_by') || s(rec.sys_created_by)
  const ci = label(ctx, 'cmdb_ci')
  const state = label(ctx, 'state')
  const group = label(ctx, 'assignment_group')
  const assignee = label(ctx, 'assigned_to')
  const notes = ctx.journal.filter((j) => j.element === 'work_notes')
  const lastNote = notes.at(-1)
  const parts = [
    `${who || 'A user'} reported "${s(rec.short_description)}"${ci ? ` affecting ${ci}` : ''}.`,
    s(rec.description) && s(rec.description) !== s(rec.short_description) ? s(rec.description) : '',
    `It is ${rec.priority ? `a ${label(ctx, 'priority')} ` : ''}${def.label.toLowerCase()} currently ${state || 'open'}${group ? `, with ${group}` : ''}${assignee ? ` (assigned to ${assignee})` : ' and not yet assigned to an individual'}.`,
    lastNote ? `Latest work note from ${lastNote.sys_created_by}: "${lastNote.value}"` : 'No work notes have been recorded yet.',
  ]
  const timeline = ctx.journal.slice(-6).map((j) => ({
    when: j.sys_created_on,
    who: j.sys_created_by,
    what: j.element === 'audit' ? describeAudit(j.value) : `${j.element === 'work_notes' ? 'Work note' : 'Comment'}: ${j.value}`,
  }))
  const st = s(rec.state)
  const next: string[] = []
  if (table === 'incident') {
    if (!assignee) next.push(`Assign an engineer from ${group || 'the appropriate group'}.`)
    if (['1', '2', '3'].includes(st)) {
      if (ctx.kb[0]) next.push(`Walk through ${ctx.kb[0].number} "${ctx.kb[0].title}" with the caller.`)
      if (sentimentOf(ctx) === 'frustrated') next.push('Send the caller a status update - they have chased for progress.')
      next.push('Capture findings as a work note and resolve with resolution notes once confirmed.')
    } else next.push('Confirm with the caller that the fix holds, then let the incident auto-close.')
  } else next.push(`Progress the ${def.label.toLowerCase()} to its next state and record the outcome.`)
  return { headline: s(rec.short_description), summary: parts.filter(Boolean).join(' '), sentiment: sentimentOf(ctx), timeline, next_steps: next }
}

function sentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 3)
}

function builtinResolve(ctx: Ctx): ResolveOut {
  const top = ctx.kb[0]
  const sources: Source[] = [...ctx.kb, ...ctx.similar.map(({ close_notes: _c, ...r }) => (void _c, r))]
  if (!top) {
    return {
      confidence: 20,
      rationale: 'No closely matching knowledge article or resolved incident was found, so this is a generic triage plan.',
      steps: ['Confirm scope: how many users and which locations are affected.', 'Check monitoring and recent changes for the configuration item.', 'Reproduce the issue and capture logs.', 'Escalate to the owning support group with findings.'],
      close_code: 'Solved (Permanently)',
      close_notes: '',
      sources,
    }
  }
  const steps = sentences(ctx.kbText[top.sys_id] ?? '').slice(0, 6)
  const confidence = Math.max(35, Math.min(92, Math.round(40 + top.score * 6 + ctx.similar.length * 5)))
  return {
    confidence,
    rationale: `${top.number} "${top.title}" closely matches the symptoms described${ctx.similar.length ? ` and ${ctx.similar.length} similar incident(s) were resolved previously` : ''}.`,
    steps,
    close_code: 'Solved (Permanently)',
    close_notes: `Followed ${top.number} (${top.title}): ${steps.join(' ')} Confirmed with the caller that service is restored.`,
    sources,
  }
}

function builtinKbDraft(ctx: Ctx): KbDraftOut {
  const { rec } = ctx
  const notes = ctx.journal.filter((j) => j.element === 'work_notes').map((j) => `- ${j.value}`)
  const cat = { network: 'network', software: s(rec.subcategory) === 'email' ? 'email' : 'software', hardware: 'hardware', security: 'security', database: 'software' }[s(rec.category)] ?? 'software'
  const text = [
    `Symptoms\n${s(rec.description) || s(rec.short_description)}`,
    `Applies to\n${label(ctx, 'cmdb_ci') || 'All users'}${rec.subcategory ? ` (${label(ctx, 'subcategory')})` : ''}`,
    notes.length ? `Investigation\n${notes.join('\n')}` : '',
    `Resolution\n${s(rec.close_notes) || 'Document the fix that resolved this incident here.'}`,
    `Source\nDrafted by Now Assist from ${s(rec.number)}.`,
  ]
  return { short_description: `Resolve: ${s(rec.short_description)}`, kb_category: cat, text: text.filter(Boolean).join('\n\n'), sources: ctx.kb }
}

// ---------- LLM engine ----------

function contextBlock(ctx: Ctx): string {
  const fields = TABLES[ctx.table].fields
    .filter((f) => !f.name.startsWith('sys_') && s(ctx.rec[f.name]))
    .map((f) => `${f.label}: ${label(ctx, f.name)}`)
    .join('\n')
  const activity = ctx.journal
    .map((j) => `[${j.sys_created_on}] ${j.sys_created_by} (${j.element}): ${j.element === 'audit' ? describeAudit(j.value) : j.value}`)
    .join('\n')
  const kb = ctx.kb.map((k) => `<article id="${k.sys_id}" number="${k.number}" title="${k.title}">\n${ctx.kbText[k.sys_id]}\n</article>`).join('\n')
  const sim = ctx.similar.map((r) => `<incident id="${r.sys_id}" number="${r.number}" title="${r.title}">Resolution notes: ${r.close_notes}</incident>`).join('\n')
  return `RECORD (${TABLES[ctx.table].label})\n${fields}\n\nACTIVITY (oldest first)\n${activity || '(none)'}\n\nKNOWLEDGE ARTICLES\n${kb || '(none matched)'}\n\nSIMILAR RESOLVED INCIDENTS\n${sim || '(none matched)'}`
}

const SYSTEM =
  'You are Now Assist, the generative AI assistant inside an IT service management platform. You help service desk agents. ' +
  'Ground every statement in the provided RECORD, ACTIVITY, KNOWLEDGE ARTICLES and SIMILAR RESOLVED INCIDENTS. Never invent facts, names, ticket numbers or URLs. ' +
  'Be concise and professional. Respond with a single JSON object only, no markdown fences.'

const INSTRUCTIONS: Record<Skill, string> = {
  summarize:
    'Summarize this record for an agent picking it up. Return JSON: {"headline": string (max 12 words), "summary": string (2-4 sentences: what is wrong, who/what is affected, what has been done, current status), ' +
    '"sentiment": "frustrated"|"neutral"|"satisfied" (the caller\'s sentiment from their comments), "next_steps": string[] (2-4 concrete actions)}.',
  resolve:
    'Suggest how the agent should resolve this incident using ONLY the knowledge articles and similar incidents provided. Return JSON: {"confidence": integer 0-100 (low if sources are weak or absent), ' +
    '"rationale": string (1-2 sentences, cite article numbers), "steps": string[] (3-6 imperative steps), "close_code": one of ' +
    JSON.stringify(CLOSE_CODES) +
    ', "close_notes": string (resolution notes written in past tense as if the steps worked), "source_ids": string[] (ids of the articles/incidents you relied on)}.',
  kb_draft:
    'Draft a reusable knowledge article from how this incident was handled, written for end users and agents (no ticket-specific names). Return JSON: {"short_description": string (a "How to" style title), ' +
    '"kb_category": one of ' +
    JSON.stringify(KB_CATEGORIES) +
    ', "text": string (plain text with sections separated by blank lines: Symptoms, Cause, Resolution (numbered steps), Applies to)}.',
}

function parseJson(text: string): Record<string, unknown> {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) throw new Error('LLM returned no JSON object')
  return JSON.parse(m[0]) as Record<string, unknown>
}

const strArr = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()).slice(0, max) : [])
const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback)

/** Validate and clamp model output so the UI only ever receives well-formed, grounded data. */
export function normalize(skill: Skill, raw: Record<string, unknown>, ctx: Ctx): SummaryOut | ResolveOut | KbDraftOut {
  if (skill === 'summarize') {
    const base = builtinSummary(ctx)
    const sentiment = ['frustrated', 'neutral', 'satisfied'].includes(String(raw.sentiment)) ? (raw.sentiment as SummaryOut['sentiment']) : base.sentiment
    const next = strArr(raw.next_steps, 4)
    return { headline: str(raw.headline, base.headline), summary: str(raw.summary, base.summary), sentiment, timeline: base.timeline, next_steps: next.length ? next : base.next_steps }
  }
  if (skill === 'resolve') {
    const base = builtinResolve(ctx)
    const all: Source[] = [...ctx.kb, ...ctx.similar.map(({ close_notes: _c, ...r }) => (void _c, r))]
    const ids = new Set(strArr(raw.source_ids, 10))
    const cited = all.filter((x) => ids.has(x.sys_id) || ids.has(x.number))
    const steps = strArr(raw.steps, 6)
    const conf = Number(raw.confidence)
    return {
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(100, Math.round(conf))) : base.confidence,
      rationale: str(raw.rationale, base.rationale),
      steps: steps.length ? steps : base.steps,
      close_code: CLOSE_CODES.includes(String(raw.close_code)) ? String(raw.close_code) : base.close_code,
      close_notes: str(raw.close_notes, base.close_notes),
      sources: cited.length ? cited : all,
    }
  }
  const base = builtinKbDraft(ctx)
  return {
    short_description: str(raw.short_description, base.short_description).slice(0, 160),
    kb_category: KB_CATEGORIES.includes(String(raw.kb_category)) ? String(raw.kb_category) : base.kb_category,
    text: `${str(raw.text, base.text)}\n\nSource\nDrafted by Now Assist from ${s(ctx.rec.number)}.`,
    sources: ctx.kb,
  }
}

export function fireworksLlm(apiKey: string, model: string): LlmFn {
  return async (messages) => {
    const res = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 1800, response_format: { type: 'json_object' } }),
      signal: AbortSignal.timeout(25000),
    })
    if (!res.ok) throw new Error(`Fireworks API ${res.status}`)
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return { text: json.choices?.[0]?.message?.content ?? '', model: model.split('/').pop() ?? model, provider: 'Fireworks AI' }
  }
}

export function defaultLlm(): LlmFn | null {
  const key = process.env.FIREWORKS_API_KEY
  if (!key || process.env.NOW_ASSIST_PROVIDER === 'builtin') return null
  return fireworksLlm(key, process.env.NOW_ASSIST_MODEL ?? 'accounts/fireworks/models/gpt-oss-120b')
}

export async function runSkill(db: Db, llm: LlmFn | null, skill: Skill, table: string, id: string): Promise<AssistResponse> {
  if (!SKILLS.includes(skill)) throw new HttpError(400, `Unknown Now Assist skill ${skill}`)
  if (!SKILL_TABLES[skill].includes(table)) throw new HttpError(400, `Now Assist ${skill} is not available for ${table}`)
  const ctx = buildContext(db, table, id)
  const started = Date.now()
  const builtin = () => (skill === 'summarize' ? builtinSummary(ctx) : skill === 'resolve' ? builtinResolve(ctx) : builtinKbDraft(ctx))
  const base = { skill, table, sys_id: id }
  if (!llm) return { ...base, provider: 'Built-in', model: 'now-assist-lite', latency_ms: Date.now() - started, output: builtin() }
  try {
    const r = await llm([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${INSTRUCTIONS[skill]}\n\n${contextBlock(ctx)}` },
    ])
    return { ...base, provider: r.provider, model: r.model, latency_ms: Date.now() - started, output: normalize(skill, parseJson(r.text), ctx) }
  } catch (e) {
    return { ...base, provider: 'Built-in', model: 'now-assist-lite', latency_ms: Date.now() - started, fallback_reason: e instanceof Error ? e.message : String(e), output: builtin() }
  }
}
