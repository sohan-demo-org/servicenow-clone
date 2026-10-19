import { HttpError, addJournal, insertRecord, listRecords } from './db.ts'
import type { Db, Row } from './db.ts'
import { SUBCATEGORY, choiceLabel } from '../shared/schema.ts'
import type { VaAction, VaCard, VaChip, VaReply, VaRequest } from '../shared/va.ts'

export interface VaActor {
  sys_id: string
  user_name: string
  name: string
  role: string
}

const STOPWORDS = new Set(
  'the a an and or but to of for in on at by with from my me i im i\'m is are was were be been it its this that there have has had do does did not no can cant can\'t cannot wont won\'t keeps keep get got getting please help need want would like how what why when where who which you your our we us again still just some any all new'.split(' '),
)

const SYNONYMS: Record<string, string[]> = {
  wifi: ['wireless', 'corp-wifi'],
  'wi-fi': ['wifi', 'wireless'],
  internet: ['network', 'wifi', 'vpn'],
  mfa: ['okta', 'authenticator', 'multi-factor'],
  '2fa': ['mfa', 'okta'],
  okta: ['mfa'],
  authenticator: ['mfa', 'okta'],
  email: ['outlook', 'exchange'],
  outlook: ['email'],
  mail: ['email', 'outlook'],
  password: ['credentials', 'passphrase'],
  printer: ['laserjet', 'print'],
  print: ['printer'],
  phish: ['phishing'],
  phishing: ['phish'],
  sap: ['erp'],
  slow: ['performance'],
  drive: ['share', 'fs01'],
  computer: ['laptop'],
  notebook: ['laptop'],
  macbook: ['laptop'],
  phone: ['iphone', 'mobile'],
  mobile: ['iphone', 'phone'],
  screen: ['monitor'],
  display: ['monitor'],
  headphones: ['headset'],
  pdf: ['acrobat'],
  diagram: ['visio'],
}

const CATEGORY_HINTS: [string, string[]][] = [
  ['security', ['phish', 'phishing', 'malware', 'virus', 'hacked', 'suspicious', 'ransomware', 'mfa', 'okta', 'authenticator']],
  ['network', ['vpn', 'wifi', 'wi-fi', 'wireless', 'network', 'dns', 'internet', 'dhcp', 'globalprotect']],
  ['database', ['database', 'oracle', 'sql', 'postgres', 'postgresql', 'db2', 'tablespace']],
  ['hardware', ['laptop', 'printer', 'monitor', 'keyboard', 'mouse', 'screen', 'battery', 'headset', 'disk', 'memory', 'cpu', 'dock']],
  ['software', ['outlook', 'email', 'excel', 'word', 'sap', 'teams', 'install', 'crash', 'crashes', 'software', 'app', 'application', 'erp', 'drive']],
]

const SUBCATEGORY_HINTS: Record<string, string> = {
  vpn: 'vpn',
  globalprotect: 'vpn',
  wifi: 'wireless',
  'wi-fi': 'wireless',
  wireless: 'wireless',
  dns: 'dns',
  dhcp: 'dhcp',
  phish: 'phishing',
  phishing: 'phishing',
  malware: 'malware',
  virus: 'malware',
  ransomware: 'malware',
  outlook: 'email',
  email: 'email',
  keyboard: 'keyboard',
  mouse: 'mouse',
  monitor: 'monitor',
  screen: 'monitor',
  memory: 'memory',
  disk: 'disk',
  oracle: 'oracle',
  postgres: 'postgres',
  postgresql: 'postgres',
  sql: 'sql server',
  db2: 'db2',
  sap: 'erp',
  erp: 'erp',
}

const GROUP_FOR_CATEGORY: Record<string, string> = {
  network: 'Network',
  database: 'Database',
  hardware: 'Hardware',
  software: 'Software',
  security: 'Security Operations',
  inquiry: 'Service Desk',
}

const URGENT = /\b(urgent|asap|emergency|outage|down|critical|can'?t work|cannot work|blocked|immediately|everyone|whole team)\b/i
const GREETING = /^(hi|hello|hey|yo|good (morning|afternoon|evening)|menu|start|help|start over)[!. ]*$/i
const THANKS = /^(thanks|thank you|thx|ty|cheers|great|awesome|perfect)\b/i
const STATUS = /\b(status|my tickets?|my incidents?|my requests?|track|tracking|update on|open tickets?|what'?s happening with)\b/i
const ORDER = /\b(order|buy|purchase|request (a|an|new)|need (a|an) new|get (a|an) new|new (laptop|phone|monitor|headset)|access to)\b/i
const SOFT_ORDER = /\b(need|want|looking for) (a|an)\b/i
const TROUBLE = /\b(fix|fixed|fixing|help|reset|unlock|broken|issue|problem|error|trouble|not working|stopped|keeps|won'?t|can'?t|cannot)\b/i
const TICKET_NO = /\b(INC|RITM|PRB|CHG)\d{7}\b/i

const MENU_CHIPS: VaChip[] = [
  { label: 'Report an issue', text: 'I have an issue' },
  { label: 'Check my tickets', text: 'status of my tickets' },
  { label: 'Order something', text: 'I want to order something' },
  { label: 'Search knowledge', text: 'how do I connect to the VPN' },
]

const BACK_CHIPS: VaChip[] = [
  { label: 'Check my tickets', text: 'status of my tickets' },
  { label: 'Main menu', action: { type: 'menu' } },
]

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\- ]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w))
}

