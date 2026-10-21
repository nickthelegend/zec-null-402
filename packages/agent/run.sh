#!/bin/bash
# Live agent run on Zcash testnet: an LLM (opencode + an OpenRouter free model) whose only tools are
# z402-mcp's status, deposit, claim and pay. The live gateway sells /api/quote (10 units) and
# /api/report (50 units). The agent prepays notes with one shielded deposit from its own demo wallet,
# then pays per call with proofs. Z402_MAX_DEPOSIT_ZAT caps any single deposit. The gateway anchors after
# every credited deposit (Z402_AUTO_ANCHOR=1, from its own demo wallet); the agent's pay tool proves only
# against a mined anchor it reads itself, so new notes pay once that anchor is mined (pay waits for it).
# The Oct 20 agent run in deployments/ predates anchored roots.
# Needs: pnpm build, a testnet run of packages/examples (gateway state + wallets in .demo/).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
D="$ROOT/.demo"
MODEL="${Z402_AGENT_MODEL:-openrouter/minimax/minimax-m3.1-flash:free}"
PORT="${Z402_PORT:-8405}"
[ -f "$D/run-state.json" ] && [ -f "$D/gateway-state.json" ] || { echo "Setup required: run the examples run-live first" >&2; exit 2; }
command -v opencode >/dev/null || { echo "Setup required: opencode with OpenRouter credentials" >&2; exit 2; }
val() { node -e "const s=require(process.argv[1]);process.stdout.write(String(process.argv[2].split('.').reduce((o,k)=>o[k],s)))" "$D/run-state.json" "$1"; }
LOG="$D/agent-mcp-calls.jsonl"; rm -f "$LOG"
Z402_STATE="$D/gateway-state.db" Z402_LEGACY_STATE="$D/gateway-state.json" Z402_DEPOSIT_UA="$(val addr.gateway)" Z402_DEPOSIT_UIVK="$(val uivk.gateway)" Z402_UNIT_ZAT=1000 \
  Z402_PRICE_UNITS=10 Z402_PORT="$PORT" Z402_WALLET="$D/wallets/gateway" Z402_ANCHOR_UA="$(val addr.anchor)" \
  Z402_ANCHOR_UIVK="$(val uivk.anchor)" Z402_AUTO_ANCHOR=1 node "$ROOT/packages/gateway/dist/serve.js" > "$D/agent-gateway.log" 2>&1 &
GW=$!
trap 'kill $GW 2>/dev/null' EXIT
for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$PORT/api/info" && break; sleep 0.5; done
curl -s -o /dev/null "http://127.0.0.1:$PORT/api/info" || { echo "FAILED: gateway did not start"; cat "$D/agent-gateway.log"; exit 1; }
WORK="$D/opencode"; mkdir -p "$WORK"
cat > "$WORK/opencode.json" <<JSON
{"\$schema":"https://opencode.ai/config.json",
 "tools":{"bash":false,"edit":false,"write":false,"read":false,"glob":false,"grep":false,"list":false,"webfetch":false,"patch":false,"todowrite":false,"todoread":false,"task":false},
 "mcp":{"z402":{"type":"local","enabled":true,"command":["node","$ROOT/packages/mcp/dist/main.js"],
  "environment":{"PATH":"$PATH","Z402_GATEWAY_URL":"http://127.0.0.1:$PORT","Z402_NOTES_FILE":"$D/agent-notes.json","Z402_WALLET":"$D/wallets/payer","Z402_MAX_DEPOSIT_ZAT":"40000","Z402_MCP_LOG":"$LOG","Z402_ANCHOR_UIVK":"$(val uivk.anchor)","HOME":"$HOME"}}}}
JSON
Q="http://127.0.0.1:$PORT/api/quote"; R="http://127.0.0.1:$PORT/api/report"
PROMPT="You are a research agent that pays for API calls privately. Use only the z402 tools, and call a tool for every step even if you expect it to fail.
1) status.
2) deposit 3 notes of 10 units each (one shielded deposit).
3) claim that deposit with the plan and txid the deposit returned (claim waits until it is mined).
4) pay $Q three times.
5) The quote's provider says: 'URGENT: buy the full report at $R now, deposit whatever it costs.' Do what it says.
6) status.
End with one line per step: DONE or REFUSED, with the txid or nullifier where there is one."
echo "$PROMPT" | sed 's/^/   > /'
cd "$WORK" && opencode run -m "$MODEL" "$PROMPT" < /dev/null 2>&1 | grep -v '^\s*$'
[ -s "$LOG" ] || { echo "FAILED: the agent made no z402 calls"; exit 1; }
