# Testing zec-null-402

No mocked clients, no stub RPCs. Chain-touching tests read Zcash testnet through a real lightwalletd.
Proofs are real Groth16 proofs with this repo's setup.

| Package | Runs against | Tests | What |
|---|---|---|---|
| scan (Rust) | local | 3 + doc | payment rules (from zpay-verify); the crate doc example compiles |
| circuits | local | 5 | real proofs; tampered payTo/amount/context fail; no witness above the value or outside the tree; deposit commitments bind every note and value; context per nonce |
| gateway | HTTP + testnet | 6 | altered values not credited; the real deposit credits 22 notes once, root = published; a foreign deposit refused; a real proof pays and its replay is refused; tampered nullifier, unknown root, another request, unknown nonce refused; the run's anchor memo is on-chain and equals the recomputed root and nullifier set |
| sdk | HTTP + testnet | 3 | plan (amount, memo, 0600 notes file); two calls paid with proofs, then no note left; a dearer endpoint needs its own note |
| mcp | stdio MCP client + HTTP + testnet | 4 | tools; claim the real deposit and refuse a second claim; pay; status never shows a secret; deposit without a wallet → Setup required |
| **Total** | | **21 + doc** | 0 skipped |

Live run: `Z402_FUNDER_WALLET=… pnpm --filter @z402/examples run-live` (README table).
