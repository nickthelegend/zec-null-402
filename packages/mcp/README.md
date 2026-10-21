# @z402/mcp — `z402-mcp`

Tools: `status` (read-only), `deposit` (plans N notes and sends one shielded deposit from the agent's
wallet; capped by `Z402_MAX_DEPOSIT_ZAT`), `claim`, `pay` (proves only against an anchored root it
reads on-chain; waits up to `Z402_ANCHOR_WAIT_SEC`, default 900, when the notes are newer than the
latest anchor). Env: `Z402_GATEWAY_URL`, `Z402_NOTES_FILE`, `Z402_WALLET`, `Z402_MCP_LOG`,
`Z402_ANCHOR_UIVK` (required by `pay`), `Z402_MAX_ANCHOR_AGE_BLOCKS`, `Z402_LWD_URL`.

Tests (`pnpm test`, 4): against a fresh gateway that credits the real published deposit (testnet viewing-key check) and adopts the published anchor, with real proofs; `pay` without the anchor key is Setup required.
