# Testing Kippu (zec-null-402)

No mocked clients, no stub RPCs. Chain-touching tests read Zcash testnet through a real lightwalletd.
Proofs are real Groth16 proofs with this repo's setup. Where a test needs the gateway to send an anchor,
`sendAnchor` is a callback that records the memo it is asked to send (no transaction leaves the test);
everything else in that gateway is real. `anchor-window.test.ts` is local (anchors built and signed in the test) and
`tip.test.ts` runs small shell scripts in place of the scan binary. Counts are from `pnpm test` on Oct 23, 2026 (second ultra round).
CI (`.github/workflows/ci.yml`) runs the same `pnpm test` on every push.

| Package | Runs against | Tests | What |
|---|---|---|---|
| scan (Rust) | local | 3 + doc | payment rules (from zpay-verify); the crate doc example compiles. `scan-range` is exercised through the gateway's `anchor.test.ts` |
| circuits | local | 6 | real proofs; tampered payTo/amount/context fail; no witness above the value or outside the tree; deposit commitments bind every note and value; context per nonce; the verification key is parsed once and stays usable |
| gateway `gateway.test.ts` | HTTP + testnet | 6 | altered values not credited; the real deposit credits 22 notes once, root = published; a foreign deposit refused; a real proof pays and its replay is refused; tampered nullifier, unknown root, another request, unknown nonce refused; the run's anchor memo is on-chain and equals the recomputed root and nullifier set |
| gateway `attacks.test.ts` | HTTP + testnet | 10 | a spent note's fresh proof with its nullifier as `0<n>`, `00<n>` or hex is refused; a re-encoded root or non-string signal is `MALFORMED_SIGNALS`; one payment sent three times at once pays once; two proofs of one note sent together pay once; two concurrent claims credit once; `POST /api/anchor` is 503 without a configured token and 401 without the right bearer (wallet never reached); `/api/info` has no viewing key; 10,000 bare GETs store nothing and the honest challenge still pays (its nonce cannot be answered again, even with another note); a forged, re-dated or moved nonce is `UNKNOWN_CHALLENGE`; formerly: the challenge cap drops the oldest; a 70 KB body is 413 |
| gateway `persistence.test.ts` | HTTP + testnet + a second real gateway process | 4 | a challenge issued before a restart is paid after it; nullifiers, deposits and the root survive a restart; one note proven twice, one proof sent to each of two gateway processes on one database at once, pays once; a JSON state is imported once and a JSON file given as the database is refused |
| gateway `anchor.test.ts` | lightwalletd (testnet) + HTTP | 10 | only the exact `z402:anchor:` memo parses; a signed memo verifies only with the signer's key and no field can change (the Oct 20 anchor is unsigned); a gateway with a signing key signs every anchor and publishes the public key, never the seed; the published anchor reads back with the published anchor key, and `scanAnchors` finds it by a compact-block scan of a block range (nothing in the blocks before it); `anchor: null` without an anchor; adopt only when the leaves match; confirm an unmined anchor; Setup required without the key |
| gateway `anchoring.test.ts` | lightwalletd (testnet) + HTTP state, a recording `sendAnchor` | 6 | three `anchor()` calls at once never send two at once (at most one follow-up); a sent anchor that cannot be recorded is reported with its txid; a gateway holding the Oct 20 end state re-anchors within one check because its anchor is older than `Z402_ANCHOR_EVERY_BLOCKS` (real tip), with the same state, and sends nothing more while that anchor is pending; nothing is sent when the anchor is fresh; a failed auto-anchor after a claim is retried until it goes out, one at a time; a changed spent count makes an anchor due |
| gateway `bounded.test.ts` | HTTP + testnet | 5 | a 402 and `/api/info` take the same time with 200,000 spent nullifiers as with none; `/api/info` keeps its size and latency with 50,000 anchor rows (the last 16 and `anchorCount`); one challenge buys 3 proof checks, then `UNKNOWN_CHALLENGE`; 50 parallel claims start at most 4 scans, the rest 503 with `Retry-After`; text/plain or untyped claims and anchor requests are 415 |
| gateway `config.test.ts` | the real `serve.ts` process | 4 | blank `Z402_UNIT_ZAT`/`Z402_PRICE_UNITS` mean 1,000 zat and 10 units (not 0); `0`, `-5`, `1e3`, `abc`, `84O5`, `2,880` exit 2 with Setup required; `intEnv`; the Gateway refuses a 0-zat unit or a free endpoint |
| gateway `tip.test.ts` | local stand-in scan binaries (shell scripts, no network) | 5 | `chainTip` lets a 50 ms timer fire while the binary runs; output that is not a block height (empty, an error line, `4530000abc`, `-5`, `1e9`) is rejected; a hung binary times out at the given limit; a failing binary is an error; `anchorDue` with a NaN tip throws instead of reporting nothing due |
| sdk `client.test.ts` | HTTP + testnet | 3 | plan (amount, memo, 0600 notes file); two calls paid with proofs, then no note left; a dearer endpoint needs its own note |
| sdk `relay.test.ts` | HTTP + testnet + real relay, sink and redirect servers | 7 | a URL on another origin is never fetched (the server it names receives 0 requests); a challenge for another path is refused even from the configured origin; a redirect from the gateway origin is not followed (the target receives nothing); the gateway itself is still paid; a server that relabels the gateway's `/api/report` challenge as a 5-unit path is refused before any proof (price), and as an equal-price path is refused by the context hash (the note was burned for the report before); two payments read `/api/info` once |
| sdk `anchored-root.test.ts` | lightwalletd (testnet) + HTTP + real dishonest gateway servers | 11 | an anchored root pays and the proof carries exactly the published anchored root; no anchor → `UNANCHORED_ROOT`; a per-client root without an anchor → `UNANCHORED_ROOT`, passed off as the published anchor → `ANCHOR_MISMATCH`; an anchored leaf rewritten → `LEAVES_NOT_ANCHORED`; a leaf added after the anchor never reaches the proof; a pinned anchor key refuses the unsigned Oct 20 anchor (`ANCHOR_BAD_SIGNATURE`, no proof sent); two payments against one anchor start one scanner process; too old → `ANCHOR_TOO_OLD` (the default window refuses the Oct 20 anchor); `ANCHOR_FORK`, `ANCHOR_ROLLBACK`; no key → Setup required |
| sdk `anchor-window.test.ts` | local (anchors signed in the test, real Poseidon leaves) | 5 | `pickAnchor`: the newest anchor on one history is used when an older one is named; a second signed root for the same leaf count → `ANCHOR_COMPETING`, whichever is named; an anchor for more leaves than served → `ANCHOR_COMPETING`; with a pinned key, memos from other keys or unsigned are ignored; without one (an unsigned deployment) unsigned memos count, signed ones are ignored and a signed named anchor is Setup required; a named anchor not signed by the pinned key → `ANCHOR_BAD_SIGNATURE` |
| sdk `notes-lock.test.ts` | HTTP + testnet + a second process | 4 | plans made in this process and in another one while a claim scans the chain are all kept, and the claim lands; `recordDeposit`; two payments at once spend two different notes and both are recorded; a dead process's lock is taken over, a live one's makes the change wait |
| sdk `config.test.ts` | local | 4 | a malformed `Z402_MAX_ANCHOR_AGE_BLOCKS` is Setup required (not NaN); blank is the default; `Z402_REPLAY_AT_HEIGHT` unset or blank is a live client, malformed is Setup required; options must be non-negative whole numbers |
| sdk `pass2.test.ts` | lightwalletd (testnet) + HTTP + a proxy naming an older anchor | 4 | the pass-2 anchors and the competing one are on-chain, signed with the published anchor key; replayed as of block 4,529,604 a pinned-key client with the default window pays against `4265af65…` (its window holds the four honest anchors, not the competing one); after accepting `4265af65…`, a gateway that still names `c69195a9…` is paid again (it was `ANCHOR_ROLLBACK`); replayed at the record's end (4,529,619) the competing anchor is in the window: `ANCHOR_COMPETING`, nothing proven |
| mcp | stdio MCP client + HTTP + testnet | 9 | tools; claim the real deposit and refuse a second claim; pay against the anchored root (Setup required without the anchor key); `pay` asks again while the anchor is too old (`ANCHOR_TOO_OLD`); status never shows a secret; deposit without a wallet → Setup required; `Z402_MAX_TOTAL_DEPOSIT_ZAT` refuses before any plan is made, and holds for two `deposit` calls at once through a local stand-in zingo-cli (one send, one plan); the call log is 0600, new or existing; malformed caps and waits are Setup required |
| **Total** | | **106 + doc** | 0 skipped, 0 failed |

