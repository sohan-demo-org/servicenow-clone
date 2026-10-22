import { addJournal, insertRecord } from './db.ts'
import type { Db, Row } from './db.ts'
import { calcPriority } from '../shared/schema.ts'

// Near-duplicate incidents and resolved precedents that make Similar Incidents / Incident Clusters come alive.
// [short description, description, [impact, urgency], age in days, resolution code, resolution notes]
type Item = [string, string, [string, string], number, string?, string?]

interface Theme {
  ci: string
  category: string
  subcategory: string | null
  group: string
  items: Item[]
}

const THEMES: Theme[] = [
  {
    ci: 'Corporate VPN',
    category: 'network',
    subcategory: 'vpn',
    group: 'Network',
    items: [
      ['VPN disconnects every few minutes when working from home', 'GlobalProtect VPN tunnel drops after 5-10 minutes, reconnects, then drops again. Started after the gateway certificate rotation.', ['2', '1'], 0.6],
      ['GlobalProtect VPN keeps dropping connection', 'VPN session disconnects repeatedly; I have to reconnect GlobalProtect several times an hour. Gateway vpn.corp.example.com.', ['2', '2'], 1.4],
      ['VPN connection drops during Teams calls', 'Remote user loses the VPN tunnel mid-call. GlobalProtect shows "Gateway not responding" then reconnects after a minute.', ['3', '2'], 2.5],
      ['Frequent VPN disconnects for Amsterdam remote staff', 'Several remote users in Amsterdam report the GlobalProtect VPN disconnects every few minutes since Monday.', ['1', '2'], 3.2],
      ['VPN tunnel disconnecting repeatedly', 'GlobalProtect VPN tunnel disconnecting every 5 minutes for a remote finance user.', ['2', '2'], 34, 'Solved (Work Around)', 'Root cause: GlobalProtect client 6.0.x idle-timeout bug triggered after the VPN gateway certificate rotation. Upgraded the GlobalProtect client to 6.2.4 from Software Center and set the portal keep-alive interval to 30s. User confirmed a stable VPN connection for 2 days.'],
      ['GlobalProtect disconnects after 5 minutes', 'VPN drops after about 5 minutes of use, reconnect works briefly.', ['3', '2'], 21, 'Solved (Permanently)', 'Cleared the stale GlobalProtect gateway cache (%LOCALAPPDATA%\\Palo Alto Networks\\GlobalProtect), upgraded the client to 6.2.4 and re-imported the portal certificate. Tunnel stable through a full working day.'],
    ],
  },
  {
    ci: 'Email - Exchange Online',
    category: 'software',
    subcategory: 'email',
    group: 'Service Desk',
    items: [
      ['Outlook not syncing new emails', 'Inbox is stuck - new mail is not appearing in Outlook desktop but shows fine in Outlook on the web. Status bar says "Disconnected".', ['2', '2'], 0.9],
      ['Mobile email not syncing on iPhone', 'Outlook mobile stopped syncing mail and calendar since yesterday after my password change.', ['3', '2'], 1.8],
      ['Email sync failure - Outlook stuck on "Trying to connect"', 'Outlook desktop email sync failing, folders not updating, stuck on "Trying to connect" all morning.', ['2', '1'], 2.2],
      ['Shared mailbox not syncing in Outlook', 'Finance shared mailbox stopped syncing in Outlook; new emails missing from the folder list.', ['3', '3'], 4.1],
      ['Outlook inbox not syncing', 'New emails not syncing to Outlook desktop, OWA works.', ['2', '2'], 27, 'Solved (Permanently)', 'Outlook OST file was corrupted (over 45 GB). Closed Outlook, renamed the .ost under %LOCALAPPDATA%\\Microsoft\\Outlook and let Outlook rebuild the cache; limited cached mode to 12 months. Email syncing normally again.'],
      ['Email not syncing on mobile device', 'Mail and calendar sync stopped on mobile after password change.', ['3', '2'], 16, 'Solved (Permanently)', 'Device kept a stale ActiveSync partnership after the password change. Removed the device in Exchange admin center > Mobile devices; user re-added the account in Outlook mobile and sync was restored.'],
    ],
  },
  {
    ci: 'SAP ERP Production',
    category: 'software',
    subcategory: 'erp',
    group: 'Software',
    items: [
      ['SAP transactions very slow for finance team', 'SAP transactions VA01 and ME21N take 45-60 seconds to respond; the whole accounts payable team is affected.', ['1', '2'], 0.4],
      ['SAP ERP slow response times during month end close', 'SAP ERP response times are very slow during month end close, posting documents takes minutes.', ['2', '1'], 1.1],
      ['SAP GUI freezing when running reports', 'SAP GUI freezes and is extremely slow when running FBL1N vendor reports.', ['2', '2'], 2.9],
      ['SAP system performance degraded', 'General SAP slowness reported by procurement - transactions slow to load.', ['2', '2'], 5.3],
      ['SAP ERP extremely slow', 'SAP transactions extremely slow for all finance users.', ['1', '1'], 31, 'Solved (Work Around)', 'SM50 showed all dialog work processes blocked by long-running batch job Z_FIN_RECON scheduled during business hours. Cancelled the job, rescheduled it to 02:00 via SM37 and SAP response times returned to under 2 seconds. Recommend a problem record for batch job scheduling governance.'],
      ['SAP slow after kernel patch', 'SAP ERP slow response times since the weekend kernel patch.', ['2', '2'], 44, 'Solved (Permanently)', 'ST02 showed heavy buffer swaps after the kernel patch. Increased the program buffer (abap/buffersize) and restarted the SAP application servers in the maintenance window. Performance back to normal.'],
    ],
  },
  {
    ci: 'Print Server HQ',
    category: 'hardware',
    subcategory: null,
    group: 'Hardware',
    items: [
      ['Print jobs stuck in queue on 2nd floor printer', 'Print jobs sent to the 2nd floor HP printer sit in the print queue and never print.', ['3', '2'], 0.7],
      ['Cannot print - documents stuck in print queue', 'Documents stuck in the print queue on Print Server HQ, nothing comes out of the printer.', ['3', '1'], 1.6],
      ['Print queue not clearing on Print Server HQ', 'Print queue not clearing, cancelled print jobs remain stuck with status "Deleting".', ['2', '2'], 2.4],
      ['Print spooler errors - nothing printing', 'Print spooler error when printing, jobs stuck in queue for the whole marketing team.', ['2', '2'], 3.6],
      ['Print queue stuck, jobs not printing', 'All print jobs stuck in the queue on Print Server HQ.', ['2', '2'], 25, 'Solved (Permanently)', 'Print Spooler service on Print Server HQ hung on a corrupt HP Universal Print Driver job. Stopped the spooler, cleared C:\\Windows\\System32\\spool\\PRINTERS, restarted the service and updated HP UPD to 7.1. Print queue cleared and jobs printing.'],
    ],
  },
]

