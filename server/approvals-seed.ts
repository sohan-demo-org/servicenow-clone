import { addJournal, insertRecord, nowStr } from './db.ts'
import type { Db, Row } from './db.ts'
import { decide, requestApprovals } from './approvals.ts'
import type { Actor } from './approvals.ts'

const hoursAgo = (h: number) => nowStr(new Date(Date.now() - h * 3600000))

const CHANGES: { sd: string; cat: string; ci: string; group: string; risk: string; type: string; by: string; age: number; startIn: number; decision?: [string, 'approved' | 'rejected', string, number] }[] = [
  { sd: 'Upgrade Exchange Online connector to TLS 1.3', cat: 'software', ci: 'Email - Exchange Online', group: 'Software', risk: '2', type: 'normal', by: 'luke.wilson', age: 52, startIn: 30 },
  { sd: 'Expand SAN storage for SAP ERP Production', cat: 'hardware', ci: 'SAP ERP Production', group: 'Software', risk: '3', type: 'normal', by: 'fred.luddy', age: 120, startIn: 72 },
  { sd: 'Cut over internal DNS to new resolver cluster', cat: 'network', ci: 'core-sw-sd-01', group: 'Network', risk: '1', type: 'normal', by: 'david.loo', age: 26, startIn: 20 },
  { sd: 'Deploy Virtual Agent topic updates to production', cat: 'software', ci: 'Okta SSO', group: 'Service Desk', risk: '4', type: 'normal', by: 'itil', age: 7, startIn: 96 },
  { sd: 'Renew wildcard TLS certificate for *.corp.example.com', cat: 'software', ci: 'lnux-web-01', group: 'Software', risk: '3', type: 'normal', by: 'luke.wilson', age: 100, startIn: 40, decision: ['admin', 'approved', 'Backout plan verified. Approved for the Thursday window.', 70] },
  { sd: 'Open SSH from internet to jump host for vendor access', cat: 'network', ci: 'fw-edge-ams', group: 'Service Desk', risk: '1', type: 'normal', by: 'david.loo', age: 80, startIn: 10, decision: ['beth.anglin', 'rejected', 'Violates the remote-access baseline. Use the vendor VPN portal instead.', 50] },
]

const RITMS: { item: string; qty: number; forUser: string; age: number; decision?: [string, 'approved' | 'rejected', string, number] }[] = [
  { item: 'Developer Laptop', qty: 1, forUser: 'rick.berzle', age: 30 },
  { item: 'Standard Laptop', qty: 2, forUser: 'carol.coughlin', age: 75 },
  { item: 'Microsoft Visio', qty: 5, forUser: 'charlie.whitherspoon', age: 18 },
  { item: 'Adobe Acrobat Pro', qty: 6, forUser: 'jane.doe', age: 44 },
  { item: 'Microsoft Visio', qty: 4, forUser: 'bud.richman', age: 140, decision: ['beth.anglin', 'approved', 'Licenses available in the FY true-up pool.', 110] },
  { item: 'Developer Laptop', qty: 1, forUser: 'employee', age: 96, decision: ['admin', 'rejected', 'Standard Laptop meets the requirements for this role.', 60] },
  { item: 'iPhone 16', qty: 2, forUser: 'abraham.lincoln', age: 160, decision: ['admin', 'approved', 'Approved for the field sales team.', 130] },
]

