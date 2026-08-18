import 'dotenv/config'
import { readdir, readFile } from 'node:fs/promises'
import { Client } from 'pg'

const command = process.argv[2] // argv: [node binary, script path, ...args]

if (command !== 'push' && command !== 'reset') {
  console.error('usage: tsx scripts/migrate.ts <push|reset>')
  process.exit(1)
}

const client = new Client({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5434/postgres',
})
await client.connect()

if (command === 'reset') {
  // takes _migrations with it, so the loop below reapplies everything from scratch
  await client.query('drop schema public cascade')
  await client.query('create schema public')
}

await client.query(
  'create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())',
)

const { rows } = await client.query('select name from _migrations')
const applied = new Set(rows.map((r: { name: string }) => r.name))

const files = (await readdir('src/db/migrations')).filter((f) => f.endsWith('.sql')).sort()

let failed = false
for (const name of files) {
  if (applied.has(name)) continue
  const sql = await readFile(`src/db/migrations/${name}`, 'utf8')
  try {
    await client.query('begin')
    await client.query(sql)
    await client.query('insert into _migrations (name) values ($1)', [name])
    await client.query('commit')
    console.log(`Successfully applied ${name}`)
  } catch (err) {
    await client.query('rollback')
    console.error(`failed ${name}:`, err)
    failed = true
    break
  }
}

if (!failed && command === 'reset') {
  const seed = await readFile('src/db/seed.sql', 'utf8')
  await client.query(seed)

}

await client.end()
if (failed) process.exit(1)
