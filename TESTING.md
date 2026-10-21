# Testing Kippu (zec-null-402)

No mocked clients, no stub RPCs. Chain-touching tests read Zcash testnet through a real lightwalletd.
Proofs are real Groth16 proofs with this repo's setup. Counts are from `pnpm test` on Oct 21, 2026.

| Package | Runs against | Tests | What |
|---|---|---|---|
| scan (Rust) | local | 3 + doc | payment rules (from zpay-verify); the crate doc example compiles |
| circuits | local | 5 | real proofs; tampered payTo/amount/context fail; no witness above the value or outside the tree; deposit commitments bind every note and value; context per nonce |
| gateway `gateway.test.ts` | HTTP + testnet | 6 | altered values not credited; the real deposit credits 22 notes once, root = published; a foreign deposit refused; a real proof pays and its replay is refused; tampered nullifier, unknown root, another request, unknown nonce refused; the run's anchor memo is on-chain and equals the recomputed root and nullifier set |
| gateway `attacks.test.ts` | HTTP + testnet | 9 | a spent note's fresh proof with its nullifier as `0<n>`, `00<n>` or hex is refused; a re-encoded root or non-string signal is `MALFORMED_SIGNALS`; one payment sent three times at once pays once; two proofs of one note sent together pay once; two concurrent claims credit once; `POST /api/anchor` is 503 without a configured token and 401 without the right bearer (wallet never reached); `/api/info` has no viewing key; the challenge cap drops the oldest; a 70 KB body is 413 |
| sdk `client.test.ts` | HTTP + testnet | 3 | plan (amount, memo, 0600 notes file); two calls paid with proofs, then no note left; a dearer endpoint needs its own note |
| sdk `relay.test.ts` | HTTP + testnet + a real relay server | 3 | a challenge relayed from another origin is refused before proving (no nullifier burned); a challenge for another path is refused even from the configured origin; the gateway itself is still paid |
| mcp | stdio MCP client + HTTP + testnet | 4 | tools; claim the real deposit and refuse a second claim; pay; status never shows a secret; deposit without a wallet → Setup required |
| **Total** | | **33 + doc** | 0 skipped, 0 failed |

The 12 tests in `attacks.test.ts` and `relay.test.ts` were run against the code before the Oct 21
fixes and failed there (see the commit messages and `docs/JUDGE-2026-10-21.md`).

Live run: `Z402_FUNDER_WALLET=… pnpm --filter @z402/examples run-live` (README table).
