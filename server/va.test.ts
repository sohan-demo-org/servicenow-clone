import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from './app.ts'
import { openDb } from './db.ts'
import { seed } from './seed.ts'
import { classify, rank } from './va.ts'

let server: Server
let db: ReturnType<typeof openDb>
let base = ''
const ids: Record<string, string> = {}

async function call(as: string, path: string, body: unknown, method = 'POST') {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(ids[as] ? { 'X-User': ids[as] } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  })
  // oxlint-disable-next-line typescript/no-explicit-any
  const json: any = await res.json()
  return { status: res.status, json }
}

const say = (as: string, body: unknown) => call(as, '/api/now/va/message', body)

before(async () => {
  db = openDb(':memory:')
  seed(db)
  server = createApp(db).listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  for (const u of ['abel.tuter', 'beth.anglin']) {
    ids[u] = (await call('', '/api/login', { user_name: u, password: 'demo' })).json.result.sys_id
  }
})

after(() => server.close())

describe('Virtual Agent', () => {
  it('requires a logged-in user', async () => {
    assert.equal((await say('', { text: 'hi' })).status, 401)
  })

  it('greets by first name with menu chips', async () => {
    const r = await say('abel.tuter', { action: { type: 'menu', greet: true } })
    assert.equal(r.status, 200)
    assert.match(r.json.result.messages[0].text, /Hi Abel/)
    assert.ok(r.json.result.chips.some((c: { label: string }) => c.label === 'Check my tickets'))
  })

  it('answers questions with ranked knowledge articles and offers escalation', async () => {
    const r = await say('abel.tuter', { text: 'my vpn keeps disconnecting' })
    const cards = r.json.result.messages[0].cards
    assert.equal(cards[0].kind, 'kb')
    assert.match(cards[0].title, /VPN/)
    const escalate = r.json.result.chips.find((c: { action?: { type: string } }) => c.action?.type === 'create_incident')
    assert.equal(escalate.action.short_description, 'my vpn keeps disconnecting')
  })

  it('prefers the literal keyword over a synonym match', async () => {
    const r = await say('abel.tuter', { text: 'urgent: outlook is down and I cannot work' })
    assert.match(r.json.result.messages[0].cards[0].title, /^Outlook/)
  })

  it('offers to open an incident when nothing matches', async () => {
    const r = await say('abel.tuter', { text: 'zzqx flurb' })
    assert.match(r.json.result.messages[0].text, /couldn't find/)
    assert.equal(r.json.result.chips[0].action.type, 'create_incident')
  })

  it('creates a categorised, routed incident from chat and reports it in status', async () => {
    const r = await say('abel.tuter', { action: { type: 'create_incident', short_description: 'VPN is down, I cannot work', urgency: '1' } })
    assert.equal(r.status, 200)
    const card = r.json.result.messages[0].cards[0]
    assert.equal(card.kind, 'created')
    assert.match(card.subtitle, /Network/)
    const number = card.title.split(' ')[0]
    const inc = (await call('abel.tuter', `/api/now/table/incident?sysparm_query=number=${number}`, null, 'GET')).json.result[0]
    assert.equal(inc.caller_id, ids['abel.tuter'])
    assert.equal(inc.contact_type, 'chat')
    assert.equal(inc.category, 'network')
    assert.equal(inc.subcategory, 'vpn')
    assert.equal(inc.priority, '2')
    assert.equal(inc._dv.assignment_group, 'Network')

    const status = await say('abel.tuter', { text: 'what is the status of my tickets?' })
    assert.ok(status.json.result.messages[0].cards.some((c: { title: string }) => c.title.startsWith(number)))

    const lookup = await say('abel.tuter', { text: `any update on ${number.toLowerCase()}?` })
    assert.equal(lookup.json.result.messages[0].cards[0].to, `/sp/ticket/incident/${inc.sys_id}`)
  })

  it("does not reveal another user's ticket to an end user", async () => {
    const other = (await call('beth.anglin', '/api/now/table/incident?sysparm_query=caller_id!=' + ids['abel.tuter'] + '&sysparm_limit=1', null, 'GET')).json.result[0]
    const r = await say('abel.tuter', { text: `status of ${other.number}` })
    assert.match(r.json.result.messages[0].text, /couldn't find/)
    const agent = await say('beth.anglin', { text: `status of ${other.number}` })
    assert.equal(agent.json.result.messages[0].cards[0].kind, 'ticket')
  })

  it('suggests catalog items for order requests', async () => {
    const r = await say('abel.tuter', { text: 'I need a new laptop' })
    const titles = r.json.result.messages[0].cards.map((c: { title: string }) => c.title)
    assert.ok(titles.includes('Standard Laptop'))
    assert.ok(!titles.includes('New Hire Onboarding'))
    assert.equal(r.json.result.messages[0].cards[0].kind, 'item')
  })

  it('treats "need a fix" as troubleshooting, but "need a monitor" as an order', async () => {
    const fix = await say('abel.tuter', { text: 'I need a fix for my VPN' })
    assert.equal(fix.json.result.messages[0].cards[0].kind, 'kb')
    assert.match(fix.json.result.messages[0].cards[0].title, /VPN/)
    const order = await say('abel.tuter', { text: 'I need a monitor' })
    assert.equal(order.json.result.messages[0].cards[0].kind, 'item')
  })

  it('keeps the full text of a long report on the incident', async () => {
    const long = `My laptop docking station stops charging every afternoon. ${'Details: it happens after lunch when I reconnect the dock. '.repeat(4)}END-OF-REPORT`
    const r = await say('abel.tuter', { action: { type: 'create_incident', short_description: long } })
    const sysId = r.json.result.messages[0].cards[0].to.split('/').pop()
    const inc = (await call('beth.anglin', `/api/now/table/incident/${sysId}`, null, 'GET')).json.result
    assert.ok(inc.short_description.length <= 160)
    assert.match(inc.description, /END-OF-REPORT$/)
  })

  it('finds articles beyond the old page limit', async () => {
    for (let i = 0; i < 205; i++) {
      await call('beth.anglin', '/api/now/table/kb_knowledge', { short_description: `Filler article ${i}`, text: 'Nothing to see here.', workflow_state: 'published' })
    }
    db.prepare("UPDATE kb_knowledge SET sys_view_count = 100000 WHERE short_description LIKE 'Filler article %'").run()
    const r = await say('abel.tuter', { text: 'my vpn keeps disconnecting' })
    assert.match(r.json.result.messages[0].cards[0].title, /VPN/)
  })

  it('classifies and ranks text', () => {
    assert.deepEqual(classify('Got a suspicious phishing email'), { category: 'security', subcategory: 'phishing', urgency: '2' })
    assert.equal(classify('printer is broken, urgent!').category, 'hardware')
    assert.equal(classify('printer is broken, urgent!').urgency, '1')
    assert.equal(rank('printer jammed', [{ title: 'Password policy', body: '' }, { title: 'Clearing a printer jam', body: '' }])[0].index, 1)
    const bodyOnly = rank('globalprotect', [{ title: 'Remote access', body: 'Install the GlobalProtect client' }, { title: 'Printers', body: 'Toner' }])
    assert.deepEqual(bodyOnly.map((r) => r.index), [0])
  })
})
