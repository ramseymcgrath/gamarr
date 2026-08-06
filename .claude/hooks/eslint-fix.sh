#!/bin/sh
# PostToolUse(Edit|Write) — lint the file just written.
#
# Note on --max-warnings 0: this repo's ESLint config (next/core-web-vitals +
# next/typescript) carries 112 rules but *no* formatting rules — there is no
# Prettier and no semi/quotes/indent enforcement, so `--fix` has essentially
# nothing to rewrite. The rules that do fire here, notably
# @typescript-eslint/no-unused-vars, are warnings, so a plain `eslint` run exits
# 0 and this hook would be a no-op. Treating warnings as failures is what makes
# it catch real things (dead imports, unused bindings) as they are introduced.
#
# This is deliberately stricter than CI, which runs plain `pnpm lint` and
# tolerates warnings. Drop `--max-warnings 0` to match CI exactly.
#
# Costs roughly 2s per edit. To disable, remove this hook's block from
# .claude/settings.json.
set -u

payload=$(cat)
file_path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')

case "$file_path" in
  *.ts | *.tsx | *.mts | *.cts | *.mjs) ;;
  *) exit 0 ;;
esac

[ -f "$file_path" ] || exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

if output=$(pnpm exec eslint --fix --max-warnings 0 "$file_path" 2>&1); then
  exit 0
fi

echo "ESLint problems in $file_path:" >&2
printf '%s\n' "$output" >&2
exit 2
