import { addJournal, insertRecord, nowStr, updateRecord } from './db.ts'
import type { Db, Row } from './db.ts'
import { calcPriority } from '../shared/schema.ts'
import { seedSimilar } from './seed-similar.ts'

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

const USERS = [
  ['admin', 'System Administrator', 'Platform Administrator', 'IT', 'admin', 'San Diego'],
  ['beth.anglin', 'Beth Anglin', 'Service Desk Analyst', 'IT', 'itil', 'San Diego'],
  ['david.loo', 'David Loo', 'Network Engineer', 'IT', 'itil', 'Santa Clara'],
  ['fred.luddy', 'Fred Luddy', 'Database Administrator', 'IT', 'itil', 'San Diego'],
  ['itil', 'ITIL User', 'Service Desk Lead', 'IT', 'itil', 'London'],
  ['don.goodliffe', 'Don Goodliffe', 'Change Manager', 'IT', 'itil', 'Chicago'],
  ['luke.wilson', 'Luke Wilson', 'Security Analyst', 'IT', 'itil', 'Amsterdam'],
  ['abel.tuter', 'Abel Tuter', 'Sales Director', 'Sales', 'user', 'New York'],
  ['abraham.lincoln', 'Abraham Lincoln', 'Account Executive', 'Sales', 'user', 'Chicago'],
  ['bud.richman', 'Bud Richman', 'Financial Analyst', 'Finance', 'user', 'New York'],
  ['carol.coughlin', 'Carol Coughlin', 'HR Business Partner', 'Human Resources', 'user', 'London'],
  ['charlie.whitherspoon', 'Charlie Whitherspoon', 'Product Manager', 'Product', 'user', 'Santa Clara'],
  ['employee', 'Joe Employee', 'Marketing Specialist', 'Marketing', 'user', 'San Diego'],
  ['jane.doe', 'Jane Doe', 'Controller', 'Finance', 'user', 'Amsterdam'],
  ['rick.berzle', 'Rick Berzle', 'Software Engineer', 'Engineering', 'user', 'Santa Clara'],
  ['sam.sorokin', 'Sam Sorokin', 'Recruiter', 'Human Resources', 'user', 'Chicago'],
] as const

const GROUPS = [
  ['Service Desk', 'beth.anglin', 'First line support for all end-user issues'],
  ['Network', 'david.loo', 'LAN/WAN, VPN, wireless and DNS'],
  ['Database', 'fred.luddy', 'Oracle, PostgreSQL and SQL Server operations'],
  ['Hardware', 'itil', 'Laptops, desktops, peripherals and break/fix'],
  ['Software', 'beth.anglin', 'Business applications and desktop software'],
  ['Change Management', 'don.goodliffe', 'CAB and change coordination'],
  ['Security Operations', 'luke.wilson', 'SOC, phishing response and access reviews'],
] as const

const CIS: [string, string, string, string, string, string][] = [
  ['SAP ERP Production', 'cmdb_ci_appl', 'production', '10.10.1.20', 'SUSE Linux 15', 'Software'],
  ['Email - Exchange Online', 'cmdb_ci_service', 'production', '', '', 'Software'],
  ['Corporate VPN', 'cmdb_ci_service', 'production', '', '', 'Network'],
  ['lnux-web-01', 'cmdb_ci_server', 'production', '10.10.2.11', 'RHEL 9', 'Software'],
  ['lnux-web-02', 'cmdb_ci_server', 'production', '10.10.2.12', 'RHEL 9', 'Software'],
  ['win-app-07', 'cmdb_ci_server', 'production', '10.10.3.17', 'Windows Server 2022', 'Software'],
  ['ora-prod-db1', 'cmdb_ci_database', 'production', '10.10.4.31', 'Oracle Linux 8', 'Database'],
  ['pg-reporting-01', 'cmdb_ci_database', 'staging', '10.20.4.40', 'Ubuntu 22.04', 'Database'],
  ['sqlsrv-hr-01', 'cmdb_ci_database', 'production', '10.10.4.55', 'Windows Server 2019', 'Database'],
  ['core-sw-sd-01', 'cmdb_ci_netgear', 'production', '10.0.0.1', 'Cisco IOS XE', 'Network'],
  ['fw-edge-ams', 'cmdb_ci_netgear', 'production', '10.0.0.254', 'PAN-OS 11', 'Network'],
  ['wlc-hq-01', 'cmdb_ci_netgear', 'production', '10.0.1.5', 'Aruba OS 8', 'Network'],
  ['Workday HCM', 'cmdb_ci_appl', 'production', '', 'SaaS', 'Software'],
  ['Salesforce CRM', 'cmdb_ci_appl', 'production', '', 'SaaS', 'Software'],
  ['Jenkins CI', 'cmdb_ci_appl', 'development', '10.30.1.9', 'Ubuntu 22.04', 'Software'],
  ['LT-ATUTER-MBP', 'cmdb_ci_computer', 'production', '10.50.12.44', 'macOS 15', 'Hardware'],
  ['LT-BRICHMAN-XPS', 'cmdb_ci_computer', 'production', '10.50.12.61', 'Windows 11', 'Hardware'],
  ['LT-JDOE-T14', 'cmdb_ci_computer', 'production', '10.50.13.8', 'Windows 11', 'Hardware'],
  ['Print Server HQ', 'cmdb_ci_server', 'production', '10.10.5.2', 'Windows Server 2019', 'Hardware'],
  ['Okta SSO', 'cmdb_ci_service', 'production', '', 'SaaS', 'Security Operations'],
]

