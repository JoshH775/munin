#!/usr/bin/env bash
set -euo pipefail

cd /srv/munin

echo "▶ pull";     git pull --ff-only
echo "▶ deps";     pnpm install --frozen-lockfile
echo "▶ db up";    docker compose up -d --wait
echo "▶ migrate";  pnpm exec tsx scripts/migrate.ts push
echo "▶ reload";   sudo systemctl daemon-reload
echo "▶ restart";  sudo systemctl restart munin
echo "✓ deployed — logs: journalctl -u munin -f"
