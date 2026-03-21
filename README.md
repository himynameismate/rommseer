# Rommseer

A self-hosted ROM request management tool — like [Seerr](https://github.com/seerr-app/seerr) but for game ROMs. Integrates with [RomM](https://github.com/rommapp/romm), [Prowlarr](https://github.com/Prowlarr/Prowlarr), and [qBittorrent](https://github.com/qbittorrent/qBittorrent) to provide a complete request-to-download pipeline.

![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker)
![License](https://img.shields.io/badge/License-MIT-green)

## How It Works

1. **Users discover games** via IGDB and submit requests
2. **Admins approve** requests — Prowlarr auto-searches indexers for the best torrent
3. **qBittorrent downloads** the ROM automatically
4. **RomM syncs** the new ROM into your library

One click from the admin. Fully automated.

## Features

- **Game Discovery** — Search IGDB's database of 200k+ games with cover art, ratings, and platform info
- **Request System** — Users request games, admins approve/decline with a full status workflow (Pending → Approved → Downloading → Available)
- **Prowlarr Integration** — Auto-searches all your configured indexers when a request is approved
  - Configurable search templates (`{game_name} {platform} ROM`)
  - Minimum seeders and max size filters
  - Preferred indexers prioritization
  - Manual search fallback with result browsing
- **qBittorrent Integration** — Sends torrents directly to qBittorrent with custom categories, tags, and save paths
- **RomM Integration** — Connects to your RomM instance to check library status
- **Manual Override** — Paste magnet links directly if auto-grab doesn't find what you need
- **Role-Based Access** — Admin and user roles with separate permissions
- **Docker Ready** — Single container deployment, perfect for Unraid/NAS setups

## Quick Start

### Docker Compose (recommended)

```yaml
services:
  rommseer:
    build: .
    container_name: rommseer
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=file:/app/data/rommseer.db
      - NEXTAUTH_URL=http://localhost:3000
      - NEXTAUTH_SECRET=your-random-secret-here
    volumes:
      - rommseer_data:/app/data
    restart: unless-stopped

volumes:
  rommseer_data:
```

```bash
# Generate a secret
openssl rand -hex 32

# Start
docker compose up -d --build
```

Access at `http://localhost:3000`

### Local Development

```bash
# Install dependencies
npm install

# Copy env and set NEXTAUTH_SECRET
cp .env.example .env

# Push database schema & seed admin user
npx prisma db push
npm run db:seed

# Start dev server
npm run dev
```

**Default admin login:**
- Email: `admin@rommseer.local`
- Password: `admin`

## Configuration

All configuration is done through the **Settings** page in the admin UI:

| Service | What You Need |
|---------|--------------|
| **RomM** | URL, username, password |
| **IGDB** | Twitch Client ID & Secret ([get yours](https://dev.twitch.tv/console)) |
| **Prowlarr** | URL, API key (Settings → General → API Key) |
| **qBittorrent** | URL, username, password |

### Prowlarr Auto-Grab Settings

| Setting | Description | Default |
|---------|------------|---------|
| Search Template | Query template with `{game_name}` and `{platform}` variables | `{game_name} {platform} ROM` |
| Min Seeders | Skip results below this seeder count | `1` |
| Max Size (MB) | Skip results larger than this (0 = no limit) | `0` |
| Preferred Indexers | Comma-separated indexer names to prioritize | — |

## Unraid Deployment

1. Clone the repo to `/mnt/user/appdata/rommseer`
2. Build: `docker build -t rommseer .`
3. Add container in Unraid Docker UI:
   - **Port:** 3000 → 3000
   - **Path:** `/app/data` → `/mnt/user/appdata/rommseer/data`
   - **Variable:** `NEXTAUTH_URL` = `http://YOUR_UNRAID_IP:3000`
   - **Variable:** `NEXTAUTH_SECRET` = (random secret)
   - **Variable:** `DATABASE_URL` = `file:/app/data/rommseer.db`

## Tech Stack

- **Framework:** Next.js 15 (App Router)
- **Language:** TypeScript
- **Database:** SQLite via Prisma ORM
- **Auth:** NextAuth.js
- **UI:** Tailwind CSS + shadcn/ui
- **Containerization:** Docker

## Architecture

```
User Request → IGDB Search → Game Database
                                    ↓
Admin Approve → Prowlarr Search → Best Torrent
                                    ↓
                qBittorrent Download → RomM Library
```

## Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

## License

MIT
