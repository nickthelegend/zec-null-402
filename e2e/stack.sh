#!/usr/bin/env bash
# Starts the real Kippu stack for the browser E2E run, bound to 127.0.0.1:
#   8405  gateway (packages/gateway dist/serve.js): fresh SQLite state, the published demo deposit and
#         anchor viewing keys from deployments/testnet.json, no Z402_ADMIN_TOKEN (anchoring Setup required)
#   8406  gateway with a throwaway Z402_ADMIN_TOKEN made here and no wallet (anchoring needs the wallet)
#   5183  dashboard (vite dev, as in its README)
#   5184  landing (packages/landing/index.html)
# No seed, spending key or wallet is used. PIDs go to e2e/.run/pids; `stack.sh stop` kills them by PID.
set -euo pipefail
cd "$(dirname "$0")/.."
RUN=e2e/.run

if [[ "${1:-}" == "stop" ]]; then
  [[ -f $RUN/pids ]] || { echo "no $RUN/pids"; exit 0; }
  while read -r name pid; do kill "$pid" 2>/dev/null && echo "killed $name ($pid)" || echo "$name ($pid) already gone"; done < "$RUN/pids"
  rm -f "$RUN/pids"
  exit 0
fi

node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<13)) { console.error("error: the gateway needs Node >= 22.13 (node:sqlite), this is "+process.version); process.exit(1) }'
[[ -f packages/gateway/dist/serve.js ]] || { echo "error: packages/gateway/dist missing; run: pnpm --filter @z402/circuits --filter @z402/gateway --filter @z402/sdk build" >&2; exit 1; }
[[ -x packages/scan/target/release/zpay-verify ]] || { echo "error: packages/scan/target/release/zpay-verify missing; run: pnpm build:scan" >&2; exit 1; }
[[ -f $RUN/pids ]] && { echo "error: $RUN/pids exists; run e2e/stack.sh stop first" >&2; exit 1; }

rm -rf "$RUN"; mkdir -p "$RUN"; chmod 700 "$RUN"
# The demo gateway and anchor viewing keys are published in deployments/testnet.json on purpose
# (testnet, incoming only). They go into the env by name and are never printed.
pub() { node -e 'const d=require("./deployments/testnet.json"); process.stdout.write(String(process.argv[1].split(".").reduce((o,k)=>o[k],d)))' "$1"; }
export Z402_DEPOSIT_UA=$(pub wallets.gateway.address) Z402_DEPOSIT_UIVK=$(pub wallets.gateway.uivk)
export Z402_ANCHOR_UA=$(pub wallets.anchor.address) Z402_ANCHOR_UIVK=$(pub wallets.anchor.uivk)
# A throwaway operator token for the 8406 gateway only, kept in a 0600 file.
( umask 077; node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))' > "$RUN/admin-token" )

start() { # name cmd...
  local name=$1; shift
  "$@" > "$RUN/$name.log" 2>&1 &
  echo "$name $!" >> "$RUN/pids"
}

start gateway env Z402_STATE="$RUN/gateway.db" Z402_PORT=8405 node packages/gateway/dist/serve.js
start gateway-admin env Z402_STATE="$RUN/gateway-admin.db" Z402_PORT=8406 Z402_ADMIN_TOKEN="$(cat "$RUN/admin-token")" node packages/gateway/dist/serve.js
start dashboard node packages/dashboard/node_modules/vite/bin/vite.js packages/dashboard --host 127.0.0.1 --port 5183 --strictPort
start landing node e2e/serve-landing.mjs 5184

wait_http() { for _ in $(seq 1 100); do curl -fs -o /dev/null "$1" && return 0; sleep 0.3; done; echo "error: $1 never came up" >&2; return 1; }
wait_http http://127.0.0.1:8405/api/info
wait_http http://127.0.0.1:8406/api/info
wait_http http://127.0.0.1:5183/
wait_http http://127.0.0.1:5184/
cat "$RUN/pids"
