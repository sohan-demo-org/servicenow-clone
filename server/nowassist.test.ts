import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from './app.ts'
import { openDb } from './db.ts'
import type { Db } from './db.ts'
import type { LlmFn, LlmMessage } from './nowassist.ts'
import { seed } from './seed.ts'

let db: Db
const servers: Server[] = []
let adminId = ''

async function start(llm: LlmFn | null) {
  const server = createApp(db, { llm }).listen(0)
  servers.push(server)
  await new Promise((r) => server.once('listening', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function call(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User': adminId },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  // oxlint-disable-next-line typescript/no-explicit-any
  const json: any = res.status === 204 ? null : await res.json()
  return { status: res.status, json }
}

const incidentId = (sd: string) => (db.prepare('SELECT sys_id FROM incident WHERE short_description = ?').get(sd) as { sys_id: string }).sys_id

before(() => {
  db = openDb(':memory:')
  seed(db)
  adminId = (db.prepare("SELECT sys_id FROM sys_user WHERE user_name = 'admin'").get() as { sys_id: string }).sys_id
})

after(() => servers.forEach((s) => s.close()))

describe('Now Assist (built-in engine)', () => {
  let base = ''
  before(async () => {
    base = await start(null)
  })

  it('summarizes an incident from its fields and activity', async () => {
    const id = incidentId('Unable to connect to VPN from home')
    const r = await call(base, 'POST', `/api/now/assist/summarize/incident/${id}`)
    assert.equal(r.status, 200)
    const { provider, output } = r.json.result
    assert.equal(provider, 'Built-in')
    assert.match(output.summary, /VPN/)
    assert.ok(['frustrated', 'neutral', 'satisfied'].includes(output.sentiment))
    assert.ok(output.timeline.length > 0)
    assert.ok(output.next_steps.length > 0)
  })

  it('suggests a resolution grounded in the matching KB article', async () => {
    const id = incidentId('Outlook keeps asking for password')
    const r = await call(base, 'POST', `/api/now/assist/resolve/incident/${id}`)
    assert.equal(r.status, 200)
    const out = r.json.result.output
    assert.equal(out.sources[0].title, 'Outlook keeps prompting for credentials')
    assert.ok(out.steps.some((x: string) => /Credential Manager/.test(x)))
    assert.ok(out.confidence >= 35)
    assert.match(out.close_notes, /KB\d+/)
  })

  it('drafts a KB article from an incident', async () => {
    const id = incidentId('Wireless drops every 10 minutes on 3rd floor')
    const r = await call(base, 'POST', `/api/now/assist/kb_draft/incident/${id}`)
    assert.equal(r.status, 200)
    const out = r.json.result.output
    assert.equal(out.kb_category, 'network')
    assert.match(out.text, /Symptoms/)
    assert.match(out.text, /Drafted by Now Assist from INC/)
  })

  it('rejects unknown skills and unsupported tables', async () => {
    const id = incidentId('Monitor flickering')
    assert.equal((await call(base, 'POST', `/api/now/assist/poem/incident/${id}`)).status, 400)
    const chg = (db.prepare('SELECT sys_id FROM change_request LIMIT 1').get() as { sys_id: string }).sys_id
    assert.equal((await call(base, 'POST', `/api/now/assist/resolve/change_request/${chg}`)).status, 400)
    assert.equal((await call(base, 'POST', `/api/now/assist/summarize/change_request/${chg}`)).status, 200)
    assert.equal((await call(base, 'POST', '/api/now/assist/summarize/incident/nope')).status, 404)
  })
})

describe('Now Assist (LLM engine)', () => {
  it('grounds the prompt and sanitizes model output', async () => {
    let prompt: LlmMessage[] = []
    const base = await start(async (messages) => {
      prompt = messages
      return {
        provider: 'Fake',
        model: 'fake-1',
        text: 'Sure! ```json\n' + JSON.stringify({ confidence: 140, rationale: 'Per the article.', steps: ['Clear cached credentials', 7], close_code: 'Made up', close_notes: 'Cleared creds.', source_ids: ['not-a-real-id'] }) + '\n```',
      }
    })
    const id = incidentId('Outlook keeps asking for password')
    const r = await call(base, 'POST', `/api/now/assist/resolve/incident/${id}`)
    assert.equal(r.status, 200)
    const res = r.json.result
    assert.equal(res.provider, 'Fake')
    assert.match(prompt[1].content, /Outlook keeps prompting for credentials/, 'KB article is in the prompt')
    assert.equal(res.output.confidence, 100)
    assert.deepEqual(res.output.steps, ['Clear cached credentials'])
    assert.equal(res.output.close_code, 'Solved (Permanently)')
    assert.ok(res.output.sources.length > 0, 'hallucinated source ids fall back to retrieved sources')
  })

  it('falls back to the built-in engine when the model fails', async () => {
    const base = await start(async () => {
      throw new Error('boom')
    })
    const id = incidentId('Monitor flickering')
    const r = await call(base, 'POST', `/api/now/assist/summarize/incident/${id}`)
    assert.equal(r.status, 200)
    assert.equal(r.json.result.provider, 'Built-in')
    assert.equal(r.json.result.fallback_reason, 'boom')
  })
})
