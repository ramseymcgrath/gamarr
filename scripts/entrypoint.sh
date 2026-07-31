#!/bin/sh
set -eu

node /app/scripts/migrate.mjs
exec "$@"