/** Seed approver records: rounds for existing pending documents plus extra pending and decided approvals. */
export function seedApprovals(db: Db): void {
  const users = Object.fromEntries((db.prepare('SELECT * FROM sys_user').all() as Row[]).map((u) => [String(u.user_name), u]))
  const groups = Object.fromEntries((db.prepare('SELECT * FROM sys_user_group').all() as Row[]).map((g) => [String(g.name), g]))
  const cis = Object.fromEntries((db.prepare('SELECT sys_id, name FROM cmdb_ci').all() as Row[]).map((c) => [String(c.name), c]))
  const items = Object.fromEntries((db.prepare('SELECT * FROM sc_cat_item').all() as Row[]).map((c) => [String(c.name), c]))
  const actor = (name: string): Actor => ({ sys_id: String(users[name].sys_id), user_name: name, name: String(users[name].name) })
  const decideAs = (docId: string, [who, decision, comment, hAgo]: [string, 'approved' | 'rejected', string, number]) => {
    const row = db.prepare("SELECT sys_id FROM sysapproval_approver WHERE document_id = ? AND approver = ? AND state = 'requested'").get(docId, users[who].sys_id) as { sys_id: string }
    const at = hoursAgo(hAgo)
    decide(db, row.sys_id, decision, comment, actor(who), at)
    db.prepare("UPDATE sys_journal_field SET sys_created_on = ? WHERE element_id = ? AND element = 'audit'").run(at, docId)
  }

  for (const table of ['change_request', 'sc_req_item']) {
    for (const d of db.prepare(`SELECT sys_id, sys_created_on FROM ${table} WHERE approval = 'requested'`).all() as Row[]) {
      requestApprovals(db, table, String(d.sys_id), null, String(d.sys_created_on))
    }
  }

  for (const c of CHANGES) {
    const chg = insertRecord(
      db,
      'change_request',
      {
        short_description: c.sd,
        category: c.cat,
        cmdb_ci: cis[c.ci]?.sys_id,
        type: c.type,
        state: '-3',
        approval: 'requested',
        risk: c.risk,
        impact: c.risk <= '2' ? '1' : '2',
        requested_by: users[c.by].sys_id,
        assignment_group: groups[c.group].sys_id,
        assigned_to: users[c.by].sys_id,
        description: `${c.sd}. Coordinated with service owners; customer communication drafted.`,
        justification: 'Required to maintain security compliance and vendor support.',
        implementation_plan: '1. Notify stakeholders\n2. Snapshot affected systems\n3. Apply change\n4. Validate service health',
        backout_plan: 'Restore from the snapshot taken in step 2 and validate.',
        test_plan: 'Smoke test endpoints and confirm monitoring is green.',
        start_date: hoursAgo(-c.startIn),
        end_date: hoursAgo(-c.startIn - 3),
        sys_created_on: hoursAgo(c.age + 2),
      },
      actor(c.by),
      { skipRules: true },
    )
    const id = String(chg.sys_id)
    addJournal(db, 'change_request', id, 'work_notes', 'Change moved to Authorize; submitted to the CAB for approval.', actor(c.by), hoursAgo(c.age))
    requestApprovals(db, 'change_request', id, actor(c.by), hoursAgo(c.age))
    if (c.decision) decideAs(id, c.decision)
  }

  for (const r of RITMS) {
    const item = items[r.item]
    const ritm = insertRecord(
      db,
      'sc_req_item',
      {
        cat_item: item.sys_id,
        requested_for: users[r.forUser].sys_id,
        quantity: r.qty,
        price: Number(item.price) * r.qty,
        stage: 'waiting_for_approval',
        state: '1',
        approval: 'requested',
        assignment_group: item.fulfillment_group,
        short_description: r.qty > 1 ? `${item.name} x${r.qty}` : String(item.name),
        sys_created_on: hoursAgo(r.age),
      },
      actor(r.forUser),
    )
    const id = String(ritm.sys_id)
    addJournal(db, 'sc_req_item', id, 'comments', `Request submitted for ${r.qty} x ${item.name}.`, actor(r.forUser), hoursAgo(r.age))
    requestApprovals(db, 'sc_req_item', id, null, hoursAgo(r.age))
    if (r.decision) decideAs(id, r.decision)
  }

  // Keep the inbox realistic: most pending approvals are due in the coming days, a few are overdue.
  const pending = db.prepare("SELECT sys_id FROM sysapproval_approver WHERE state = 'requested' ORDER BY rowid").all() as { sys_id: string }[]
  pending.forEach((p, i) => {
    if (i % 4 !== 0) db.prepare('UPDATE sysapproval_approver SET due_date = ? WHERE sys_id = ?').run(hoursAgo(-(12 + ((i * 17) % 96))), p.sys_id)
  })
}
