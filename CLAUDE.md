# munin

A personal second brain: a Discord bot on a private server for life stuff — memory, recall, reminders, check-ins. Named for Odin's raven Muninn, who flies out over the world daily and reports back; that daily-sweep-and-report is the product. It chats and remembers only: work execution belongs to Claude Code sessions, never this bot. It runs on a personal Anthropic key, kept separate from any work account.

## Architecture

- Channel = life domain (#cooking, #goals). `channel_settings` holds one row per channel: `memory` (a living document the model rewrites in place, not a log), `system_prompt`, `model`, `effort`. The persona lives in `system.md` (read at startup), not the DB. The reserved `'global'` row carries global memory and the default model and effort. A missing row or null column inherits (parent channel, then the global row), so a new channel works with zero setup. Messages in threads resolve to the parent channel's row.
- Prompts and memory are runtime-mutable state, so they live in the DB, never in the repo.
- `src/ai/index.ts` `turn()` is the agentic loop: one user message in, rounds of tool calls, one final text out. Tools are `makeTool()` objects; a `terminal` tool ends the turn.
- SQL-first migrations: plain `.sql` files in `src/db/migrations` (create via `pnpm db:migration <name>`), applied by `scripts/migrate.ts` against whatever `DATABASE_URL` the local `.env` supplies. Only `db:reset` runs the seed.
- Planned, not yet built: a daily sweep cron that reads channels, checks in only when it has something worth saying, and curates each channel's memory.

## Dev vs prod

Same VPS, separated by directory. This checkout is dev: Postgres on 5434 from `docker-compose.dev.yml`. Prod is a clone at `/srv/munin`: Postgres on 20132 from `docker-compose.yml` (port scheme: `~/PORTS.md`). One Discord bot serves both, so running dev while prod is up gets duplicate replies — stop one first. Deploying is done from `/srv/munin`: pull, `pnpm db:push`, restart. Prod is touched only from that directory, deliberately — everything run from here stays on dev.

## Conventions

- tsx runs everything; imports are extensionless (bundler resolution), so plain `node` cannot run this code.
- Chat model and effort default to the global row's values (Sonnet 5, medium effort); per-channel `model`/`effort` overrides apply to chat only, and scheduled jobs stay on Sonnet regardless.