const INCIDENTS: [string, string, string, string, string, string][] = [
  // short description, category, subcategory, CI, group, description
  ['Unable to connect to VPN from home', 'network', 'vpn', 'Corporate VPN', 'Network', 'GlobalProtect client shows "Gateway not responding" since this morning.'],
  ['Outlook keeps asking for password', 'software', 'email', 'Email - Exchange Online', 'Service Desk', 'Credential prompt loops every few minutes after password change.'],
  ['SAP ERP running extremely slow', 'software', 'erp', 'SAP ERP Production', 'Software', 'Transactions ME21N and VA01 take over 60 seconds to load for the whole finance team.'],
  ['Laptop will not power on', 'hardware', 'cpu', 'LT-BRICHMAN-XPS', 'Hardware', 'No lights, no fan after overnight charge. Tried a different charger.'],
  ['Email server down - cannot send or receive', 'software', 'email', 'Email - Exchange Online', 'Service Desk', 'Multiple users in New York report NDRs on outbound mail.'],
  ['Wireless drops every 10 minutes on 3rd floor', 'network', 'wireless', 'wlc-hq-01', 'Network', 'Clients disconnect from CORP-WIFI and reconnect after ~30s.'],
  ['Oracle tablespace almost full on ora-prod-db1', 'database', 'oracle', 'ora-prod-db1', 'Database', 'Monitoring alert: USERS tablespace at 94%.'],
  ['Suspicious email with invoice attachment', 'security', 'phishing', 'Email - Exchange Online', 'Security Operations', 'User forwarded an email from "accounts@paypa1.com" with a .html attachment.'],
  ['Monitor flickering', 'hardware', 'monitor', 'LT-JDOE-T14', 'Hardware', 'External Dell monitor flickers when connected via dock.'],
  ['Cannot access Workday to submit timesheet', 'software', 'internal application', 'Workday HCM', 'Software', 'SSO redirect loop when opening Workday from Okta dashboard.'],
  ['Website returning 502 errors', 'software', 'os', 'lnux-web-01', 'Software', 'Public site intermittently returns 502 Bad Gateway behind load balancer.'],
  ['Request to reset MFA device', 'inquiry', 'internal application', 'Okta SSO', 'Service Desk', 'New phone, need Okta Verify re-enrolled.'],
  ['Printer on 2nd floor jammed and offline', 'hardware', 'disk', 'Print Server HQ', 'Hardware', 'HP LaserJet shows paper jam even after clearing tray 2.'],
  ['DNS resolution failing for internal sites', 'network', 'dns', 'core-sw-sd-01', 'Network', 'intranet.corp.local not resolving from San Diego office.'],
  ['Salesforce reports not loading', 'software', 'internal application', 'Salesforce CRM', 'Software', 'Pipeline dashboard spins forever.'],
  ['Antivirus definitions out of date', 'inquiry', 'antivirus', 'LT-ATUTER-MBP', 'Service Desk', 'Defender shows definitions 14 days old.'],
  ['Keyboard keys sticking', 'hardware', 'keyboard', 'LT-ATUTER-MBP', 'Hardware', 'E and R keys intermittently not registering.'],
  ['SQL Server HR database login failures', 'database', 'sql server', 'sqlsrv-hr-01', 'Database', 'Error 18456 for service account svc_hrsync.'],
  ['Firewall blocking access to partner portal', 'network', 'ip address', 'fw-edge-ams', 'Network', 'partner.example.com blocked by URL filtering policy.'],
  ['Jenkins builds stuck in queue', 'software', 'os', 'Jenkins CI', 'Software', 'All agents offline after weekend patching.'],
  ['Shared drive mapping missing after login', 'network', 'dhcp', 'win-app-07', 'Service Desk', 'S: drive no longer maps via GPO.'],
  ['Malware alert on finance laptop', 'security', 'malware', 'LT-BRICHMAN-XPS', 'Security Operations', 'EDR quarantined Trojan:Win32/Wacatac on user device.'],
  ['Need access to reporting database', 'inquiry', 'internal application', 'pg-reporting-01', 'Database', 'Read-only access required for quarterly analysis.'],
  ['Mouse not working', 'hardware', 'mouse', 'LT-JDOE-T14', 'Hardware', 'Bluetooth mouse not pairing.'],
  ['Teams calls dropping audio', 'software', 'email', 'Email - Exchange Online', 'Service Desk', 'Audio cuts out for others during calls.'],
  ['Memory usage high on lnux-web-02', 'hardware', 'memory', 'lnux-web-02', 'Software', 'Swap usage climbing, OOM killer triggered twice.'],
  ['VPN disconnects after 5 minutes', 'network', 'vpn', 'Corporate VPN', 'Network', 'Tunnel drops consistently for Amsterdam users.'],
  ['Unable to login to SAP GUI', 'software', 'erp', 'SAP ERP Production', 'Software', 'User locked after password expiry.'],
  ['Access badge flagged in access review', 'security', 'access', 'Okta SSO', 'Security Operations', 'Terminated contractor still has active SSO session.'],
  ['PostgreSQL replication lag on reporting', 'database', 'postgres', 'pg-reporting-01', 'Database', 'Replica 45 minutes behind primary.'],
]

