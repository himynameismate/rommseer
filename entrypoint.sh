#!/bin/sh
set -e

# Fix ownership of the data directory in case the volume was previously
# created by a root-owned container (pre-security-audit). This must run
# as root before we drop privileges.
chown -R nextjs:nodejs /app/data 2>/dev/null || true

SECRET_FILE="/app/data/.nextauth-secret"

# Auto-generate NEXTAUTH_SECRET if not provided or set to the old default placeholder
if [ -z "$NEXTAUTH_SECRET" ] || [ "$NEXTAUTH_SECRET" = "change-me-to-a-random-secret" ]; then

  # Try to load from the persistent secret file (if readable)
  if [ -f "$SECRET_FILE" ] && [ -r "$SECRET_FILE" ]; then
    LOADED=$(cat "$SECRET_FILE" 2>/dev/null || true)
    if [ -n "$LOADED" ]; then
      export NEXTAUTH_SECRET="$LOADED"
      echo "[Entrypoint] Loaded NEXTAUTH_SECRET from $SECRET_FILE"
    else
      echo "[Entrypoint] WARNING: $SECRET_FILE exists but is empty — regenerating secret."
    fi
  elif [ -f "$SECRET_FILE" ]; then
    echo "[Entrypoint] WARNING: $SECRET_FILE exists but is not readable (permission issue from old root-owned volume?)."
    echo "[Entrypoint] Generating a new NEXTAUTH_SECRET for this session."
  fi

  # Generate a fresh secret if we still don't have one
  if [ -z "$NEXTAUTH_SECRET" ]; then
    export NEXTAUTH_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")

    # Try to persist it — may fail if the data dir is root-owned (pre-security-audit volume)
    if echo "$NEXTAUTH_SECRET" > "$SECRET_FILE" 2>/dev/null; then
      chmod 600 "$SECRET_FILE" 2>/dev/null || true
      echo "[Entrypoint] Generated new NEXTAUTH_SECRET and saved to $SECRET_FILE"
    else
      echo "[Entrypoint] WARNING: Could not save NEXTAUTH_SECRET to $SECRET_FILE (permission denied)."
      echo "[Entrypoint]   Sessions will not persist across restarts."
      echo "[Entrypoint]   Fix: set NEXTAUTH_SECRET explicitly in your docker-compose.yml, or fix volume ownership:"
      echo "[Entrypoint]     docker run --rm -v rommseer_data:/data alpine chown -R 1001:1001 /data"
    fi
  fi
fi

# Abort if we still have no secret — nothing will work without it
if [ -z "$NEXTAUTH_SECRET" ]; then
  echo "[Entrypoint] FATAL: NEXTAUTH_SECRET is empty. Please set it explicitly in docker-compose.yml:"
  echo "[Entrypoint]   environment:"
  echo "[Entrypoint]     - NEXTAUTH_SECRET=<random-64-char-string>"
  exit 1
fi

# Run Prisma and seed as nextjs so all created files are properly owned
echo "[Entrypoint] Running Prisma db push..."
gosu nextjs node node_modules/prisma/build/index.js db push --skip-generate

echo "[Entrypoint] Running seed..."
gosu nextjs node prisma/seed.js

# Drop privileges and start the application as nextjs (UID 1001)
echo "[Entrypoint] Starting server..."
exec gosu nextjs node server.js
