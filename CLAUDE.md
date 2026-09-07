# munin

A personal second brain: a Discord bot on a private server for life stuff — memory, recall, reminders, check-ins. Named for Odin's raven Muninn, who flies out over the world daily and reports back; that daily-sweep-and-report is the product. It chats and remembers only: work execution belongs to Claude Code sessions, never this bot. It runs on a personal Anthropic key, kept separate from any work account.

## Architecture

- Channel = life domain (#cooking, #goals). `channel_settings` holds one row per channel with just `muted` (per-channel, no inheritance) and `ephemeral`. App-wide `chat_model` and `effort` live in the `app_settings` singleton, edited at runtime via `/config`. Memory lives in its own `memory` table, one row per channel/thread — `content` is a living document the model rewrites in place, not a log. The persona lives in `system.md` (read at startup in `messageHandler`), not the DB. A missing settings row means unmuted and non-ephemeral (zero setup); `ephemeral` inherits from the parent channel for threads, and memory reads tier global + parent + own. Messages in threads resolve to the parent channel's row. `channel_settings` reads/writes (`resolveSettings`, `setMuted`, `toggleEphemeral`) live in `src/repositories/channelSettings.ts`; the `memory` table's in `src/repositories/memory.ts` (`resolveMemory`, `updateMemory`); app-wide config in `src/repositories/appSettings.ts`.
- Prompts and memory are runtime-mutable state, so they live in the DB, never in the repo.
- `src/ai/index.ts` `turn()` is the agentic loop: one user message in, rounds of tool calls, one final text out. Tools are `makeTool()` objects; the turn ends when the model stops calling them.
- Exfil guardrail (the "lethal trifecta" of private data, untrusted content, and a way out). `makeTool` objects can carry `untrustedInput` (pulls attacker-controllable content into context) and `externalReach` (can send data to a destination the model chooses). Once a turn runs an `untrustedInput` tool, `turn()` refuses every `externalReach` tool for the rest of that turn. Separately, `web_extract` is provenance-gated: it opens only URLs that arrived from a `web_search` result earlier in the same turn or from a user's own message (seeded in `client.ts` via `findUrls`, matched after normalising), so a poisoned page can't steer it to an attacker URL. Tagging rule for new tools: a sensitive or untrusted read gets `untrustedInput`, an action whose destination the model picks gets `externalReach`, and a scoped tool with a fixed base URL and a server-side token gets neither.
- SQL-first migrations: plain `.sql` files in `src/db/migrations` (create via `pnpm db:migration <name>`), applied by `scripts/migrate.ts` against whatever `DATABASE_URL` the local `.env` supplies. Only `db:reset` runs the seed.
- Planned, not yet built: a daily sweep cron that reads channels, checks in only when it has something worth saying, and curates each channel's memory.

## Dev vs prod

Same VPS, separated by directory. This checkout is dev: Postgres on 5434 from `docker-compose.dev.yml`. Prod is a clone at `/srv/munin`: Postgres on 20132 from `docker-compose.yml` (port scheme: `~/PORTS.md`). One Discord bot serves both, so running dev while prod is up gets duplicate replies — stop one first. Deploying is done from `/srv/munin`: pull, `pnpm db:push`, restart. Because that deploy pulls from the remote, a commit only ships once it's on the remote — so when a commit is made specifically to ship, push it after committing (ordinary commits Josh reviews in the working tree and don't need pushing). Prod is touched only from that directory, deliberately — everything run from here stays on dev.

Debugging prod data: its Postgres is on `localhost:20132` (database and user both `postgres`), and the full `DATABASE_URL` with the password lives in `/srv/munin/.env` — connect with `export $(grep '^DATABASE_URL=' /srv/munin/.env)` then `psql "$DATABASE_URL"`. Keep prod DB access read-only, SELECTs only, unless Josh explicitly asks for a write.

## Conventions

- tsx runs everything; imports are extensionless (bundler resolution), so plain `node` cannot run this code.
- Chat model and effort are app-wide, in the `app_settings` row (GLM-5.2 on DeepInfra, high effort), set via `/config`; scheduled jobs stay on Sonnet regardless.
