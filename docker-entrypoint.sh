#!/bin/sh
set -e

# Ensure the data directory exists and is writable
mkdir -p /app/data
chown nextjs:nodejs /app/data 2>/dev/null || true

# Run Prisma db push as nextjs user to create/migrate the database
su -s /bin/sh nextjs -c 'node node_modules/prisma/build/index.js db push --skip-generate --accept-data-loss'

# Start the app as nextjs user
exec su -s /bin/sh nextjs -c 'node server.js'
