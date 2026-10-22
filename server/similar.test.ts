import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from './app.ts'
import { openDb } from './db.ts'
import type { Db } from './db.ts'
import { seed } from './seed.ts'
import { buildIdf, cluster, cosine, recency, scorePair, tfidf, tokenize } from './similar.ts'
import type { IncidentDoc } from './similar.ts'

const docs: [string, string, string][] = [
  ['VPN disconnects every few minutes', 'GlobalProtect tunnel drops and reconnects', 'vpn'],
  ['GlobalProtect VPN keeps disconnecting', 'VPN tunnel dropping repeatedly', 'vpn'],
  ['Printer queue stuck', 'print jobs stuck in queue', 'printer'],
  ['Print jobs not printing', 'documents stuck in the print queue', 'printer'],
  ['Laptop will not power on', 'no lights after charging', 'laptop'],
]

function makeDocs(): IncidentDoc[] {
  const toks = docs.map(([sd, d]) => tokenize(`${sd} ${d}`))
  const idf = buildIdf(toks)
  return docs.map(([sd, d, ci], i) => ({
    sys_id: String(i),
    number: `INC${i}`,
    short_description: sd,
    description: d,
    cmdb_ci: ci,
    cmdb_ci_name: ci.toUpperCase(),
    category: ci === 'vpn' ? 'network' : 'hardware',
    subcategory: null,
    assignment_group: ci,
    assignment_group_name: ci,
    opened_at: '2026-10-20 10:00:00',
    state: '2',
    vec: tfidf(toks[i], idf),
  }))
}

describe('similarity scoring', () => {
  it('tokenizes with stop words removed and light stemming', () => {
    assert.deepEqual(tokenize('The VPN keeps disconnecting and drops'), ['vpn', 'disconnect', 'drop'])
    assert.deepEqual(tokenize('Disconnects'), tokenize('disconnected'))
  })

  it('cosine is 1 for identical vectors and 0 for disjoint ones', () => {
    const idf = buildIdf([['a', 'b'], ['c']])
    assert.ok(Math.abs(cosine(tfidf(['a', 'b'], idf), tfidf(['a', 'b'], idf)) - 1) < 1e-9)
    assert.equal(cosine(tfidf(['a'], idf), tfidf(['c'], idf)), 0)
  })

  it('ranks near-duplicates above unrelated incidents and explains why', () => {
    const d = makeDocs()
    const dup = scorePair(d[0], d[1])
    const other = scorePair(d[0], d[2])
    assert.ok(dup.score > 0.5, `dup score ${dup.score}`)
    assert.equal(other.score, 0)
    assert.ok(dup.reasons.includes('same CI: VPN'))
    assert.ok(dup.reasons.some((r) => r.startsWith('shared terms:') && r.includes('vpn')))
    assert.ok(dup.reasons.includes('same group: vpn'))
  })

  it('weights recent pairs higher than distant ones', () => {
    assert.equal(recency('2026-10-01 00:00:00', '2026-10-01 00:00:00'), 1)
    assert.ok(recency('2026-10-01 00:00:00', '2026-10-05 00:00:00') > recency('2026-10-01 00:00:00', '2026-12-01 00:00:00'))
    const d = makeDocs()
    const near = scorePair(d[0], d[1]).score
    const far = scorePair(d[0], { ...d[1], opened_at: '2026-06-01 00:00:00' }).score
    assert.ok(near > far)
  })

  it('clusters by average linkage and drops singletons', () => {
    const d = makeDocs()
    const groups = cluster(d.length, (i, j) => scorePair(d[i], d[j]).score, 0.45)
    assert.deepEqual(groups.map((g) => g.join(',')).sort(), ['0,1', '2,3'])
    assert.deepEqual(cluster(3, () => 0.1, 0.45), [])
    assert.deepEqual(cluster(3, () => 0.9, 0.45), [[0, 1, 2]])
  })
})

