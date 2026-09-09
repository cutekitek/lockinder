#!/usr/bin/env bash
set -euo pipefail

# Run from the repository root. Compose uses a stable project name so its
# database volume survives runner checkouts and image replacements.
docker compose config --quiet
worker_id=$(docker compose ps -q worker)
if [ -n "$worker_id" ]; then
  backup="/data/backup-$(date -u +%Y%m%dT%H%M%SZ)-${IMAGE_TAG:-manual}.db"
  docker compose exec -T worker bun scripts/backup.ts "$backup"
fi

# Stop both old processes before either new process can apply migrations.
# A failed build never reaches this step. Migrations are forward-only; do not
# automatically roll back the image against a newly migrated database.
docker compose stop worker web
docker compose up -d --no-build --wait --wait-timeout 120
docker compose exec -T web bun -e "const r = await fetch('http://127.0.0.1:3000/api/health'); if (!r.ok) process.exit(1); console.log(await r.text())"