Failing first. The 12 tests in `attacks.test.ts` and `relay.test.ts` from Oct 21 failed on the code before
those fixes (see `docs/JUDGE-2026-10-21.md`). Oct 22 pass 2, run against `a8aa033`: all 9 `anchored-root.test.ts`
tests failed there, and in `persistence.test.ts` the restart, two-process and import tests.

Ultra round (Oct 22), run against `773ffc5` in a separate worktree with these test files copied in: 38 new tests,
37 fail there (circuits 1; gateway 17: signed anchors 2, `scanAnchors` 1, anchoring 6, bounded 4, config 4; sdk 16:
relay redirect 1, anchored-root 2, anchor-window 5, notes-lock 4, config 2, pass2 2; mcp 3). The one that passes there
is sdk config "blank means the default window", which guards the new parser rather than a bug. The strengthened
relay test (a foreign URL is never fetched) also fails there: the relay received the request.

Second ultra round (Oct 23). New tests run against `4811fb1`: gateway 8 new, 7 fail there (tip 4 of 5, bounded 1,
attacks 2; the guard "a failing binary is an error" passes); sdk `config` and `pass2` 3 new, all fail there (the replay
option does not exist, and the rollback test is refused). The other new tests were run on the code just before each fix:
relay 3 (the 5-unit path paid HTTP 200 with a 10-unit note; the equal-price path then got 402; `/api/info` was read
twice), mcp 2 (both parallel deposits were sent; the log was 0644), and the rollback test (`ANCHOR_ROLLBACK`).

