# @z402/gateway

The pool, run by the gateway (Zcash has no contracts). Node `http`, no framework.

| Endpoint | Does |
|---|---|
| `GET /api/info` | deposit address (not its viewing key), unit, payTo, prices, tree size, root, spent count, anchors, latest mined anchor |
| `GET /api/leaves` | every credited leaf (clients rebuild the tree and check the root) |
| `POST /api/deposits {txid, items}` | credits the notes once, if its viewing key sees the deposit pay `Σ value × unit` with memo `z402:<commitment of items>`, mined |
| `GET <paid path>` | 402 `{payTo, requiredAmount, contextHash, nonce, root, anchor}` (`anchor`: the newest mined anchor `{txid, leaves, root, height}`, `root` its root; `null` without one); with `X-PAYMENT` → canonical decimal signals, binding, known root (last 64 or any anchored), unspent nullifier, Groth16 (snarkjs) → 200 |
| `POST /api/anchor` | needs `Authorization: Bearer $Z402_ADMIN_TOKEN` (503 Setup required without one); memo `z402:anchor:<leaves>:<root>:<spent>:<nullifier-set hash>` to the anchor address |

Refusal reasons: `MALFORMED_SIGNALS`, `UNKNOWN_CHALLENGE`, `NOT_BOUND_TO_CHALLENGE`, `UNKNOWN_ROOT`, `NULLIFIER_SPENT`,
`BAD_PROOF`; claims: `already claimed` (409), `deposit not credited: <scan reasons>` (402),
not mined yet (425); a claim already running for that txid (409); bodies over 64 KiB (413). At most 10,000 unpaid challenges are kept (5 min each, oldest dropped first); the challenge and nullifier are reserved while a proof is checked.

State is a SQLite database (`node:sqlite`): leaves, roots, deposits, nullifiers, outstanding
challenges and anchors survive a restart. A challenge is taken with an atomic `DELETE … RETURNING` and
a nullifier burned with a primary-key insert, so two gateway processes on one database pay a note
once. A pre-SQLite JSON state is imported once with `legacyJsonState` (`Z402_LEGACY_STATE`); a JSON
file passed as the database is refused with Setup required.

Anchors: `anchor()` sends the memo; `confirmAnchors()` reads the gateway's unmined anchors with the
anchor viewing key and records their height (run in the background when challenges are issued);
only mined anchors are offered to clients. `adoptAnchor(txid)` records an anchor already on-chain if
its leaf count and root match this gateway's leaves. `readAnchor(uivk, txid)` and `parseAnchorMemo`
are exported for clients.

`serve.ts`: `Z402_STATE` (SQLite file), `Z402_DEPOSIT_UA`, `Z402_DEPOSIT_UIVK`, optional
`Z402_LEGACY_STATE`; `Z402_WALLET` + `Z402_ANCHOR_UA` + `Z402_ANCHOR_UIVK` for anchoring,
`Z402_AUTO_ANCHOR=1` to anchor after every credited deposit, `Z402_ADMIN_TOKEN` for `POST /api/anchor`.

Tests (`pnpm test`, 26): `gateway.test.ts` 6, `attacks.test.ts` 9, `persistence.test.ts` 4 (restart; a second real `serve.ts` process on the same database; JSON import), `anchor.test.ts` 7 (memo parsing; the published anchor read from lightwalletd; adopt, refuse, confirm; Setup required), each against a fresh gateway that credits the real published deposit (testnet viewing-key check), with real proofs.
