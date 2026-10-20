# @z402/mcp — `z402-mcp`

Tools: `status` (read-only), `deposit` (plans N notes and sends one shielded deposit from the agent's
wallet; capped by `Z402_MAX_DEPOSIT_ZAT`), `claim`, `pay`. Env: `Z402_GATEWAY_URL`,
`Z402_NOTES_FILE`, `Z402_WALLET`, `Z402_MCP_LOG`.

Tests (`pnpm test`, 4): against a fresh gateway that credits the real published deposit (testnet viewing-key check), with real proofs.