function termMatches(term: string, words: string[]): boolean {
  return words.some((w) => w === term || (Math.min(w.length, term.length) >= 3 && (w.startsWith(term) || term.startsWith(w))))
}

/**
 * Rank records by keyword overlap. Each query word scores its best match: 3 in the title, 1 in the body,
 * and a synonym match scores less (2 / 0.5) so the literal word wins ties. Results need a score of 2; if none do,
 * the single best literal body match (score 1) is returned so a body-only keyword still finds something.
 */
export function rank(query: string, docs: { title: string; body: string }[]): { index: number; score: number }[] {
  const words = [...new Set(tokenize(query))]
  if (!words.length) return []
  const scored = docs
    .map((d, index) => {
      const title = tokenize(d.title)
      const body = tokenize(d.body)
      let score = 0
      for (const w of words) {
        let best = 0
        for (const term of [w, ...(SYNONYMS[w] ?? [])]) {
          const exact = term === w
          if (termMatches(term, title)) best = Math.max(best, exact ? 3 : 2)
          else if (termMatches(term, body)) best = Math.max(best, exact ? 1 : 0.5)
        }
        score += best
      }
      return { index, score }
    })
    .sort((a, b) => b.score - a.score)
  const strong = scored.filter((r) => r.score >= 2)
  return strong.length ? strong : scored.filter((r) => r.score >= 1).slice(0, 1)
}

/**
 * Pre-filter rows in SQL to those that could match `rank`, so no matching record is cut off by a page limit.
 * Each term (and synonym) is matched on its first 3 letters, a superset of rank's prefix matching.
 */
function searchRows(db: Db, table: string, where: string, cols: string[], text: string, order: string): Row[] {
  const terms = [...new Set(tokenize(text).flatMap((w) => [w, ...(SYNONYMS[w] ?? [])]).map((t) => (t.length > 3 ? t.slice(0, 3) : t)))]
  if (!terms.length) return []
  const like = terms.flatMap(() => cols.map((c) => `"${c}" LIKE ?`))
  const params = terms.flatMap((t) => cols.map(() => `%${t}%`))
  return db.prepare(`SELECT * FROM ${table} WHERE ${where} AND (${like.join(' OR ')}) ORDER BY ${order}`).all(...params) as Row[]
}

export function classify(text: string): { category: string; subcategory: string | null; urgency: string } {
  const words = tokenize(text)
  const category = CATEGORY_HINTS.find(([, hints]) => hints.some((h) => words.includes(h)))?.[0] ?? 'inquiry'
  const sub = words.map((w) => SUBCATEGORY_HINTS[w]).find((s) => s && SUBCATEGORY[category]?.some((c) => c.value === s)) ?? null
  return { category, subcategory: sub, urgency: URGENT.test(text) ? '1' : '2' }
}

const firstName = (a: VaActor) => a.name.split(' ')[0]
const s = (v: unknown) => (v == null ? '' : String(v))

function ticketCard(table: 'incident' | 'sc_req_item', r: Row & { _dv?: Record<string, string> }): VaCard {
  const state = table === 'incident' ? choiceLabel('incident', 'state', s(r.state)) : choiceLabel('sc_req_item', 'stage', s(r.stage))
  const group = r._dv?.assignment_group
  return {
    kind: 'ticket',
    title: `${s(r.number)} · ${s(r.short_description)}`,
    subtitle: [state, group ? `with ${group}` : 'awaiting assignment', r._dv?.assigned_to ? `(${r._dv.assigned_to})` : ''].filter(Boolean).join(' '),
    badge: state,
    to: `/sp/ticket/${table}/${s(r.sys_id)}`,
  }
}

function menu(actor: VaActor, greet: boolean): VaReply {
  return {
    messages: [
      { text: greet ? `Hi ${firstName(actor)}, I'm the Virtual Agent. I can answer questions, open incidents, check on your tickets and help you order things.` : 'What else can I help you with?' },
      ...(greet ? [{ text: 'Pick an option below or just tell me what is going on.' }] : []),
    ],
    chips: MENU_CHIPS,
  }
}

