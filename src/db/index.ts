import 'dotenv/config'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, types } from 'pg'
import type { DB } from './types'
import { dayjs } from '../time'

// timestamptz reads back as Dayjs; Dayjs goes in via pg's toPostgres() hook for unknown objects.
const toDate = types.getTypeParser(types.builtins.TIMESTAMPTZ)
types.setTypeParser(types.builtins.TIMESTAMPTZ, (v) => dayjs(toDate(v)))
dayjs.prototype.toPostgres = dayjs.prototype.toISOString

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({
    pool: new Pool({
      connectionString:
        process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5434/postgres',
    }),
  }),
})

// Fail at boot if timestamptz has stopped coming back as Dayjs, since the generated types assume it does.
const { rows } = await sql<{ now: unknown }>`select now()`.execute(db)
if (!dayjs.isDayjs(rows[0].now)) throw new Error('timestamptz is not being parsed as Dayjs')
