#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  opt_runtime="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
  if [ -x "$opt_runtime/node" ]; then
    PATH="$opt_runtime:$PATH"
    export PATH
  else
    echo 'Please install Node.js 22 or newer.' >&2
    exit 1
  fi
fi
case "${1:-check}" in
  check) exec node scripts/check.mjs ;;
  build) exec node scripts/build.mjs ;;
  test) exec node node_modules/vitest/vitest.mjs run ;;
  dev) exec node scripts/dev-server.mjs ;;
  *) echo 'Usage: ./dev.sh [check|build|test|dev]' >&2; exit 1 ;;
esac