function status(db: Db, actor: VaActor): VaReply {
  const ctx = { userId: actor.sys_id }
  const inc = listRecords(db, 'incident', { query: 'caller_id=javascript:gs.getUserID()^stateNOTIN6,7,8^ORDERBYDESCsys_updated_on', limit: 5, ctx })
  const ritm = listRecords(db, 'sc_req_item', { query: 'requested_for=javascript:gs.getUserID()^stateIN1,2^ORDERBYDESCsys_created_on', limit: 5, ctx })
  const cards = [...inc.result.map((r) => ticketCard('incident', r)), ...ritm.result.map((r) => ticketCard('sc_req_item', r))]
  if (!cards.length) return { messages: [{ text: "Good news: you don't have any open incidents or requests." }], chips: MENU_CHIPS }
  const parts = [inc.total && `${inc.total} open incident${inc.total === 1 ? '' : 's'}`, ritm.total && `${ritm.total} open request${ritm.total === 1 ? '' : 's'}`].filter(Boolean)
  return { messages: [{ text: `You have ${parts.join(' and ')}. Here's where each one stands:`, cards }], chips: BACK_CHIPS }
}

function lookupTicket(db: Db, actor: VaActor, number: string): VaReply {
  const upper = number.toUpperCase()
  const table = upper.startsWith('RITM') ? 'sc_req_item' : upper.startsWith('INC') ? 'incident' : null
  const notFound: VaReply = { messages: [{ text: `I couldn't find ${upper} among your tickets.` }], chips: BACK_CHIPS }
  if (!table) return notFound
  const r = listRecords(db, table, { query: `number=${upper}`, limit: 1, ctx: {} }).result[0]
  const owner = r && (table === 'incident' ? r.caller_id : r.requested_for)
  if (!r || (owner !== actor.sys_id && !['itil', 'admin'].includes(actor.role))) return notFound
  const last = db
    .prepare("SELECT value, sys_created_by FROM sys_journal_field WHERE element_id = ? AND element = 'comments' ORDER BY sys_created_on DESC LIMIT 1")
    .get(String(r.sys_id)) as { value: string; sys_created_by: string } | undefined
  return {
    messages: [{ text: `Here's the latest on ${upper}:`, cards: [ticketCard(table, r)] }, ...(last ? [{ text: `Most recent comment (${last.sys_created_by}): "${last.value}"` }] : [])],
    chips: BACK_CHIPS,
  }
}

function catalog(db: Db, text: string, explicit: boolean): VaReply | null {
  const items = searchRows(db, 'sc_cat_item', "active = 'true'", ['name', 'short_description', 'category'], text, 'name')
  const hits = rank(text, items.map((i) => ({ title: s(i.name), body: `${s(i.short_description)} ${s(i.category)}` }))).slice(0, 3)
  if (!hits.length) {
    if (!explicit) return null
    return {
      messages: [{ text: 'Sure. What would you like to order? You can ask for things like a laptop, a monitor, software or VPN access.' }],
      chips: [
        { label: 'New laptop', text: 'I need a new laptop' },
        { label: 'Monitor', text: 'order a monitor' },
        { label: 'VPN access', text: 'request VPN access' },
        { label: 'Browse catalog', link: '/sp/catalog' },
      ],
    }
  }
  const cards: VaCard[] = hits.map(({ index }) => {
    const i = items[index]
    const price = Number(i.price ?? 0)
    return {
      kind: 'item',
      title: s(i.name),
      subtitle: `${s(i.short_description)} · ${price ? `$${price.toLocaleString('en-US')}` : 'Free'} · ${s(i.delivery_time)}`,
      icon: s(i.icon),
      to: `/sp/item/${s(i.sys_id)}`,
    }
  })
  return {
    messages: [{ text: hits.length === 1 ? 'This catalog item looks like a match:' : 'These catalog items look like a match:', cards }],
    chips: [{ label: 'Browse full catalog', link: '/sp/catalog' }, ...BACK_CHIPS],
  }
}

