import { randomBytes } from 'node:crypto'
import type { Response } from 'express'

export interface PresenceUser {
  sys_id: string
  name: string
  user_name: string
}

export interface Viewer {
  client: string
  user: PresenceUser
  editing: string[]
  since: string
}

export type RecordEvent =
  | { type: 'updated'; by: PresenceUser | null; client: string | null; fields: string[]; sys_mod_count: number }
  | { type: 'journal'; by: PresenceUser | null; client: string | null; element: string }
  | { type: 'deleted'; by: PresenceUser | null; client: string | null }

interface Client extends Viewer {
  res: Response
}

const key = (table: string, id: string) => `${table}:${id}`

/** Tracks who has a record form open (over Server-Sent Events) and fans out record changes to them. */
export class PresenceHub {
  private rooms = new Map<string, Map<string, Client>>()
  private heartbeat: NodeJS.Timeout

  constructor(heartbeatMs = 15000) {
    this.heartbeat = setInterval(() => {
      for (const room of this.rooms.values()) for (const c of room.values()) c.res.write(': ping\n\n')
    }, heartbeatMs)
    this.heartbeat.unref()
  }

  join(table: string, id: string, user: PresenceUser, res: Response, client = randomBytes(8).toString('hex')): string {
    const k = key(table, id)
    let room = this.rooms.get(k)
    if (!room) this.rooms.set(k, (room = new Map()))
    room.get(client)?.res.end()
    room.set(client, { client, user, editing: [], since: new Date().toISOString(), res })
    res.on('close', () => this.leave(table, id, client))
    this.send(res, 'hello', { client })
    this.broadcastPresence(k)
    return client
  }

  leave(table: string, id: string, client: string) {
    const k = key(table, id)
    const room = this.rooms.get(k)
    if (!room?.delete(client)) return
    if (!room.size) this.rooms.delete(k)
    this.broadcastPresence(k)
  }

  setEditing(table: string, id: string, client: string, editing: string[]): boolean {
    const k = key(table, id)
    const c = this.rooms.get(k)?.get(client)
    if (!c) return false
    const next = [...new Set(editing)].sort()
    if (next.join() === c.editing.join()) return true
    c.editing = next
    this.broadcastPresence(k)
    return true
  }

  viewers(table: string, id: string): Viewer[] {
    return [...(this.rooms.get(key(table, id))?.values() ?? [])].map(({ client, user, editing, since }) => ({ client, user, editing, since }))
  }

  notify(table: string, id: string, event: RecordEvent) {
    const room = this.rooms.get(key(table, id))
    if (!room) return
    for (const c of room.values()) this.send(c.res, 'record', event)
  }

  close() {
    clearInterval(this.heartbeat)
    for (const room of this.rooms.values()) for (const c of room.values()) c.res.end()
    this.rooms.clear()
  }

  private broadcastPresence(k: string) {
    const room = this.rooms.get(k)
    if (!room) return
    const [table, id] = k.split(':')
    const viewers = this.viewers(table, id)
    for (const c of room.values()) this.send(c.res, 'presence', { viewers })
  }

  private send(res: Response, event: string, data: unknown) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
}
