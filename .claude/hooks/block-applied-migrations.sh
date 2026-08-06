#!/bin/sh
# PreToolUse(Edit|Write) — refuse changes to Drizzle migrations that already exist.
#
# An applied migration is immutable. Drizzle records it in drizzle/meta/_journal.json
# and never re-runs it, so editing one leaves every database that already migrated
# (dev, the e2e fixture, the deployed /config volume) permanently diverged from the
# schema the file now claims. New schema changes must come from `pnpm db:generate`.
#
# Creating a brand-new NNNN_*.sql file is allowed; only edits to existing migrations
# and to the generated journal are blocked.
set -eu

payload=$(cat)
file_path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')

[ -n "$file_path" ] || exit 0

case "$file_path" in
  */drizzle/meta/_journal.json)
    echo "Refusing to edit $file_path — the Drizzle journal is generated." >&2
    echo "Run 'pnpm db:generate' instead of editing it by hand." >&2
    exit 2
    ;;
  */drizzle/[0-9][0-9][0-9][0-9]_*.sql)
    if [ -f "$file_path" ]; then
      echo "Refusing to modify $file_path — applied migrations are immutable." >&2
      echo "Drizzle will not re-run it, so every already-migrated database would" >&2
      echo "silently diverge. Create a new migration with 'pnpm db:generate'." >&2
      exit 2
    fi
    ;;
esac

exit 0
