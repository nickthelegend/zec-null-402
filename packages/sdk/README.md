# @z402/sdk

`Z402Client(gatewayUrl, notesFile, options?)`: `plan(count, units)` (notes + the deposit to send),
`claim(plan, txid)`, `pay(url)` (proves with an unspent note of exactly the price, checks its leaf
against the gateway's; pays only challenges from its own gateway, for the requested path, to the
gateway's `payTo`), `status()`. Note secrets live in a 0600 JSON file and are never returned.

**Anchored roots.** Before proving, `pay` runs `checkAnchor`: it reads the anchor tx the challenge
names with the anchor address's published viewing key, needs a memo for exactly that leaf count and
root, mined and recent, rebuilds the root from the first `leaves` leaves the gateway serves, and
remembers the last anchor it accepted (in the notes file), refusing one that is older or does not
extend it. Then it scans the anchor address over its whole window (compact blocks through
lightwalletd, `scanAnchors`; one scan reused for 30 s, then only new blocks): with a pinned anchor key
(`anchorPubkey`) the named anchor must be signed by it and other memos on the address are ignored
(without one: unsigned deployments only, counting unsigned memos);
every counted anchor must be the root of a prefix of the served leaves; it proves against the newest
counted anchor, whichever the gateway named (`pickAnchor`). Refusals are `AnchorRefusedError` with
`code` `UNANCHORED_ROOT`, `ANCHOR_MISMATCH`, `ANCHOR_NOT_CONFIRMED`, `ANCHOR_TOO_OLD`,
`LEAVES_NOT_ANCHORED`, `ANCHOR_ROLLBACK`, `ANCHOR_FORK`, `ANCHOR_BAD_SIGNATURE`, `ANCHOR_COMPETING` or
`NOTE_NOT_ANCHORED` (every note of the price is newer than the anchor: wait for the next one); nothing
is proven or sent. The client trusts its lightwalletd for anchor txs and heights.

**Only its gateway.** `pay` fetches nothing outside the gateway's origin and follows no redirect.

**The notes file.** Every change re-reads the file under a lock (in-process and an O_EXCL lockfile
across processes) and is fsynced before the rename; `pay` marks its note pending, so payments at once
use different notes. `recordDeposit(plan, txid)` saves a sent deposit's txid at once; `dropPlan(plan)`
removes a plan whose deposit was never sent; `depositedZat()` totals the sent deposits.

| Option | Env | Default |
|---|---|---|
| `anchorUivk` | `Z402_ANCHOR_UIVK` | none: `pay` says Setup required |
| `anchorPubkey` | `Z402_ANCHOR_PUBKEY` | none: the deployment is taken as unsigned (a signed anchor is Setup required; only unsigned memos count). Pin it from the deployment record |
| `maxAnchorAgeBlocks` | `Z402_MAX_ANCHOR_AGE_BLOCKS` | 2,880 (about 2.5 days at 75 s); malformed is Setup required |
| `minAnchorConf` | | 1 |
| `lwdUrl` | `Z402_LWD_URL` | `https://testnet.zec.rocks:443` |

The client runs the `zpay-verify` binary from `packages/scan` (`Z402_SCAN_BIN`) to read anchors.

Tests (`pnpm test`, 30): `client.test.ts` 3, `relay.test.ts` 4 (a real relay server in front of the gateway; a foreign URL and a redirect are never fetched), `anchored-root.test.ts` 11 (real dishonest gateways in front of a real one; a pinned key refuses the unsigned Oct 20 anchor; two payments read lightwalletd once), `anchor-window.test.ts` 5 (`pickAnchor` with anchors signed in the test), `notes-lock.test.ts` 4 (a claim racing plans in this and another process; two payments at once; stale and live locks), `config.test.ts` 3, against a fresh gateway that credits the real published deposit (testnet viewing-key check) and adopts the published anchor, with real proofs.
