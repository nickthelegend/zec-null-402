# @z402/gateway

The pool, run by the gateway (Zcash has no contracts). Node `http`, no framework.

| Endpoint | Does |
|---|---|
| `GET /api/info` | deposit address (not its viewing key), unit, payTo, prices, tree size, root, spent count, anchors |
| `GET /api/leaves` | every credited leaf (clients rebuild the tree and check the root) |
| `POST /api/deposits {txid, items}` | credits the notes once, if its viewing key sees the deposit pay `Σ value × unit` with memo `z402:<commitment of items>`, mined |
| `GET <paid path>` | 402 `{payTo, requiredAmount, contextHash, nonce, root}`; with `X-PAYMENT` → canonical decimal signals, binding, known root (last 64), unspent nullifier, Groth16 (snarkjs) → 200 |
| `POST /api/anchor` | needs `Authorization: Bearer $Z402_ADMIN_TOKEN` (503 Setup required without one); memo `z402:anchor:<leaves>:<root>:<spent>:<nullifier-set hash>` to the anchor address |

Refusal reasons: `MALFORMED_SIGNALS`, `UNKNOWN_CHALLENGE`, `NOT_BOUND_TO_CHALLENGE`, `UNKNOWN_ROOT`, `NULLIFIER_SPENT`,
`BAD_PROOF`; claims: `already claimed` (409), `deposit not credited: <scan reasons>` (402),
not mined yet (425); a claim already running for that txid (409); bodies over 64 KiB (413). At most 10,000 unpaid challenges are kept (5 min each, oldest dropped first); the challenge and nullifier are reserved while a proof is checked. `serve.ts`: `Z402_STATE`, `Z402_DEPOSIT_UA`, `Z402_DEPOSIT_UIVK`, optional
`Z402_WALLET` + `Z402_ANCHOR_UA` + `Z402_ADMIN_TOKEN` for anchoring.

Tests (`pnpm test`, 15): `gateway.test.ts` 6 and `attacks.test.ts` 9, each against a fresh gateway that credits the real published deposit (testnet viewing-key check), with real proofs.