const KB: [string, string, string][] = [
  ['How to connect to the corporate VPN', 'network', 'Install the GlobalProtect client from the Software Center, enter vpn.corp.example.com as the portal, and sign in with your SSO credentials. Approve the Okta push to finish.\n\nIf the client shows "Gateway not responding", switch networks or restart the PanGPS service.'],
  ['Resetting your Okta MFA device', 'security', 'Open the Service Portal and order "MFA Device Reset". The Service Desk will verify your identity by phone and clear the old factor within 1 business hour.'],
  ['Outlook keeps prompting for credentials', 'email', 'Close Outlook, open Credential Manager and remove all entries beginning with "MicrosoftOffice". Restart Outlook and sign in again.\n\nIf the issue continues, create a new Outlook profile from Control Panel > Mail.'],
  ['Requesting a new laptop', 'hardware', 'Standard laptops are refreshed every 3 years. Order a "Standard Laptop" or "Developer Laptop" from the Service Catalog. Approval from your manager is required for items over $1,000.'],
  ['Reporting a phishing email', 'security', 'Use the "Report Phish" button in Outlook. Do not click links or open attachments. Security Operations reviews every report within 30 minutes.'],
  ['Connecting to CORP-WIFI', 'network', 'Select CORP-WIFI, choose PEAP authentication, and sign in with your network credentials. Guests should use CORP-GUEST.'],
  ['Mapping a network drive', 'software', 'Open File Explorer > This PC > Map network drive. Choose a letter and enter \\\\fs01.corp.local\\share. Check "Reconnect at sign-in".'],
  ['Password policy', 'hr', 'Passwords must be at least 14 characters and are rotated every 180 days. Passphrases are encouraged.'],
  ['Installing approved software', 'software', 'All approved software is available in Software Center (Windows) or Self Service (macOS). Request non-standard software via the Service Catalog.'],
  ['Clearing a printer jam on HP LaserJet', 'hardware', 'Open tray 2 and the rear access door. Gently pull jammed paper in the direction of the paper path. Close all doors and press OK.'],
  ['Expense reimbursement policy', 'hr', 'Submit expenses in Workday within 30 days. Receipts are required for any item over $25.'],
  ['Troubleshooting slow SAP transactions', 'software', 'Run transaction ST22 to check for dumps and SM50 for long-running work processes. Escalate to the Software group if more than 10 users are affected.'],
]