function knowledge(db: Db, text: string): VaReply {
  const articles = searchRows(db, 'kb_knowledge', "workflow_state = 'published'", ['short_description', 'text'], text, 'sys_view_count DESC')
  const hits = rank(text, articles.map((a) => ({ title: s(a.short_description), body: s(a.text) }))).slice(0, 3)
  const { urgency } = classify(text)
  const escalate: VaChip = { label: 'Still need help', action: { type: 'create_incident', short_description: text, urgency } }
  if (!hits.length) {
    return {
      messages: [{ text: "I couldn't find a knowledge article for that." }, { text: 'Want me to open an incident so the right team can take a look?' }],
      chips: [{ ...escalate, label: 'Yes, open an incident' }, { label: 'No thanks', action: { type: 'menu' } }],
    }
  }
  const cards: VaCard[] = hits.map(({ index }) => {
    const a = articles[index]
    const body = s(a.text).replace(/\s+/g, ' ')
    return { kind: 'kb', title: s(a.short_description), subtitle: body.length > 120 ? `${body.slice(0, 117)}...` : body, badge: s(a.number), to: `/sp/kb/${s(a.sys_id)}` }
  })
  return {
    messages: [{ text: hits.length === 1 ? 'I found an article that should help:' : `I found ${hits.length} articles that might help:`, cards }, { text: 'Did that solve your problem?' }],
    chips: [{ label: 'Yes, that fixed it', action: { type: 'solved' } }, escalate],
  }
}

function createIncident(db: Db, actor: VaActor, action: Extract<VaAction, { type: 'create_incident' }>): VaReply {
  const full = s(action.short_description).trim().slice(0, 4000)
  const short = full.length > 160 ? `${full.slice(0, 157).trimEnd()}...` : full
  if (!short) throw new HttpError(400, 'Short description is required')
  const { category, subcategory, urgency: guessed } = classify(full)
  const urgency = ['1', '2', '3'].includes(s(action.urgency)) ? s(action.urgency) : guessed
  const group = db.prepare('SELECT sys_id FROM sys_user_group WHERE name = ?').get(GROUP_FOR_CATEGORY[category]) as { sys_id: string } | undefined
  const inc = insertRecord(
    db,
    'incident',
    {
      caller_id: actor.sys_id,
      short_description: short,
      description: `Reported via Virtual Agent chat:\n${full}`,
      category,
      subcategory,
      impact: urgency === '1' ? '2' : '3',
      urgency,
      contact_type: 'chat',
      assignment_group: group?.sys_id ?? null,
    },
    actor,
  ) as Row & { _dv?: Record<string, string> }
  addJournal(db, 'incident', String(inc.sys_id), 'comments', `Opened from a Virtual Agent conversation: "${full}"`, actor)
  const facts = [
    `Category: ${choiceLabel('incident', 'category', category)}${subcategory ? ` / ${choiceLabel('incident', 'subcategory', subcategory)}` : ''}`,
    `Priority: ${choiceLabel('incident', 'priority', s(inc.priority))}`,
    `Assigned to: ${inc._dv?.assignment_group ?? 'Service Desk'}`,
  ]
  return {
    messages: [
      {
        text: `Done. I opened ${s(inc.number)} for you${urgency === '1' ? ' and flagged it as high urgency' : ''}.`,
        cards: [{ kind: 'created', title: `${s(inc.number)} · ${short}`, subtitle: facts.join(' · '), badge: 'New', to: `/sp/ticket/incident/${s(inc.sys_id)}` }],
      },
      { text: "You'll get updates in My Tickets, and you can reply there any time." },
    ],
    chips: BACK_CHIPS,
  }
}

export function vaReply(db: Db, actor: VaActor | null, body: VaRequest): VaReply {
  if (!actor) throw new HttpError(401, 'Log in to chat with the Virtual Agent')
  const action = body?.action
  if (action?.type === 'menu') return menu(actor, Boolean(action.greet))
  if (action?.type === 'solved') return { messages: [{ text: `Glad I could help, ${firstName(actor)}!` }], chips: MENU_CHIPS }
  if (action?.type === 'create_incident') return createIncident(db, actor, action)

  const text = s(body?.text).trim().slice(0, 500)
  if (!text) throw new HttpError(400, 'Message cannot be empty')
  if (GREETING.test(text)) return menu(actor, true)
  if (THANKS.test(text)) return { messages: [{ text: "You're welcome! Anything else?" }], chips: MENU_CHIPS }
  const num = TICKET_NO.exec(text)
  if (num) return lookupTicket(db, actor, num[0])
  if (STATUS.test(text)) return status(db, actor)
  if (/^i have an issue$/i.test(text) || /^(report|issue|problem|broken)$/i.test(text)) {
    return { messages: [{ text: "Sorry to hear that. Describe what's happening in a sentence, for example \"Outlook keeps asking for my password\"." }], chips: [] }
  }
  const explicitOrder = ORDER.test(text)
  if (explicitOrder) {
    const reply = catalog(db, text.replace(/\b(i want to )?order something\b/i, ''), true)
    if (reply) return reply
  } else if (SOFT_ORDER.test(text) && !TROUBLE.test(text)) {
    const reply = catalog(db, text, false)
    if (reply) return reply
  }
  return knowledge(db, text)
}
