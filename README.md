# zec-null-402

**Pay once with a shielded Zcash deposit, then pay per API call with a zero-knowledge proof.** No
transaction and no block wait per call; the gateway learns that *some* prepaid note paid, not which.

Zcash has no contracts, so null-402's on-chain Groth16 pool can't be ported. Here **the gateway is
the pool**: it credits notes only for a deposit its own viewing key sees on-chain (the memo commits
to every note and value), verifies each call's Groth16 proof off-chain, burns nullifiers, and
anchors its state in a shielded memo to a public-viewing-key address. The gateway is trusted; its
history is auditable (see [docs](packages/docs/README.md)).

## Live on Zcash testnet

Run of 2026-10-20 (`deployments/testnet.json`). 1 unit = 1,000 zat; a call costs 10 units.

| Step | Result | Tx |
|---|---|---|
| one shielded deposit for 22 notes (`z402:<commitment>`) | 220,000 zat at block 4,522,696, seen by the gateway's viewing key | [`05c57a3b…`](https://testnet.zcashexplorer.app/transactions/05c57a3b074c7141a1052ca5197743a5140d5f4fa6178cd3d4894391ffd42a6f) |
| claim | 22 notes credited, root `449878737549…` | — |
| second claim of the same deposit | refused (409) | — |
| claim with an altered note value (fresh gateway) | refused: `MEMO_MISMATCH, AMOUNT_TOO_LOW` | — |
| **20 paid calls** | **20 × HTTP 200, no transaction**, proofs 346–569 ms | — |
| replay of a paid proof | `NULLIFIER_SPENT` | — |
| changed amount / proof for another request | `NOT_BOUND_TO_CHALLENGE` / `NOT_BOUND_TO_CHALLENGE` | — |
| changed nullifier | `BAD_PROOF` | — |
| anchor (`z402:anchor:22:<root>:22:<nullifier-set hash>`) | memo found with the anchor viewing key; equals the gateway's root and nullifier set | [`a0992237…`](https://testnet.zcashexplorer.app/transactions/a09922378bb7d404c31ac9226fee2de5664a920483d714b1b811647717501395) |

Fixture notes: two of the 22 notes were spent in the run and their secrets published, so tests in a
fresh clone can claim the real deposit on a fresh gateway and pay with real proofs.

## Packages

| Package | What |
|---|---|
| [`packages/circuits`](packages/circuits) | `Payment(20)` with the value-bound leaf (from near-null-402), this repo's own setup (vk `8e7fa586…`), deposit commitments |
| [`packages/gateway`](packages/gateway) | the pool run by the gateway: deposits via viewing key, tree, off-chain Groth16, nullifiers, anchors, HTTP |
| [`packages/scan`](packages/scan) | `zpay-verify` (copy) for the viewing-key checks |
| [`packages/sdk`](packages/sdk) | `Z402Client`: plan, claim, pay, status |
| [`packages/mcp`](packages/mcp) | `z402-mcp`: status, deposit, claim, pay |
| [`packages/examples`](packages/examples) | the resumable live run above |
| [`packages/dashboard`](packages/dashboard) | chain vs calls, who sees what, refusals, anchor recomputed in the browser |
| [`packages/docs`](packages/docs) | why no on-chain verifier, flow, anonymity set, trust model |
| [`packages/landing`](packages/landing) | one-page landing |

## Run it

Needs Node 22+, pnpm 10, Rust 1.89 (pinned in `packages/scan`), circom 2.2 only to redo the setup.

```sh
pnpm install
pnpm test                          # 18 tests: circuits 5 (local), gateway 6 + sdk 3 + mcp 4 (live testnet)
pnpm --filter @z402/dashboard dev  # http://localhost:5183
Z402_FUNDER_WALLET=<demo wallet> pnpm --filter @z402/examples run-live
```

Demo video: `grokbot/videos/zec-null-402-demo.mp4`.

## Honest limits

- The gateway is trusted for liveness and its state; anchors make its leaf and nullifier sets
  auditable after the fact, they do not stop a dishonest gateway in the moment.
- One depositor in the run: every call came from that depositor's notes. Unlinkability between
  users needs several depositors.
- Single-party Groth16 setup; a note pays one call of its full value; testnet only; not audited.
- Portfolio piece; the Zecathon entry is Shielded x402.

MIT — Copyright (c) 2026 Nivesh Gajengi.
