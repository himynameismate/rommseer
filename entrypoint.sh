#!/bin/sh
set -e

SECRET_FILE="/app/data/.nextauth-secret"

# Auto-generate NEXTAUTH_SECRET if not provided or set to the old default placeholder
if [ -z "$NEXTAUTH_SECRET" ] || [ "$NEXTAUTH_SECRET" = "change-me-to-a-random-secret" ]; then
  if [ -f "$SECRET_FILE" ]; then
    export NEXTAUTH_SECRET=$(cat "$SECRET_FILE")
    echo "[Entrypoint] Loaded NEXTAUTH_SECRET from $SECRET_FILE"
  else
    export NEXTAUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
    echo "$NEXTAUTH_SECRET" > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
    echo "[Entrypoint] Generated new NEXTAUTH_SECRET and saved to $SECRET_FILE"
  fi
fi

# Run Prisma migrations
echo "[Entrypoint] Running Prisma db push..."
node node_modules/prisma/build/index.js db push --skip-generate --accept-data-loss

# Seed the database
echo "[Entrypoint] Running seed..."
node prisma/seed.js

# Start the application
echo "[Entrypoint] Starting server..."
exec node server.js
