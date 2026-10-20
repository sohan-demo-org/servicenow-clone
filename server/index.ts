import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { createApp } from './app.ts'
import { openDb } from './db.ts'
import { seed } from './seed.ts'
import { refreshConflictStatus } from './changeschedule.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dbPath = process.env.DB_PATH ?? resolve(root, 'data', 'servicenow.db')
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })

const db = openDb(dbPath)
seed(db)
refreshConflictStatus(db)

const app = createApp(db)
const dist = resolve(root, 'dist')
if (existsSync(dist)) {
  app.use(express.static(dist))
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(resolve(dist, 'index.html')))
}

const port = Number(process.env.PORT ?? 3001)
app.listen(port, () => console.log(`ServiceNow clone API listening on http://localhost:${port} (db: ${dbPath})`))
