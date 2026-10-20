# zec-null-402

> Pay once with a real shielded Zcash deposit, then pay per API call with a zero-knowledge proof of an unspent credit note — instant, no on-chain tx per call, and the gateway can't link calls to each other or to the deposit beyond the deposit amount.

**Status: scaffold only.** Spec: `grokbot/specs/zec-null-402.md`. Intended repo `nickthelegend/zec-null-402` (not created).

## Packages
| Package | Role |
|---|---|
| `packages/circuits` | Port of null-402 `Payment(20)` circuit (Poseidon depth-20, nullifier, payTo, requiredAmount, contextHash) |
| `packages/gateway` | Hono x402 gateway: issues credit notes against a UIVK-verified shielded deposit, verifies Groth16 spends off-chain, nullifier store, periodic memo anchoring |
| `packages/sdk` | TS agent SDK: deposit, hold notes, prove per call |
| `packages/mcp` | MCP server: `deposit`, `pay(url)`, `status` — agent pays per call; tests against real testnet + real gateway |
| `packages/dashboard` | Public-vs-private view: what the chain sees (one shielded deposit), what the gateway sees (nullifiers only) |
| `packages/examples` | agent e2e: 1 deposit → 20 paid calls |
| `packages/docs` | Trust model, anchoring, why no L1 verifier |
| `packages/landing` | Landing |

## Live testnet deployment
_None yet._ Gateway UA + demo UIVK; table of deposit txid and anchor-memo txids (Ironwood-only).

## Tests — real testnet, no mocked clients
| Package | Network | What | Result |
|---|---|---|---|
| circuits | local | real proof verifies; wrong amount/context fails | not run yet |
| gateway | live testnet deposit | credit issued only after real confirmed deposit; replayed nullifier rejected; tampered proof rejected | not run yet |
| mcp | live testnet + live gateway | agent pays 20 calls; no mocked clients | not run yet |
| anchor | live testnet | anchor memo found by UIVK matches gateway root | not run yet |

MIT.
