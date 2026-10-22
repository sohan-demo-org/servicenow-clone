import { insertRecord, nowStr } from './db.ts'
import { onCallAt } from './oncall.ts'
import type { Db, Row } from './db.ts'

const ENGINEERS: [string, string, string, string][] = [
  ['priya.sharma', 'Priya Sharma', 'Network Engineer', 'Santa Clara'],
  ['jamal.wright', 'Jamal Wright', 'Senior Network Engineer', 'Chicago'],
  ['marcus.chen', 'Marcus Chen', 'Database Administrator', 'Chicago'],
  ['ken.ito', 'Ken Ito', 'Database Reliability Engineer', 'San Diego'],
  ['olivia.martin', 'Olivia Martin', 'Desktop Support Technician', 'London'],
  ['tom.becker', 'Tom Becker', 'Application Support Engineer', 'New York'],
  ['sofia.rossi', 'Sofia Rossi', 'Service Desk Analyst', 'San Diego'],
  ['nina.patel', 'Nina Patel', 'SOC Analyst', 'Amsterdam'],
]

// group, rotation, handoff, timezone, members in rotation order
const ROTAS: [string, 'daily' | 'weekly', string, string, string[]][] = [
  ['Service Desk', 'daily', '08:00', 'America/Los_Angeles', ['beth.anglin', 'sofia.rossi', 'itil', 'olivia.martin']],
  ['Network', 'daily', '09:00', 'America/Los_Angeles', ['david.loo', 'priya.sharma', 'jamal.wright']],
  ['Database', 'weekly', '10:00', 'America/Chicago', ['fred.luddy', 'marcus.chen', 'ken.ito']],
  ['Hardware', 'daily', '09:00', 'Europe/London', ['olivia.martin', 'itil', 'sofia.rossi']],
  ['Software', 'weekly', '09:00', 'America/New_York', ['tom.becker', 'beth.anglin', 'ken.ito', 'priya.sharma']],
  ['Change Management', 'weekly', '09:00', 'America/Chicago', ['don.goodliffe', 'itil', 'tom.becker']],
  ['Security Operations', 'daily', '09:00', 'Europe/Amsterdam', ['luke.wilson', 'nina.patel', 'jamal.wright', 'marcus.chen']],
]

// group, covering member, start (hours from now), duration (hours), reason
const OVERRIDES: [string, string, number, number, string][] = [
  ['Security Operations', '', -3, 9, 'Swap: scheduled on-call speaking at SANS conference'],
  ['Network', 'jamal.wright', 26, 24, 'PTO swap: Priya at family wedding'],
  ['Database', 'ken.ito', 72, 36, 'Swap: Marcus on-site for DC migration'],
  ['Software', 'beth.anglin', 120, 12, 'Covering evening release window'],
]

/** On-call rotas, members and a few overrides; rota start dates sit in the recent past so rotations are mid-cycle. */
export function seedOnCall(db: Db, rand: () => number): void {
  const userId = (u: string) => (db.prepare('SELECT sys_id FROM sys_user WHERE user_name = ?').get(u) as Row | undefined)?.sys_id
  ENGINEERS.forEach(([user_name, name, title, location], i) => {
    if (userId(user_name)) return
    insertRecord(
      db,
      'sys_user',
      { user_name, name, title, location, department: 'IT', role: 'itil', active: 'true', email: `${user_name}@example.com`, phone: `+1 555 02${String(i).padStart(2, '0')}`, sys_created_on: nowStr(new Date(Date.now() - 200 * 86400000)) },
      null,
    )
  })
  const hours = (h: number) => nowStr(new Date(Date.now() + h * 3600000))
  const rotaIds: Record<string, string> = {}
  const rosters: Record<string, { sys_id: string; name: string; order: number }[]> = {}
  const defs: Record<string, { rotation_type: string; handoff_time: string; timezone: string; start_date: string }> = {}
  for (const [groupName, rotation_type, handoff_time, timezone, members] of ROTAS) {
    const group = db.prepare('SELECT sys_id FROM sys_user_group WHERE name = ?').get(groupName) as Row | undefined
    if (!group) continue
    const startDaysAgo = rotation_type === 'weekly' ? 7 * (2 + Math.floor(rand() * 3)) + Math.floor(rand() * 7) : 10 + Math.floor(rand() * 20)
    const rota = insertRecord(
      db,
      'cmn_rota',
      { name: `${groupName} Primary`, group: group.sys_id, rotation_type, handoff_time, timezone, start_date: hours(-24 * startDaysAgo), active: 'true' },
      null,
    )
    rotaIds[groupName] = String(rota.sys_id)
    defs[groupName] = { rotation_type, handoff_time, timezone, start_date: String(rota.start_date) }
    rosters[groupName] = members.map((u, i) => ({ sys_id: String(userId(u)), name: u, order: (i + 1) * 100 }))
    members.forEach((u, order) => insertRecord(db, 'cmn_rota_member', { rota: rota.sys_id, member: userId(u), order: (order + 1) * 100 }, null))
  }
  for (const [groupName, u, startH, durH, reason] of OVERRIDES) {
    if (!rotaIds[groupName]) continue
    // blank member = cover whoever is scheduled right now with the next person in the rotation
    const member = u ? userId(u) : onCallAt(defs[groupName], rosters[groupName], [], Date.now())?.secondary?.sys_id
    insertRecord(db, 'cmn_rota_override', { rota: rotaIds[groupName], member, start_date: hours(startH), end_date: hours(startH + durH), reason }, null)
  }
}
