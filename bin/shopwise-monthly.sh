#!/usr/bin/env bash
# Cron entry point. Safe to fire more often than monthly — `--if-due` makes every
# extra invocation a no-op, so a missed wake-up gets picked up on the next tick.
set -euo pipefail

cd "$(dirname "$0")/.."

# Cron runs with a minimal PATH; point it at your node if this fails.
exec node src/index.js run --if-due --live >> runs/cron.log 2>&1