describe('Similar Incidents API', () => {
  let server: Server
  let base = ''
  let adminId = ''
  let db: Db
  // oxlint-disable-next-line typescript/no-explicit-any
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-User': adminId }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, json: await res.json() }
  }

  before(async () => {
    db = openDb(':memory:')
    seed(db)
    server = createApp(db).listen(0)
    await new Promise((r) => server.once('listening', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    adminId = (db.prepare("SELECT sys_id FROM sys_user WHERE user_name = 'admin'").get() as { sys_id: string }).sys_id
  })
  after(() => server.close())

  const idOf = (sd: string) => (db.prepare('SELECT sys_id FROM incident WHERE short_description = ?').get(sd) as { sys_id: string }).sys_id

  it('returns similar incidents with reasons, resolved precedents, KB and problems', async () => {
    const r = await call('GET', `/api/now/similar/incident/${idOf('VPN disconnects every few minutes when working from home')}`)
    assert.equal(r.status, 200)
    const { matches, kb, problems } = r.json.result
    assert.ok(matches.length >= 5)
    for (let i = 1; i < matches.length; i++) assert.ok(matches[i - 1].score >= matches[i].score)
    assert.ok(matches.every((m: { short_description: string }) => /vpn|globalprotect/i.test(m.short_description)))
    assert.ok(matches[0].reasons.includes('same CI: Corporate VPN'))
    const precedent = matches.find((m: { resolved: boolean }) => m.resolved)
    assert.ok(precedent?.close_notes?.includes('GlobalProtect'))
    assert.ok(precedent.close_code)
    assert.equal(kb[0].short_description, 'GlobalProtect VPN keeps disconnecting')
    assert.ok(problems.some((p: { short_description: string }) => /VPN/.test(p.short_description)))
  })

  it('404s for unknown incidents', async () => {
    const r = await call('GET', '/api/now/similar/incident/nope')
    assert.equal(r.status, 404)
  })

  it('groups open incidents into themed clusters', async () => {
    const r = await call('GET', '/api/now/clusters/incident')
    const clusters = r.json.result.clusters
    assert.ok(clusters.length >= 3 && clusters.length <= 6, `got ${clusters.length} clusters`)
    const cis = clusters.map((c: { cmdb_ci: { name: string } }) => c.cmdb_ci?.name)
    for (const ci of ['Corporate VPN', 'SAP ERP Production', 'Print Server HQ', 'Email - Exchange Online']) assert.ok(cis.includes(ci), `missing ${ci}`)
    for (const c of clusters) {
      assert.ok(c.size >= 2)
      assert.ok(c.cmdb_ci.count / c.size >= 0.75, 'clusters are dominated by one CI')
      assert.equal(c.spark.length, 14)
      assert.ok(c.top_terms.length > 0)
      assert.match(c.suggested_title, /^Recurring: /)
    }
    const strict = await call('GET', '/api/now/clusters/incident?threshold=0.9')
    assert.equal(strict.json.result.clusters.length, 0)
  })

  it('creates a problem from a cluster and links every incident with a journal note', async () => {
    const print = (await call('GET', '/api/now/clusters/incident')).json.result.clusters.find((c: { cmdb_ci: { name: string } }) => c.cmdb_ci.name === 'Print Server HQ')
    const ids = print.incidents.map((i: { sys_id: string }) => i.sys_id)
    const r = await call('POST', '/api/now/clusters/incident/problem', { incident_ids: ids, short_description: print.suggested_title })
    assert.equal(r.status, 201)
    const prb = r.json.result.problem
    assert.match(prb.number, /^PRB/)
    assert.equal(prb.short_description, print.suggested_title)
    assert.equal(prb.cmdb_ci, print.cmdb_ci.sys_id)
    assert.equal(prb.category, 'hardware')
    const linked = await call('GET', `/api/now/table/incident?sysparm_query=problem_id=${prb.sys_id}`)
    assert.equal(linked.json.total, ids.length)
    for (const id of ids) {
      const j = (await call('GET', `/api/now/journal/incident/${id}`)).json.result
      assert.ok(j.some((e: { element: string; value: string }) => e.element === 'work_notes' && e.value.includes(prb.number)))
    }
    const after = (await call('GET', '/api/now/clusters/incident')).json.result.clusters.find((c: { cmdb_ci: { name: string } }) => c.cmdb_ci.name === 'Print Server HQ')
    assert.equal(after.existing_problem.number, prb.number)
    const bad = await call('POST', '/api/now/clusters/incident/problem', { incident_ids: [] })
    assert.equal(bad.status, 400)
  })
})