const CAT_ITEMS: [string, string, number, string, string, string, string][] = [
  ['Standard Laptop', 'hardware', 1199, '3 days', 'laptop', '14" business laptop, 16GB RAM, 512GB SSD', 'Hardware'],
  ['Developer Laptop', 'hardware', 2499, '5 days', 'laptop', '16" high-performance laptop, 32GB RAM, 1TB SSD', 'Hardware'],
  ['iPhone 16', 'hardware', 899, '4 days', 'phone', 'Corporate mobile phone with MDM enrollment', 'Hardware'],
  ['27" 4K Monitor', 'hardware', 349, '2 days', 'monitor', 'USB-C monitor with built-in hub', 'Hardware'],
  ['Wireless Headset', 'hardware', 129, '2 days', 'headset', 'Noise-cancelling headset certified for Teams', 'Hardware'],
  ['Microsoft Visio', 'software', 280, '1 day', 'software', 'Diagramming software license', 'Software'],
  ['Adobe Acrobat Pro', 'software', 240, '1 day', 'software', 'Create, edit and sign PDF documents', 'Software'],
  ['VPN Access', 'access', 0, '4 hours', 'key', 'Remote access to the corporate network', 'Network'],
  ['Database Access Request', 'access', 0, '1 day', 'database', 'Read-only or read/write access to a database', 'Database'],
  ['MFA Device Reset', 'services', 0, '1 hour', 'shield', 'Re-enroll your multi-factor authentication device', 'Service Desk'],
  ['New Hire Onboarding', 'services', 0, '5 days', 'user', 'Accounts, hardware and access for a new employee', 'Service Desk'],
  ['Conference Room AV Setup', 'services', 150, '2 days', 'video', 'AV technician support for meetings and events', 'Hardware'],
]

const CHANGES: [string, string, string, string, string][] = [
  ['Patch RHEL web servers - October cycle', 'software', 'lnux-web-01', 'normal', 'Software'],
  ['Upgrade core switch firmware', 'network', 'core-sw-sd-01', 'normal', 'Network'],
  ['Increase USERS tablespace on ora-prod-db1', 'database', 'ora-prod-db1', 'standard', 'Database'],
  ['Emergency firewall rule for partner portal', 'network', 'fw-edge-ams', 'emergency', 'Network'],
  ['SAP kernel upgrade', 'software', 'SAP ERP Production', 'normal', 'Software'],
  ['Rotate VPN gateway certificates', 'network', 'Corporate VPN', 'normal', 'Network'],
  ['Add memory to lnux-web-02', 'hardware', 'lnux-web-02', 'standard', 'Software'],
  ['Migrate Jenkins agents to new image', 'software', 'Jenkins CI', 'normal', 'Software'],
  ['Enable conditional access policy in Okta', 'software', 'Okta SSO', 'normal', 'Security Operations'],
  ['Replace wireless controller HA pair', 'network', 'wlc-hq-01', 'normal', 'Network'],
  ['PostgreSQL minor version upgrade', 'database', 'pg-reporting-01', 'standard', 'Database'],
  ['Decommission legacy print server', 'hardware', 'Print Server HQ', 'normal', 'Hardware'],
]

const PROBLEMS: [string, string, string, string][] = [
  ['Recurring VPN disconnects for remote users', 'network', 'Corporate VPN', 'Network'],
  ['SAP ERP performance degradation during month end', 'software', 'SAP ERP Production', 'Software'],
  ['Exchange Online authentication prompts after password change', 'software', 'Email - Exchange Online', 'Service Desk'],
  ['Wireless controller roaming failures on HQ floors', 'network', 'wlc-hq-01', 'Network'],
  ['Memory leak in web tier application', 'software', 'lnux-web-02', 'Software'],
  ['Phishing campaign targeting finance', 'security', 'Email - Exchange Online', 'Security Operations'],
]

const WORK_NOTES = [
  'Checked logs, seeing repeated timeouts from the upstream service.',
  'Reached out to the user, waiting for a callback.',
  'Reproduced the issue on a test machine.',
  'Escalating to second line support for further analysis.',
  'Applied a temporary workaround; monitoring for 24 hours.',
  'Vendor case opened, reference #VC-88213.',
]

const COMMENTS = [
  'Thanks, I will try that and let you know.',
  'This is still happening, it is blocking my work.',
  'Is there an update on this?',
  'That fixed it for now, thank you!',
]

