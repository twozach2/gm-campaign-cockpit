#!/bin/bash

set -u

APP_ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVER="$APP_ROOT/server.mjs"
URL="http://127.0.0.1:4173"

# Where the campaign folders live. Override by exporting VAULT_ROOT before launching.
VAULT_ROOT="${VAULT_ROOT:-$HOME/Documents/Obsidian Vault/DnD}"
export VAULT_ROOT

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
  printf '\nNode.js is required to run GM Campaign Cockpit.\n'
  printf 'Install the LTS version from https://nodejs.org and run this launcher again.\n\n'
  open "https://nodejs.org/en/download" >/dev/null 2>&1
  read -r -p "Press Return to close this window..."
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 18 ]; then
  printf '\nGM Campaign Cockpit requires Node.js 18 or newer.\n'
  printf 'Update Node.js at https://nodejs.org and run this launcher again.\n\n'
  open "https://nodejs.org/en/download" >/dev/null 2>&1
  read -r -p "Press Return to close this window..."
  exit 1
fi

if curl --silent --fail "$URL/api/health" | grep --quiet '"ok":true'; then
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

for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if curl --silent --fail "$URL/api/health" | grep --quiet '"ok":true'; then
    open "$URL"
    printf '\nGM Campaign Cockpit is running at %s\n' "$URL"
    printf 'Keep this Terminal window open during the session.\n'
    printf 'Close it or press Control-C when you are finished.\n\n'
    wait "$SERVER_PID"
    exit $?
  fi

  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    printf '\nThe cockpit server stopped before it could open.\n'
    read -r -p "Press Return to close this window..."
    exit 1
  fi

  sleep 0.25
done

printf '\nThe cockpit did not start within five seconds.\n'
read -r -p "Press Return to close this window..."
exit 1
