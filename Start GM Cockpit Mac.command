#!/bin/bash

set -u

APP_ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVER="$APP_ROOT/server.mjs"
PORT_WAS_SET="${PORT:+set}"
PORT="${PORT:-4173}"

if [ -z "$PORT_WAS_SET" ] && [ -f "$APP_ROOT/.env" ]; then
  CONFIGURED_PORT="$(
    sed -nE 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*([0-9]+)[[:space:]]*(#.*)?$/\1/p' \
      "$APP_ROOT/.env" | head -n 1
  )"
  if [ -n "$CONFIGURED_PORT" ]; then
    PORT="$CONFIGURED_PORT"
  fi
fi

URL="http://127.0.0.1:$PORT"

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi

  for candidate in \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node" \
    "$HOME/.volta/bin/node"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
}

NODE_BIN="$(find_node)"

if [ -z "$NODE_BIN" ]; then
  printf '\nNode.js LTS is required to run GM Campaign Cockpit.\n'
  printf 'Install it from https://nodejs.org and run this launcher again.\n\n'
  open "https://nodejs.org/en/download" >/dev/null 2>&1
  read -r -p "Press Return to close this window..."
  exit 1
fi

if ! "$NODE_BIN" -e \
  'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 12) ? 0 : 1)'; then
  printf '\nGM Campaign Cockpit requires Node.js 20.12 or newer.\n'
  printf 'Update Node.js at https://nodejs.org and run this launcher again.\n\n'
  read -r -p "Press Return to close this window..."
  exit 1
fi

if curl --silent --fail "$URL/api/readiness" | grep --quiet '"ready":true'; then
  open "$URL"
  exit 0
fi

cd "$APP_ROOT" || exit 1
"$NODE_BIN" "$SERVER" &
SERVER_PID=$!

stop_server() {
  if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1
  fi
}

trap stop_server EXIT INT TERM

for attempt in {1..30}; do
  if curl --silent --fail "$URL/api/readiness" | grep --quiet '"ready":true'; then
    open "$URL"
    printf '\nGM Campaign Cockpit is running at %s\n' "$URL"
    printf 'Keep this Terminal window open during the session.\n'
    printf 'Press Control-C when you are finished.\n\n'
    wait "$SERVER_PID"
    exit $?
  fi

  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    printf '\nThe cockpit server stopped before it became ready.\n'
    read -r -p "Press Return to close this window..."
    exit 1
  fi

  sleep 0.25
done

printf '\nThe cockpit did not become ready. Review the messages above.\n'
read -r -p "Press Return to close this window..."
exit 1
