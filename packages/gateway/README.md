# @z402/gateway

The pool, run by the gateway (Zcash has no contracts). Node `http`, no framework.

| Endpoint | Does |
|---|---|
| `GET /api/info` | deposit address (not its viewing key), unit, payTo, prices, tree size, root, spent count (counts, not rows), anchors, latest mined anchor, the anchor signing public key |
| `GET /api/leaves` | every credited leaf (clients rebuild the tree and check the root) |
| `POST /api/deposits {txid, items}` | `content-type: application/json` only (415 otherwise); credits the notes once, if its viewing key sees the deposit pay `Σ value × unit` with memo `z402:<commitment of items>`, mined; at most 4 scans at once (503 with `Retry-After` beyond) |
| `GET <paid path>` | 402 `{payTo, requiredAmount, contextHash, nonce, root, anchor}` (`anchor`: the newest mined anchor `{txid, leaves, root, height}`, `root` its root; `null` without one); with `X-PAYMENT` → canonical decimal signals, binding, known root (last 64 or any anchored), unspent nullifier, Groth16 (snarkjs) → 200 |
| `POST /api/anchor` | needs `Authorization: Bearer $Z402_ADMIN_TOKEN` (503 Setup required without one), the wallet, and `application/json`; memo `z402:anchor:<leaves>:<root>:<spent>:<nullifier-set hash>[:<Ed25519 signature>]` to the anchor address |

Refusal reasons: `MALFORMED_SIGNALS`, `UNKNOWN_CHALLENGE`, `NOT_BOUND_TO_CHALLENGE`, `UNKNOWN_ROOT`, `NULLIFIER_SPENT`,
`BAD_PROOF`; claims: `already claimed` (409), `deposit not credited: <scan reasons>` (402),
not mined yet (425); a claim already running for that txid (409); bodies over 64 KiB (413). At most 10,000 unpaid challenges are kept (5 min each, oldest dropped first); the challenge and nullifier are reserved while a proof is checked, and one challenge buys at most 3 proof checks.

State is a SQLite database (`node:sqlite`): leaves, roots, deposits, nullifiers, outstanding
challenges and anchors survive a restart. A challenge is taken with an atomic `DELETE … RETURNING` and
a nullifier burned with a primary-key insert, so two gateway processes on one database pay a note
once. A pre-SQLite JSON state is imported once with `legacyJsonState` (`Z402_LEGACY_STATE`); a JSON
file passed as the database is refused with Setup required.

Anchors: `anchor()` sends the memo, signed with the gateway's Ed25519 anchor key when it has one
(`Z402_ANCHOR_SIGNING_KEY`), one send at a time (calls during a send share one follow-up, skipped if
nothing changed); a sent anchor that cannot be recorded is reported with its txid. `confirmAnchors()`
reads the gateway's unmined anchors with the anchor viewing key and records their height; only mined
anchors are offered to clients. `startAnchoring()` (with `autoAnchor`) checks every 10 minutes and
anchors when notes were credited or the spent count changed since the newest anchor, when the newest
anchor is `Z402_ANCHOR_EVERY_BLOCKS` old (default 1,440, half the client's window) or was never seen
mined; failed sends are retried every 60 s. Each anchor costs the gateway wallet 10,000 zat plus the
fee. `adoptAnchor(txid)` records an anchor already on-chain if its leaf count and root match this
gateway's leaves. `readAnchor`, `scanAnchors` (every anchor on the anchor address in a block range),
`parseAnchorMemo`, `anchorSigner` and `verifyAnchorSignature` are exported for clients.

`serve.ts`: `Z402_STATE` (SQLite file), `Z402_DEPOSIT_UA`, `Z402_DEPOSIT_UIVK`, optional
`Z402_LEGACY_STATE`; `Z402_WALLET` + `Z402_ANCHOR_UA` + `Z402_ANCHOR_UIVK` for anchoring,
`Z402_ANCHOR_SIGNING_KEY` (64 hex Ed25519 seed, in a gitignored `.env`) to sign anchors,
`Z402_AUTO_ANCHOR=1` to keep anchoring, `Z402_ANCHOR_EVERY_BLOCKS`, `Z402_ADMIN_TOKEN` for
`POST /api/anchor`. Whole numbers (`Z402_UNIT_ZAT`, `Z402_PRICE_UNITS`, `Z402_PORT`,
`Z402_ANCHOR_EVERY_BLOCKS`) fail closed: blank means the default, anything else that is not a whole
number at or above its minimum exits 2 with Setup required. zingo-cli runs one at a time per wallet
directory (a lockfile).

Tests (`pnpm test`, 43): `gateway.test.ts` 6, `attacks.test.ts` 9, `persistence.test.ts` 4 (restart; a second real `serve.ts` process on the same database; JSON import), `anchor.test.ts` 10 (memo parsing; signed memos; the published anchor read from lightwalletd and found by a block-range scan; adopt, refuse, confirm; Setup required), `anchoring.test.ts` 6 (one send at a time; a sent-but-unrecorded anchor named; re-anchoring when stale, when the spent count changed, never when fresh; retries), `bounded.test.ts` 4 (200,000 nullifiers do not slow a 402; 3 proof checks per challenge; 4 scans at once; JSON only), `config.test.ts` 4 (fail-closed settings, the real `serve.ts`), each against a fresh gateway that credits the real published deposit (testnet viewing-key check), with real proofs.
