# munin

my second brain. a discord bot on a private server that i talk to about life stuff (projects, habits, things i'm tracking) and it remembers. named after muninn, one of odin's ravens, who flies out over the world every day and reports back.

it chats and remembers, that's the whole job. actual work (writing code, running things) goes to claude code sessions, never this bot. runs on my personal anthropic key, kept away from anything work.

## how it works

each channel is one corner of life (#cooking, #goals, whatever). memory for a channel is a living document the model rewrites in place, not a log it appends to.

everything channel-specific lives in one `channel_settings` row per channel: `memory`, `system_prompt`, `model`, `effort`. a reserved `global` row holds the global memory plus the default model and effort. missing rows or null columns inherit (parent channel, then global), so a brand new channel works with zero setup. messages in threads resolve to the parent channel's row.

the persona lives in `system.md`, read at startup, not the db. prompts and memory are runtime state so they live in the db and never in the repo.

`src/ai/index.ts` `turn()` is the loop: one message in, rounds of tool calls, one reply out. tools so far: `web_search`, `web_extract`, `update_memory`, `start_work`. slash commands: `/config`, `/model`, `/effort`.

not built yet: the daily sweep, a cron that looks in on the channels, checks in only when something's worth saying, and keeps each channel's memory tidy. that's the raven part and it's the point.

## stack

typescript run straight through tsx, no build step. imports are extensionless (bundler resolution) so plain `node` can't run it. discord.js, kysely + pg on postgres, pnpm. anthropic sdk for the model, with deepinfra as an option, and tavily for search. chat model and effort come from the db (the global row's defaults, overridable per channel). scheduled jobs stay on sonnet regardless.

## dev vs prod

same vps, split by directory, don't mix them up.

- **dev** is this checkout. postgres on 5434 from `docker-compose.dev.yml`.
- **prod** is a separate clone at `/srv/munin`. postgres on 20132 from `docker-compose.yml`.

one bot token serves both, so if prod is up and i start dev i get double replies. stop one before running the other (`sudo systemctl stop munin`).

## running dev

need a `.env` (see below), then:

```bash
pnpm install
pnpm db:up      # dev postgres + gateway ui
pnpm db:push    # apply migrations
pnpm dev        # run the bot, hot reload
```

migrations are plain sql in `src/db/migrations`. new one: `pnpm db:migration <name>`, write the sql, `pnpm db:push`. `pnpm db:reset` wipes and reseeds, dev only, and it physically can't touch prod because the `db:*` scripts only ever point at the dev compose file.

## deploying

prod runs as a systemd service (`munin.service`), so it restarts on crash and comes back after a reboot. every release is one command from this checkout:

```bash
pnpm ship
```

that runs `scripts/deploy.sh`: cd into `/srv/munin`, pull, install, bring the db up, migrate, reload systemd, restart the service. it's called `ship` and not `deploy` because `pnpm deploy` is already a builtin pnpm command.

logs: `journalctl -u munin -f`. status: `systemctl status munin`.

### first-time prod setup (once, by hand)

```bash
sudo mkdir -p /srv/munin && sudo chown "$(id -un):$(id -gn)" /srv/munin
git clone <remote> /srv/munin
cd /srv/munin
# create /srv/munin/.env with PROD values (DATABASE_URL on :20132)
pnpm install --frozen-lockfile
docker compose up -d --wait
pnpm exec tsx scripts/migrate.ts push   # apply the schema before first start
sudo systemctl link /srv/munin/munin.service
sudo systemctl daemon-reload
sudo systemctl enable --now munin
```

after that it's `pnpm ship` forever. prod's `.env` is written once by hand and never copied from dev, different database on a different port.

## env

`.env` in the repo root (gitignored):

- `DATABASE_URL`
- `DISCORD_BOT_TOKEN`
- `ANTHROPIC_API_KEY`
- `DEEPINFRA_API_KEY`
- `TAVILY_API_KEY`