export function seed(db: Db): void {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM sys_user').get() as { n: number }).n
  if (count > 0) return
  const rand = rng(42)
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]
  const hoursAgo = (h: number) => nowStr(new Date(Date.now() - h * 3600000))

  db.exec('BEGIN')
  try {
    const users: Record<string, Row> = {}
    for (const [user_name, name, title, department, role, location] of USERS) {
      users[user_name] = insertRecord(
        db,
        'sys_user',
        {
          user_name,
          name,
          title,
          department,
          role,
          location,
          active: 'true',
          email: `${user_name}@example.com`,
          phone: `+1 555 01${String(Object.keys(users).length).padStart(2, '0')}`,
          sys_created_on: hoursAgo(24 * 400),
        },
        null,
      )
    }
    const agents = Object.values(users).filter((u) => u.role !== 'user')
    const callers = Object.values(users).filter((u) => u.role === 'user')
    const actorOf = (u: Row) => ({ sys_id: String(u.sys_id), user_name: String(u.user_name), name: String(u.name) })

    const groups: Record<string, Row> = {}
    for (const [name, mgr, description] of GROUPS) {
      groups[name] = insertRecord(db, 'sys_user_group', { name, manager: users[mgr].sys_id, description, email: `${name.toLowerCase().replace(/ /g, '-')}@example.com` }, null)
    }
    const cis: Record<string, Row> = {}
    for (const [name, cls, env, ip, os, group] of CIS) {
      cis[name] = insertRecord(
        db,
        'cmdb_ci',
        {
          name,
          sys_class_name: cls,
          environment: env,
          ip_address: ip,
          os,
          operational_status: name === 'lnux-web-02' ? '3' : '1',
          location: pick(['San Diego', 'Santa Clara', 'Amsterdam', 'London', 'Chicago']),
          owned_by: pick(agents).sys_id,
          support_group: groups[group].sys_id,
          short_description: `${name} (${env})`,
        },
        null,
      )
    }

    const problems: Row[] = []
    PROBLEMS.forEach(([sd, cat, ci, group], i) => {
      const impact = String(1 + Math.floor(rand() * 2))
      const urgency = String(1 + Math.floor(rand() * 3))
      problems.push(
        insertRecord(
          db,
          'problem',
          {
            short_description: sd,
            category: cat,
            cmdb_ci: cis[ci].sys_id,
            assignment_group: groups[group].sys_id,
            assigned_to: pick(agents).sys_id,
            impact,
            urgency,
            state: ['101', '102', '103', '104', '106', '103'][i],
            known_error: i % 2 === 0 ? 'true' : 'false',
            description: `Multiple incidents linked: ${sd.toLowerCase()}.`,
            workaround: i % 2 === 0 ? 'Restart the affected client/service; see related KB article.' : '',
            sys_created_on: hoursAgo(24 * (20 - i * 2)),
          },
          actorOf(users.admin),
        ),
      )
    })

    const changes: Row[] = []
    CHANGES.forEach(([sd, cat, ci, type, group], i) => {
      const state = ['-5', '-4', '-3', '-2', '-1', '0', '3', '-2', '-3', '-5', '3', '4'][i]
      const startH = (i - 6) * 30
      changes.push(
        insertRecord(
          db,
          'change_request',
          {
            short_description: sd,
            category: cat,
            cmdb_ci: cis[ci].sys_id,
            type,
            state,
            approval: type === 'standard' ? 'approved' : ['-2', '-1', '0', '3'].includes(state) ? 'approved' : state === '-3' ? 'requested' : 'not requested',
            risk: type === 'emergency' ? '2' : type === 'standard' ? '4' : '3',
            impact: type === 'emergency' ? '1' : '2',
            requested_by: users['don.goodliffe'].sys_id,
            assignment_group: groups[group].sys_id,
            assigned_to: pick(agents).sys_id,
            description: `${sd}. Planned maintenance window coordinated with service owners.`,
            justification: 'Required to maintain vendor support and security compliance.',
            implementation_plan: '1. Notify stakeholders\n2. Take snapshot/backup\n3. Apply change\n4. Validate service health',
            backout_plan: 'Restore from snapshot taken in step 2 and validate.',
            test_plan: 'Smoke test the service endpoints and confirm monitoring is green.',
            start_date: hoursAgo(-startH),
            end_date: hoursAgo(-startH - 4),
            sys_created_on: hoursAgo(24 * (14 - i)),
          },
          actorOf(users['don.goodliffe']),
          { skipRules: true },
        ),
      )
    })

    INCIDENTS.forEach(([sd, cat, sub, ci, group, desc], i) => {
      const ageH = Math.floor(rand() * 24 * 21) + 1
      const impact = String(1 + Math.floor(rand() * 3))
      const urgency = String(1 + Math.floor(rand() * 3))
      const roll = rand()
      const state = roll < 0.18 ? '1' : roll < 0.55 ? '2' : roll < 0.65 ? '3' : roll < 0.88 ? '6' : '7'
      const assigned = state === '1' ? null : pick(agents).sys_id
      const caller = pick(callers)
      const opened = hoursAgo(ageH)
      const resolved = ['6', '7'].includes(state)
      const prob = problems.find((p) => p.cmdb_ci === cis[ci].sys_id)
      const inc = insertRecord(
        db,
        'incident',
        {
          short_description: sd,
          description: desc,
          category: cat,
          subcategory: sub,
          cmdb_ci: cis[ci].sys_id,
          caller_id: caller.sys_id,
          assignment_group: groups[group].sys_id,
          assigned_to: assigned,
          impact,
          urgency,
          priority: calcPriority(impact, urgency),
          state,
          contact_type: pick(['email', 'phone', 'self-service', 'chat', 'walk-in']),
          problem_id: prob && rand() < 0.6 ? prob.sys_id : null,
          close_code: resolved ? 'Solved (Permanently)' : null,
          close_notes: resolved ? 'Issue resolved and confirmed with the caller.' : null,
          opened_at: opened,
          resolved_at: resolved ? hoursAgo(Math.max(ageH - 6, 0)) : undefined,
          sys_created_on: opened,
          sys_updated_on: hoursAgo(Math.max(ageH - 2, 0)),
        },
        actorOf(caller),
        { skipRules: true },
      )
      addJournal(db, 'incident', String(inc.sys_id), 'comments', `${desc}`, actorOf(caller), opened)
      if (assigned) {
        const agent = agents.find((a) => a.sys_id === assigned) ?? agents[0]
        addJournal(db, 'incident', String(inc.sys_id), 'work_notes', WORK_NOTES[i % WORK_NOTES.length], actorOf(agent), hoursAgo(Math.max(ageH - 1, 0)))
        if (i % 3 === 0) addJournal(db, 'incident', String(inc.sys_id), 'comments', COMMENTS[i % COMMENTS.length], actorOf(caller), hoursAgo(Math.max(ageH - 2, 0)))
      }
      if (i === 0) {
        updateRecord(db, 'incident', String(inc.sys_id), { impact: '1', urgency: '1' }, actorOf(users['beth.anglin']))
      }
    })

    const catItems: Row[] = []
    for (const [name, category, price, delivery_time, icon, short_description, group] of CAT_ITEMS) {
      catItems.push(
        insertRecord(
          db,
          'sc_cat_item',
          { name, category, price, delivery_time, icon, short_description, description: `${short_description}. Delivered in ${delivery_time}.`, active: 'true', fulfillment_group: groups[group].sys_id },
          null,
        ),
      )
    }
    for (let i = 0; i < 14; i++) {
      const item = pick(catItems)
      const qty = item.category === 'hardware' && rand() < 0.2 ? 2 : 1
      const stage = pick(['waiting_for_approval', 'request_approved', 'fulfillment', 'delivery', 'complete'] as const)
      insertRecord(
        db,
        'sc_req_item',
        {
          cat_item: item.sys_id,
          requested_for: pick(callers).sys_id,
          quantity: qty,
          price: Number(item.price) * qty,
          stage,
          state: stage === 'complete' ? '3' : stage === 'waiting_for_approval' || stage === 'request_approved' ? '1' : '2',
          approval: stage === 'waiting_for_approval' ? 'requested' : 'approved',
          assignment_group: item.fulfillment_group,
          assigned_to: stage === 'fulfillment' || stage === 'delivery' ? pick(agents).sys_id : null,
          short_description: item.name,
          sys_created_on: hoursAgo(24 * (14 - i)),
        },
        null,
      )
    }

    KB.forEach(([sd, cat, text], i) => {
      const kb = insertRecord(
        db,
        'kb_knowledge',
        { short_description: sd, kb_category: cat, text, workflow_state: i === 11 ? 'draft' : 'published', author: pick(agents).sys_id, sys_created_on: hoursAgo(24 * (90 - i * 5)) },
        null,
        { skipRules: true },
      )
      db.prepare('UPDATE kb_knowledge SET sys_view_count = ?, rating = ? WHERE sys_id = ?').run(Math.floor(rand() * 900) + 20, Math.floor(rand() * 40), kb.sys_id)
    })
    seedSimilar(db, { users, groups, cis, hoursAgo })
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