Tests that read the Oct 20 anchor replay it as of 10 blocks after it (`replayAtHeight`) with the default 2,880-block
window, so the scan range is fixed and does not grow with the tip; the pass-2 tests replay at fixed heights from the
record. Before Oct 23 they widened the window to the anchor's age + 10 blocks, about 1,150 more blocks a day. Only the
tests that show a live client refusing (`ANCHOR_TOO_OLD` with the default window) scan back from the tip, over the
default window. An unpinned client of the Oct 20 deployment counts unsigned memos on the public anchor address: a third
party's unsigned memo sent there would make a live unpinned client refuse, but cannot reach a replay unless it was mined
inside the pinned range (which ends 10 blocks after the anchor, on Oct 20). Live runs: `run-live` (Oct 20) and `pass2`
(Oct 22), see the README.

## Browser E2E (`e2e/`, Playwright in Google Chrome)

`e2e/stack.sh` starts the real stack on 127.0.0.1 (gateway on a fresh SQLite database with the
published demo viewing keys, a second gateway with a throwaway admin token and no wallet, the dashboard,
the landing) and writes its PIDs; `e2e/stack.sh stop` kills them. Then `pnpm test:e2e`. Video, trace
and screenshots for every test; desktop 1280×800 and mobile 375×812.

| Spec | Desktop | Mobile | What |
|---|---|---|---|
| `landing.spec.ts` | 10 | 10 | the pass-2 section: its 9 rows, links in order to every pass-2 txid, proof times, the probe, the `ANCHOR_COMPETING` void; pass and hero from the run record; tickets tear off once in view, never with reduced motion; the 22 nullifiers in spend order; rail arrows, keyboard, snap back to the gutter, edge fade gone at the end; nav, CTAs, skip link; voided codes, the agent's 9/23 and its +1 double credit; the corrected wording is shown and the old claims are gone, with the deposit-to-first-call latency read from `testnet-pass2.json`; every link (explorer links name run txids, repo links name tracked files); no button labelled "log" |
| `dashboard.spec.ts` | 15 | 15 | the pass-2 roll: 10 rows from `testnet-pass2.json` with every txid linked in order; the 8th void (`ANCHOR_COMPETING`); punched pass; pick a ticket (mouse and keyboard) to read its stub; rail arrows and edge fade; section nav below the sticky header; who sees what; the 7 voided codes; all 23 agent calls with the 9 refusals and row 16 marked as the pre-fix double credit; the corrected wording; the anchor hash recomputed in the browser, Hash again, a tampered set shows the mismatch, Setup required without Web Crypto; every link; reduced motion |
| `gateway.spec.ts` | 10 | — | fresh `/api/info` (no viewing key) and the 402 in Chrome (a stateless `v1.` nonce carrying the challenge's expiry); altered claim not credited; the SDK claims the published deposit (testnet viewing-key check), 409 on a second claim, Setup required without the anchor key, `UNANCHORED_ROOT` with no anchor (nothing sent); `MALFORMED_SIGNALS`, 400, 413; anchoring Setup required without a token, 401 without the bearer, Setup required without a wallet; the dashboard's anchor memo equals the one read from lightwalletd; the real MCP server writes one `Z402_MCP_LOG` line per call; a gateway without keys exits 2 with Setup required. Desktop only: it claims the one deposit on one database |
| **Total** | **35** | **25** | 60, 0 failed; every test also fails on a console error or a failed same-origin request |