const KB: [string, string, string][] = [
  ['GlobalProtect VPN keeps disconnecting', 'network', 'If the GlobalProtect VPN disconnects every few minutes, upgrade the client to 6.2.4 or later from Software Center, then clear the gateway cache under %LOCALAPPDATA%\\Palo Alto Networks\\GlobalProtect and reconnect.'],
  ['Fixing Outlook email sync problems', 'email', 'If Outlook is not syncing new email, check Outlook on the web first. If mail appears there, close Outlook and rebuild the OST cache. For mobile sync failures after a password change, remove and re-add the account.'],
  ['Clearing a stuck print queue', 'hardware', 'When print jobs are stuck in the queue, the Hardware team restarts the Print Spooler service on Print Server HQ and clears the spool folder. Users can cancel their own jobs from Settings > Printers.'],
]

export function seedSimilar(db: Db, ctx: { users: Record<string, Row>; groups: Record<string, Row>; cis: Record<string, Row>; hoursAgo: (h: number) => string }) {
  const { users, groups, cis, hoursAgo } = ctx
  const callers = Object.values(users).filter((u) => u.role === 'user')
  const agents = Object.values(users).filter((u) => u.role !== 'user')
  const actor = (u: Row) => ({ sys_id: String(u.sys_id), user_name: String(u.user_name), name: String(u.name) })
  let n = 0
  for (const t of THEMES) {
    for (const [sd, desc, [impact, urgency], days, closeCode, closeNotes] of t.items) {
      n++
      const caller = callers[(n * 5) % callers.length]
      const agent = agents[(n * 3) % agents.length]
      const resolved = Boolean(closeCode)
      const ageH = days * 24
      const state = resolved ? (days > 30 ? '7' : '6') : n % 4 === 0 ? '1' : n % 5 === 0 ? '3' : '2'
      const inc = insertRecord(
        db,
        'incident',
        {
          short_description: sd,
          description: desc,
          category: t.category,
          subcategory: t.subcategory,
          cmdb_ci: cis[t.ci].sys_id,
          caller_id: caller.sys_id,
          assignment_group: groups[t.group].sys_id,
          assigned_to: state === '1' ? null : agent.sys_id,
          impact,
          urgency,
          priority: calcPriority(impact, urgency),
          state,
          contact_type: ['email', 'phone', 'self-service', 'chat'][n % 4],
          close_code: closeCode ?? null,
          close_notes: closeNotes ?? null,
          opened_at: hoursAgo(ageH),
          resolved_at: resolved ? hoursAgo(ageH - 5) : undefined,
          sys_created_on: hoursAgo(ageH),
          sys_updated_on: hoursAgo(Math.max(ageH - (resolved ? 5 : 1), 0)),
        },
        actor(caller),
        { skipRules: true },
      )
      const id = String(inc.sys_id)
      addJournal(db, 'incident', id, 'comments', desc, actor(caller), hoursAgo(ageH))
      if (state !== '1') addJournal(db, 'incident', id, 'work_notes', resolved ? `Resolved: ${closeNotes}` : 'Investigating - checking for related incidents on the same CI.', actor(agent), hoursAgo(Math.max(ageH - 1, 0)))
    }
  }
  KB.forEach(([short_description, kb_category, text], i) => {
    insertRecord(db, 'kb_knowledge', { short_description, kb_category, text, workflow_state: 'published', author: agents[i % agents.length].sys_id, sys_created_on: hoursAgo(24 * (40 + i * 7)) }, null, { skipRules: true })
  })
}
