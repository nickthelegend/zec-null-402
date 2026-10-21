# Testing Kippu (zec-null-402)

No mocked clients, no stub RPCs. Chain-touching tests read Zcash testnet through a real lightwalletd.
Proofs are real Groth16 proofs with this repo's setup. Counts are from `pnpm test` on Oct 22, 2026.

| Package | Runs against | Tests | What |
|---|---|---|---|
| scan (Rust) | local | 3 + doc | payment rules (from zpay-verify); the crate doc example compiles |
| circuits | local | 5 | real proofs; tampered payTo/amount/context fail; no witness above the value or outside the tree; deposit commitments bind every note and value; context per nonce |
| gateway `gateway.test.ts` | HTTP + testnet | 6 | altered values not credited; the real deposit credits 22 notes once, root = published; a foreign deposit refused; a real proof pays and its replay is refused; tampered nullifier, unknown root, another request, unknown nonce refused; the run's anchor memo is on-chain and equals the recomputed root and nullifier set |
| gateway `attacks.test.ts` | HTTP + testnet | 9 | a spent note's fresh proof with its nullifier as `0<n>`, `00<n>` or hex is refused; a re-encoded root or non-string signal is `MALFORMED_SIGNALS`; one payment sent three times at once pays once; two proofs of one note sent together pay once; two concurrent claims credit once; `POST /api/anchor` is 503 without a configured token and 401 without the right bearer (wallet never reached); `/api/info` has no viewing key; the challenge cap drops the oldest; a 70 KB body is 413 |
| gateway `persistence.test.ts` | HTTP + testnet + a second real gateway process | 4 | a challenge issued before a restart is paid after it; nullifiers, deposits and the root survive a restart (spent stays spent, claimed stays claimed); one note proven twice, one proof sent to each of two gateway processes on one database at once, pays once (`NULLIFIER_SPENT` for the other); a JSON state is imported once and a JSON file given as the database is refused |
| gateway `anchor.test.ts` | lightwalletd (testnet) + HTTP | 7 | only the exact `z402:anchor:` memo parses; the published anchor reads back with the published anchor key (the deposit tx has none; a non-hex txid is refused before the scanner runs); a challenge says `anchor: null` without an anchor; the gateway adopts the published anchor only when its leaves match, and challenges then carry it; an anchor without a height is offered only after `confirmAnchors` sees it mined; Setup required without the key |
| sdk `client.test.ts` | HTTP + testnet | 3 | plan (amount, memo, 0600 notes file); two calls paid with proofs, then no note left; a dearer endpoint needs its own note |
| sdk `relay.test.ts` | HTTP + testnet + a real relay server | 3 | a challenge relayed from another origin is refused before proving (no nullifier burned); a challenge for another path is refused even from the configured origin; the gateway itself is still paid |
| sdk `anchored-root.test.ts` | lightwalletd (testnet) + HTTP + real dishonest gateway servers | 9 | an anchored root pays and the proof carries exactly the published anchored root; no anchor → `UNANCHORED_ROOT` (nothing sent, note unspent); a per-client leaf list and root offered without an anchor → `UNANCHORED_ROOT`, passed off as the published anchor → `ANCHOR_MISMATCH`; an anchored leaf rewritten → `LEAVES_NOT_ANCHORED`; a leaf added after the anchor for this client only never reaches the proof; an anchor older than the window → `ANCHOR_TOO_OLD` (the default 2,880 blocks refuses the Oct 20 anchor); history that does not extend the last accepted anchor → `ANCHOR_FORK`, an older anchor → `ANCHOR_ROLLBACK`; no key → Setup required. In every refusal the dishonest gateway receives no proof |
| mcp | stdio MCP client + HTTP + testnet | 4 | tools; claim the real deposit and refuse a second claim; pay against the anchored root (and Setup required without the anchor key); status never shows a secret; deposit without a wallet → Setup required |
| **Total** | | **53 + doc** | 0 skipped, 0 failed |

The 12 tests in `attacks.test.ts` and `relay.test.ts` were run against the code before the Oct 21
fixes and failed there (see the commit messages and `docs/JUDGE-2026-10-21.md`).

Oct 22 (pass 2), run against `a8aa033`: all 9 `anchored-root.test.ts` tests fail there (the old client
proved against whatever root it was handed, including the dishonest gateway's per-client root); in
`persistence.test.ts` the restart, two-process (`[200, 200]`: both processes paid the same note) and
import tests fail, while the nullifier-after-restart test passed there too, because the JSON file
already kept nullifiers. The anchor tests use the Oct 20 anchor with a window of its age + 10 blocks,
computed at test time.

Live run: `Z402_FUNDER_WALLET=… pnpm --filter @z402/examples run-live` (README table).
