# Rommseer

A self-hosted ROM request management tool — like [Seerr](https://github.com/seerr-app/seerr) but for game ROMs. Integrates with [RomM](https://github.com/rommapp/romm), [Prowlarr](https://github.com/Prowlarr/Prowlarr), [qBittorrent](https://github.com/qbittorrent/qBittorrent), and [SABnzbd](https://sabnzbd.org/) to provide a complete request-to-download pipeline.

![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker)
![License](https://img.shields.io/badge/License-MIT-green)

## How It Works

1. **Users discover games** via IGDB and submit requests
2. **Admins approve** requests (or auto-approve) — Prowlarr auto-searches indexers
3. **Download client grabs** the ROM (qBittorrent for torrents, SABnzbd for usenet)
4. **Rommseer copies** the completed ROM into your RomM library directory
5. **RomM scans** and imports the new ROM automatically

Zero clicks with auto-approve. Fully automated end-to-end.

## Features

- **Game Discovery** — Search IGDB's database of 200k+ games with cover art, ratings, and platform info
- **Request System** — Users request games, admins approve/decline with a full status workflow (Pending → Approved → Downloading → Available)
- **Prowlarr Integration** — Auto-searches all your configured indexers when a request is approved
  - Configurable search templates (`{game_name} {platform} ROM`)
  - Minimum seeders and max size filters
  - Preferred indexers prioritization
  - Title relevance filtering (blocks unrelated results like ebooks, music)
  - Platform-aware ROM extension filtering (e.g. GBA requests only grab `.gba` files)
  - Manual search fallback with result browsing
- **qBittorrent Integration** — Sends torrents directly to qBittorrent with custom categories, tags, and save paths
- **SABnzbd Integration** — Sends NZBs to SABnzbd for usenet downloads with category support
- **RomM Integration** — Full lifecycle integration:
  - Copies completed ROMs to your RomM library directory (platform-aware folder structure)
  - Triggers a library scan via Socket.IO after copying
  - Connects to check library status
- **Auto-Retry** — If a download fails, automatically tries the next best result (up to 3 attempts)
- **Auto-Approve** — Optionally skip admin approval for new requests
- **Manual Override** — Paste magnet links directly if auto-grab doesn't find what you need
- **Multi-Platform Support** — Platform picker for games available on multiple platforms
- **Role-Based Access** — Admin and user roles with separate permissions
- **Docker Ready** — Single container deployment, perfect for Unraid/NAS setups

## Quick Start

### Docker Compose (recommended)

```yaml
services:
  rommseer:
    image: ghcr.io/himynameismate/rommseer:latest
    container_name: rommseer
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=file:/app/data/rommseer.db
      - NEXTAUTH_URL=http://YOUR_SERVER_IP:3000
      - NEXTAUTH_SECRET=your-random-secret-here
    volumes:
      - rommseer_data:/app/data
      # Mount the RomM library so Rommseer can copy completed ROMs into it.
      # This must point to the same directory RomM uses as its library root.
      # Then set "Library Path" in Settings → RomM to /romm/library
      - /path/to/romm/library:/romm/library
      # Mount the download client's completed-downloads folder so Rommseer
      # can read finished files. Adjust to match your SABnzbd/qBittorrent config.
      - /path/to/downloads:/downloads
    restart: unless-stopped

volumes:
  rommseer_data:
```

> **Important: Volume mounts are required** for the post-download copy feature.
>
> | Mount | Purpose | Example (Unraid) |
> |-------|---------|-----------------|
> | `/romm/library` | RomM library root — Rommseer copies ROMs here | `/mnt/user/data/romm/library` |
> | `/downloads` | Download client's completed folder | `/mnt/cache/Downloads/Complete` |
>
> After starting, go to **Settings → RomM** and set **Library Path** to `/romm/library`.

```bash
# Generate a secret
openssl rand -hex 32

# Start
docker compose up -d
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
| **RomM** | URL, username, password, library path (container mount point) |
| **IGDB** | Twitch Client ID & Secret ([get yours](https://dev.twitch.tv/console)) |
| **Prowlarr** | URL, API key (Settings → General → API Key) |
| **qBittorrent** | URL, username, password |
| **SABnzbd** | URL, API key (Config → General → API Key) |

### Prowlarr Auto-Grab Settings

| Setting | Description | Default |
|---------|------------|---------|
| Search Template | Query template with `{game_name}` and `{platform}` variables | `{game_name} {platform} ROM` |
| Min Seeders | Skip results below this seeder count | `1` |
| Max Size (MB) | Skip results larger than this (0 = no limit) | `0` |
| Preferred Indexers | Comma-separated indexer names to prioritize | — |

## Unraid Deployment

1. Create a `docker-compose.yml` anywhere on your server (e.g. `/mnt/user/appdata/rommseer/docker-compose.yml`):

```yaml
services:
  rommseer:
    image: ghcr.io/himynameismate/rommseer:latest
    container_name: rommseer
    ports:
      - "3001:3000"
    environment:
      - DATABASE_URL=file:/app/data/rommseer.db
      - NEXTAUTH_URL=http://YOUR_UNRAID_IP:3001
      - NEXTAUTH_SECRET=generate-a-random-secret
    volumes:
      - /mnt/cache/Container/rommseer:/app/data
      - /mnt/data/romm/library:/romm/library
      - /mnt/cache/Downloads/Complete:/downloads
    restart: unless-stopped
```

2. Adjust the volume paths to match your setup:
   - `/mnt/data/romm/library` → must be the **same directory** your RomM container uses as its library root
   - `/mnt/cache/Downloads/Complete` → must be where SABnzbd/qBittorrent saves completed downloads
3. Start: `docker compose up -d`
4. Open `http://YOUR_UNRAID_IP:3001` and log in with `admin@rommseer.local` / `admin`
5. Go to **Settings → RomM** and set **Library Path** to `/romm/library`

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
Admin Approve (or Auto) → Prowlarr Search → Best Result
                                                ↓
                              qBittorrent / SABnzbd Download
                                                ↓
                              Copy ROM to Library → RomM Scan → Available
```

## Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

## License

MIT
