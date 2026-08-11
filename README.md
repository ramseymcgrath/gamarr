# Gamarr

Gamarr is a LAN-hosted game catalog and manual download manager. It searches
IGDB by platform, searches every enabled indexer in Prowlarr for a selected
game, explains match evidence, routes usenet releases to SABnzbd and torrents
to qBittorrent, and retains a library of game/platform records and download
attempts.

Gamarr does not monitor wanted games or choose downloads automatically. Use it
only for content you are authorized to download.

## Run with Docker Compose

Requirements:

- Docker Engine with Compose
- A free Twitch developer application for IGDB
- Prowlarr with one or more enabled indexers
- SABnzbd and/or qBittorrent for the protocols you use

Clone the repository, then edit `GAMARR_ALLOWED_ORIGINS` in
`docker-compose.yml`. Add the exact URL used by browsers on your LAN, including
the port. For example:

```yaml
GAMARR_ALLOWED_ORIGINS: >-
  http://localhost:8989,http://127.0.0.1:8989,http://192.168.1.25:8989
```

Start Gamarr:

```bash
docker compose up -d --build
```

Open `http://<docker-host>:8989/setup`.

The named `gamarr-config` volume stores `/config/gamarr.db`. SQLite contains
the configured API credentials and should be backed up and protected like any
other secret-bearing application data.

## First-run setup

1. In Twitch's developer console, create an application and copy its client ID
   and client secret into **Settings → IGDB catalog**. Select **Save and test**.
2. Select **Refresh platforms**, then enable every console you want shown in
   Discover. Gamarr supports the complete IGDB platform catalog.
3. Add the Prowlarr base URL and API key, then select **Save and test**. Gamarr
   discovers enabled indexers from Prowlarr; manage the indexer list there.
   Platform category IDs are optional and comma-separated.
4. Configure SABnzbd for usenet releases and qBittorrent for torrent releases.
   Each client's default category is optional.

The Twitch button opens the official developer portal; credentials stay on the
Gamarr server and are never returned by its settings API.

## Using Gamarr

1. Open **Discover** and choose a platform.
2. Search for a game and open its catalog record.
3. Select **Search releases**. Strong, possible, and conflicting releases all
   remain visible with the evidence Gamarr used.
4. Choose an indexer source and submit it to the matching download client.
5. Use **Library** for saved game/platform records and **Activity** for the
   chronological submission log.

If a download client may have accepted a request but the acknowledgement was
lost, Gamarr marks the attempt **Unknown** and never resubmits it automatically.
Use **Refresh status** to reconcile its durable marker, or deliberately search
again.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8989` | HTTP listen port |
| `GAMARR_DATABASE_PATH` | `/config/gamarr.db` | SQLite database |
| `GAMARR_ALLOWED_ORIGINS` | none | Comma-separated exact browser origins allowed to mutate state |
| `GAMARR_API_TOKEN` | none | Optional bearer token for trusted automation |
| `GAMARR_TRUST_PROXY` | `false` | Honor forwarded host/protocol only behind a trusted reverse proxy |
| `GAMARR_PROWLARR_MAX_TORRENT_BYTES` | `8388608` (8 MiB) | Ceiling for a `.torrent` metainfo fetch |
| `GAMARR_PROWLARR_BASE_URL` | none | Test-only override of the configured Prowlarr origin |

Gamarr intentionally has no user login in this LAN-oriented release. Do not
publish it directly to the internet. When using a reverse proxy, terminate
authentication there, set an exact HTTPS origin, and enable
`GAMARR_TRUST_PROXY=true` only when untrusted clients cannot set forwarded
headers.

## Local development

Gamarr requires Node.js 24 and pnpm.

```bash
corepack enable
pnpm install
GAMARR_DATABASE_PATH=./data/gamarr.db pnpm db:migrate
GAMARR_DATABASE_PATH=./data/gamarr.db \
GAMARR_ALLOWED_ORIGINS=http://localhost:3000 \
pnpm dev
```

Verification:

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```
