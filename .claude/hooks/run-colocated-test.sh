#!/bin/sh
# PostToolUse(Edit|Write) — run the colocated vitest file for the source file
# just written, if one exists.
#
# This repo colocates tests strictly: src/features/downloads/service.ts is
# covered by src/features/downloads/service.test.ts. A single-file vitest run
# costs about 1s, which makes it the cheapest high-signal check available here —
# type errors and behavioural regressions both surface immediately instead of at
# the next `pnpm test`.
#
# Files with no colocated test are skipped silently, so this never blocks work
# on untested modules. Playwright specs under tests/e2e are excluded because
# vitest does not run them.
set -u

payload=$(cat)
file_path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')

case "$file_path" in
  *.ts | *.tsx) ;;
  *) exit 0 ;;
esac

case "$file_path" in
  */tests/e2e/*) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

case "$file_path" in
  *.test.ts | *.test.tsx) target="$file_path" ;;
  *.tsx) target="${file_path%.tsx}.test.tsx" ;;
  *) target="${file_path%.ts}.test.ts" ;;
esac

[ -f "$target" ] || exit 0

if output=$(pnpm exec vitest run "$target" 2>&1); then
  exit 0
fi

echo "Colocated test failed: $target" >&2
printf '%s\n' "$output" | tail -40 >&2
exit 2
