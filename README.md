# Lockinder

A Deadlock teammate finder built with Next.js App Router, TypeScript, Tailwind CSS, Drizzle and SQLite. Players sign in with Steam, complete their profile and browse a deck of teammates. Discord is optional; connected players can receive private like notifications; there are no mutual matches or in-app messages.

The interface supports English and Russian, including country names, language names and localized game catalogs. Game images are served from the Deadlock API asset service. No sample accounts or authentication bypasses exist in the running application.

## Run locally

Use Bun 1.4.0 or newer. The web app, worker, database tools and backend tests run on Bun. From this directory:

```powershell
bun install --frozen-lockfile
Copy-Item .env.example .env
# Fill in your integration settings in .env.
bun run db:migrate
bun run dev
```

Open **http://localhost:3000**. In a second terminal, start notification delivery:

```powershell
bun run worker
```

Use `.env` for both processes; restart them after changing it. On macOS/Linux, use `cp .env.example .env` instead of `Copy-Item`. Without Discord credentials, players can complete their profiles, browse, like players and use Steam contact links. Discord notifications remain unavailable. The worker can stay idle until likes exist.

## Integration setup

### Steam

- Website authentication uses [Steam OpenID](https://partner.steamgames.com/doc/features/auth#website), verified directly against Steam. The site never receives Steam passwords.
- Set `APP_URL` to the exact origin used in your browser, with no path, for example `http://localhost:3000` or `https://lockinder.example`.
- The return URL is `APP_URL/api/auth/steam/callback`, with a per-request state query parameter. OpenID does not require registering an OAuth application.
- Set `STEAM_API_KEY` from [Steam’s API key page](https://steamcommunity.com/dev/apikey) to populate Steam display names and avatars. OpenID login itself works without this key; a new player then starts with an editable fallback name and initial avatar.
- Steam identifiers remain decimal strings. Account ID conversion uses `BigInt` before converting the bounded 32-bit result.

### Discord

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Add the OAuth2 redirect URL `APP_URL/api/auth/discord/callback` exactly. Copy the client ID, client secret and bot token into `.env`.
3. Invite the bot to your own community server with the `bot` scope. This implementation uses REST calls, not a Gateway connection, message-content access or administrator permissions.
4. Set `DISCORD_GUILD_ID` to that server’s ID and `DISCORD_INVITE_URL` to a persistent `https://discord.gg/...` invitation.
5. On the site, link your Discord identity, join the server, permit DMs from its members, and click **Verify & send test DM**. A successful membership lookup and test message enable Discord notifications. Profile discovery does not require Discord.

Linking requests the `identify` OAuth scope. Only the verified Discord ID/username are stored; user OAuth tokens are not retained. The bot token remains server-side. A Discord account can be linked to only one Steam account. Users join the server themselves; connecting does not silently join it for them.

For live notification testing, `APP_URL` must be reachable by the recipient. A localhost link is useful only on the machine running the app. A bot can still be prevented from sending DMs by Discord privacy settings or a user blocking it; the site records the error and asks the recipient to repair the connection.

### Deadlock

The app uses the [Deadlock API](https://api.deadlock-api.com/docs):

- `GET /v1/players/{account_id}/rank` for the rank from the latest recorded ranked match.
- `GET /v1/assets/heroes` and `/v1/assets/ranks`, with `english` or `russian` localization.

Public access works without a key; `DEADLOCK_API_KEY` is optional. A profile read refreshes rank if the last successful fetch is over an hour old. Attempts are limited to once every five minutes, including the manual refresh button. Outages preserve the last successful rank and expose its timestamp; successful unranked responses clear the previous rank. Hero/rank catalogs are cached for 24 hours, with bundled snapshots as an outage fallback. No manual rank overrides are accepted.

## Behavior and implementation

- Profile fields: name (2–40 characters), country, 1–12 spoken languages, one or more playstyles, up to 12 heroes and an optional 600-character bio.
- Playstyles are player preferences: Carry, Support, Tank, Initiator and Flex. A Flex selection is not an implicit wildcard for every other filter.
- Discovery excludes self, unfinished/paused profiles, blocks in either direction, sent likes and passes. Filters are one-way and optional.
- Shared-language players precede others. Each group is ordered by absolute division distance, then stable user ID. Unknown ranks come last in their language group and are excluded by explicit rank ranges. For unranked viewers, known ranks use stable ID ordering instead of distance.
- Rank filters store a zero-based consecutive division index, `(tier - 1) * 6 + division - 1`; encoded badge values are never used as distance.
- The API returns up to 30 cards per batch. The deck replenishes after those cards are actioned. **Review passed players** resets passes only.
- Received likes remain visible when notifications are disabled or delivery fails. Discord/Steam contact details are available to the person who received the like; ordinary discovery responses exclude them.
- Blocking hides both players from one another and cancels pending notifications between them. Unblocking does not replay cancelled notifications. Disconnecting Discord cancels pending jobs and leaves profile visibility unchanged; verifying Discord enables notifications without changing visibility.

### Persistence and delivery

Versioned SQL migrations live in `migrations/` and are applied under an immediate SQLite transaction. The application and worker use the same file with foreign keys, WAL and a five-second busy timeout. `bun run db:migrate` can be run explicitly; first connection also applies outstanding migrations.

A like and its unique outbox job are written in one transaction. The database enforces one like per sender/recipient. The worker leases jobs for two minutes, reclaims expired leases, respects Discord `Retry-After`, and retries transient failures up to five attempts. Permanent failures mark the connection as needing repair. The worker rechecks membership, consent and blocking before sending. Already failed/cancelled messages are not replayed after reconnection; they remain in received likes.

Delivery uses a stable Discord nonce with `enforce_nonce` to suppress recent retries. This is **at-least-once delivery**, not an unlimited exactly-once guarantee: Discord’s nonce deduplication window is finite, so a long outage after Discord accepted a message but before the local acknowledgement can result in a duplicate. Disconnecting or opting out cancels queued work but cannot retract a request already in flight.

Run one worker. The initial discovery implementation filters/sorts eligible records in memory and is intended for a single-server MVP; large communities should move ranking/pagination into SQL before scaling.

### HTTP surface

All mutation endpoints use POST JSON and require a session plus an exact `Origin` matching `APP_URL`. Bodies are limited to 16 KiB. Responses containing account data are `no-store`. Authentication cookies are HTTP-only, SameSite=Lax and Secure when `APP_URL` uses HTTPS. Session tokens are hashed at rest, expire after 30 days and are rotated on login. Authentication states and Steam nonces are one-use and expire.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/auth/steam`, `/api/auth/steam/callback` | Steam login and verification |
| `GET /api/auth/discord`, `/api/auth/discord/callback` | Link Discord to the current session’s account |
| `GET /api/me`, `/api/discovery`, `/api/likes`, `/api/players/:id` | Account, deck, incoming likes, gated profile/contact details |
| `GET /api/catalog?locale=en`, `/api/health` | Game assets and database health |
| `POST /api/profile`, `/api/filters`, `/api/settings` | Save profile, search preferences or account settings |
| `POST /api/like`, `/api/pass` | `{ "target": "player-id" }` |
| `POST /api/block` | `{ "target": "player-id", "remove": false }` |
| `POST /api/passes/reset`, `/api/rank/refresh`, `/api/logout` | Reset passes, refresh rank or sign out |
| `POST /api/discord/test`, `/api/discord/disconnect` | Verify delivery or unlink |

Limits: 30 new likes/hour per sender, three test DMs/10 minutes and ten Discord-link starts/10 minutes. Retrying an existing like is idempotent and does not consume another like allowance.

## Single-server Docker deployment

`.github/workflows/deploy.yml` builds and deploys pushes to `main`, with manual runs available from Actions. It uses the existing Linux x64 self-hosted runner for `cutekitek/lockinder`; its `github-runner` user needs access to Docker. No registry, SSH deployment key, or host Bun installation is required.

After adding the runner user to the Docker group, restart `actions.runner.cutekitek-lockinder.minipc.service` so the running process picks up its supplementary groups. Account membership alone does not update an already running service.

The Dockerfile pins Bun 1.4.0, installs from `bun.lock`, and runs lint, backend tests and the production build before deployment. Both final images run Bun as a non-root user. Node.js is only needed locally for Playwright's test runner; the app it tests runs on Bun.

The worker sends outbound HTTP/HTTPS requests through the home server's proxy on port 5050. Compose maps `host.docker.internal` to the Docker host gateway because `127.0.0.1` inside the worker refers to the container itself. The proxy must accept connections on the host gateway interface (the current listener binds `0.0.0.0:5050`). Loopback requests bypass the proxy.

Compose matches the server's existing Traefik configuration: host networking, Docker provider, `http` and `https` entrypoints, and the `letsencrypt` certificate resolver. Container labels route `lockinder.win` to web port 3000 and redirect HTTP to HTTPS. The app publishes no host ports; host-networked Traefik can reach the Compose bridge directly. `APP_URL` is fixed to `https://lockinder.win` for both services.

The domain points to the Alpine VPS at `103.141.13.141`. Rathole forwards TCP ports 80/443 from that VPS to home Traefik; no inbound home port forwarding is needed. Traefik's Cloudflare DNS challenge credentials must cover the `lockinder.win` zone. Set the Discord redirect URL to `https://lockinder.win/api/auth/discord/callback`.

Optional integration credentials can be supplied as a multiline GitHub Actions secret named `LOCKINDER_ENV`, using `.env.example` as the template. The workflow saves it to `/home/github-runner/.config/lockinder/production.env` with private permissions, outside the checkout and Docker build context. Alternatively, manage that file on the server. Without a secret or existing file, the first run creates a configuration with integrations disabled; Steam OpenID still works. Subsequent runs preserve the file unless the secret is supplied.

Deployments are serialized. Images are tagged with the commit SHA. The deployment script makes a consistent database backup through the running worker, stops both old processes before migrations, and waits for web health and worker startup. Backups remain in `/data/backup-*.db`; copy them off-host and manage retention. A failed build leaves the current deployment running. A startup failure fails the workflow; inspect `docker compose logs web worker` before recovery. There is no automatic schema rollback.

For manual deployment from a checkout on the server:

```sh
export LOCKINDER_ENV_FILE=/home/github-runner/.config/lockinder/production.env
export IMAGE_TAG=<commit-sha>
docker compose build
bash scripts/deploy.sh
```

Run these commands as the runner user, or use your own private environment file. Both services share the stable `lockinder_lockinder-data` volume at `/data`. Keep a single web service and worker on this host, and never remove the volume during upgrades. After checkout cleanup, the containers keep running; maintenance commands require the Compose file and the deployed `IMAGE_TAG`.

### Rathole tunnel

Public traffic follows `lockinder.win:80/443 → VPS Rathole → encrypted tunnel → home Rathole → Traefik → web:3000`. HTTPS terminates at Traefik. Only TCP is forwarded; the VPS's existing UDP 443 service is unaffected.

- VPS: `/usr/bin/rathole --server /etc/rathole/config.toml`, managed by OpenRC (`rc-service rathole status/restart`), enabled at boot. Logs: `/var/log/rathole.log`. The previous configuration and service script are backed up in `/etc/rathole/`.
- Home: `/home/ferret/containers/lockinder-tunnel/compose.yaml`, managed by Docker with `restart: unless-stopped`. Run `docker compose logs --tail 50` or `docker compose restart` from that directory.
- Both ends use the VPS's existing musl Rathole 0.6.0-beta.1 binary, SHA-256 `142589f677e6a4f849530ef48f569c4be6711abaa05bcd50c20ae0e0dfdd23fe`. Upgrade both together. The home container uses Alpine 3.24 to run that binary.
- The control connection uses TCP 5454, a random shared token and Noise encryption with a pinned server public key. Actual configs stay private on the servers. `deploy/rathole/` contains credential-free templates and service definitions only.

Keep TCP 80, 443 and 5454 reachable on the VPS. The home client uses the VPS IP directly, so changing the website's DNS proxy setting does not break the control connection. Tunnel restarts do not modify application containers or data.

### Backup and restore

`bun run db:backup ./backup.db` creates a consistent snapshot with SQLite's `VACUUM INTO`, including committed WAL changes. The destination must not exist.

For Docker:

```sh
docker compose exec worker bun run db:backup /data/backup.db
docker compose cp worker:/data/backup.db ./backup.db
```

Keep dated copies off the server. For restoration, first stop **both** web and worker processes. Replace `lockinder.db` with the snapshot and remove the old `lockinder.db-wal` and `lockinder.db-shm` sidecars. For Docker, the concrete sequence is:

```sh
docker compose stop web worker
docker compose run --rm --no-deps worker bun -e "const fs=require('node:fs'); for(const p of ['/data/lockinder.db-wal','/data/lockinder.db-shm']) fs.rmSync(p,{force:true})"
docker compose cp ./backup.db worker:/data/lockinder.db
docker compose run --rm --no-deps --user root worker bun -e "require('node:fs').chownSync('/data/lockinder.db',1000,1000)"
docker compose start web worker
```

Check `/api/health` and log in after restoration. Restore only backups from this application; migrations are forward-only, so retain a pre-upgrade snapshot before applying a new version.

## Validation

```sh
bun run typecheck
bun run lint
bun run test
bun run build
node node_modules/@playwright/test/cli.js install chromium
bun run test:e2e
```

Backend tests use an isolated temporary database and mocked provider responses. They cover discovery, rank boundaries, authorization, CSRF, forged/replayed callbacks, duplicate Discord links, overlapping likes, transactional rollback, provider failures, worker leases and persistence. Browser tests run a separate app on port 3100 with a **disposable** `data/e2e.db`, seed controlled accounts directly into that test database and cover both locales, mobile layout, onboarding, filters, pass/reset, likes and contacts. Screenshots and failure traces go into `test-results/`. Never point normal development or production at `data/e2e.db`.

Provider integrations are mocked in automated tests. Before launch, use two accounts you control to finish onboarding, send one like, confirm its real bot DM and contact link, then disable DMs and confirm that the like persists with a repair prompt.
