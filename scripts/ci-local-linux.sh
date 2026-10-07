#!/usr/bin/env bash
# Supports: SPEC-BLD-007 (continuous integration), decision D-22 (verification 5a on this workstation)
# Linux job of the continuous integration, run locally (WSL) when no remote runner is available. Bun need not be
# installed: the linux-x64 executable cross-compiled by `bun scripts/build.ts --all` acts as the Bun runtime when
# BUN_BE_BUN=1. The repository is cloned into a Linux folder; packages come from the frozen lockfile.
# Limit: an executable compiled by this substitute runtime is not valid, so the native build step is replaced by the
# start-up check of the cross-compiled executables.
# Usage (from Windows): wsl -d <distribution> -- bash <repository in /mnt>/scripts/ci-local-linux.sh
set -u
exec 2>&1
SRC=$(cd "$(dirname "$0")/.." && pwd)
WORK=/tmp/ci-local
rm -rf "$WORK" && mkdir -p "$WORK/bin"
run() { local s=$(date +%s); echo "### $*"; "$@"; local c=$?; echo "### exit=$c ($(( $(date +%s)-s )) s)"; return $c; }

echo "== start-up of the cross-compiled executables"
for f in "$SRC"/dist/*-linux-*; do
  name=$(basename "$f")
  cp "$f" "$WORK/bin/" && chmod +x "$WORK/bin/$name"
  "$WORK/bin/$name" --version 2>&1 | head -n 1; code=${PIPESTATUS[0]}
  echo "$name exit=$code"
done
cp "$SRC/dist/$(ls "$SRC/dist" | grep -- '-linux-x64$')" "$WORK/bin/bun" || exit 1
ln -sf "$WORK/bin/bun" "$WORK/bin/bunx"
export BUN_BE_BUN=1 PATH="$WORK/bin:$PATH"
echo "== runtime: Bun $(bun --version)"

git clone -q "$SRC" "$WORK/repo" && cd "$WORK/repo" || exit 1
run bun install --frozen-lockfile &&
  run bun scripts/generate.ts &&
  run bun node_modules/typescript/bin/tsc --noEmit -p . &&
  run bun scripts/check-static.ts &&
  run bun test &&
  run bun scripts/trace.ts
echo "== tools: rg=$(command -v rg || echo absent) pwsh=$(command -v pwsh || echo absent) sh=$(command -v sh)"
