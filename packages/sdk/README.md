# @z402/sdk

`Z402Client(gatewayUrl, notesFile, options?)`: `plan(count, units)` (notes + the deposit to send),
`claim(plan, txid)`, `pay(url)` (proves with an unspent note of exactly the price, checks its leaf
against the gateway's; pays only challenges from its own gateway, for the requested path, to the
gateway's `payTo`), `status()`. Note secrets live in a 0600 JSON file and are never returned.

**Anchored roots.** Before proving, `pay` runs `checkAnchor`: it reads the anchor tx the challenge
names from lightwalletd with the anchor address's published viewing key, needs a memo for exactly
that leaf count and root, mined and recent, rebuilds the root from the first `leaves` leaves the
gateway serves, and proves against that anchored tree only. It remembers the last anchor it accepted
(in the notes file) and refuses one that is older or does not extend it. Refusals are
`AnchorRefusedError` with `code` `UNANCHORED_ROOT`, `ANCHOR_MISMATCH`, `ANCHOR_NOT_CONFIRMED`,
`ANCHOR_TOO_OLD`, `LEAVES_NOT_ANCHORED`, `ANCHOR_ROLLBACK`, `ANCHOR_FORK` or `NOTE_NOT_ANCHORED`
(every note of the price is newer than the anchor: wait for the next one); nothing is proven or sent.

| Option | Env | Default |
|---|---|---|
| `anchorUivk` | `Z402_ANCHOR_UIVK` | none: `pay` says Setup required |
| `maxAnchorAgeBlocks` | `Z402_MAX_ANCHOR_AGE_BLOCKS` | 2,880 (about 2.5 days at 75 s) |
| `minAnchorConf` | | 1 |
| `lwdUrl` | `Z402_LWD_URL` | `https://testnet.zec.rocks:443` |

The client runs the `zpay-verify` binary from `packages/scan` (`Z402_SCAN_BIN`) to read anchors.

Tests (`pnpm test`, 15): `client.test.ts` 3, `relay.test.ts` 3 (a real relay server in front of the gateway) and `anchored-root.test.ts` 9 (real dishonest gateways in front of a real one), against a fresh gateway that credits the real published deposit (testnet viewing-key check) and adopts the published anchor, with real proofs.
