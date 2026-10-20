# Kippu (zec-null-402): design, trust model and why there is no on-chain verifier

## The idea

Pay once with a real shielded Zcash deposit, then pay per API call with a zero-knowledge proof of an
unspent prepaid note. A call costs no transaction and no block wait, and the gateway learns only that
*some* credited note paid, not which one.

## Why the verifier is off-chain

Zcash has no smart contracts, so null-402's on-chain Groth16 pool (Avalanche) and near-null-402's
pool contract (NEAR) cannot be ported to Zcash L1. Here **the gateway is the pool**:

| Piece | null-402 (Fuji) | near-null-402 (NEAR) | zec-null-402 (Zcash) |
|---|---|---|---|
| deposit | ERC-20 into a contract | NEAR into a contract | shielded ZEC to the gateway's address, memo `z402:<commitment>` |
| leaf value bound to the deposit | no | yes, computed on-chain | yes, computed by the gateway from what its viewing key sees |
| proof verified by | Solidity verifier | `alt_bn128_*` host functions | the gateway (snarkjs, off-chain) |
| nullifiers | contract storage | contract storage | gateway state, anchored on-chain |

## Flow

1. **Plan.** The client creates N notes and a commitment `sha256("zec-null-402:v1:deposit:" ‖ secretHash_i:value_i…)`.
2. **Deposit.** One shielded transaction to the gateway's address, `Σ value × unit` zatoshi, memo
   `z402:<commitment>` (1 unit = 1,000 zat in the live run).
3. **Claim.** The client sends `{txid, items}`. The gateway recomputes the commitment, checks with its
   own incoming viewing key that the transaction pays at least that much with exactly that memo and
   is mined, and appends `Poseidon(secretHash_i, value_i)` for each note. A deposit is credited once.
4. **Pay.** `GET` → 402 `{payTo, requiredAmount, contextHash, nonce, root}` → the client proves
   `Payment(20)` for one note of exactly the price, bound to this request → `X-PAYMENT` → the gateway
   checks binding, known root, unspent nullifier, Groth16 → 200, nullifier burned.
5. **Anchor.** The gateway sends `z402:anchor:<leaves>:<root>:<spent>:<sha256 of the sorted nullifier set>`
   in a shielded memo to an address whose incoming viewing key is public.

## What each party learns

| Party | Learns | Does not learn |
|---|---|---|
| the chain | a shielded deposit and the anchor transactions happened | amounts, memos, who deposited |
| the gateway | each deposit (amount, its note leaves) and each paid call's nullifier | which note paid which call; whether two calls came from the same deposit, beyond the anonymity set |
| anyone with the anchor viewing key | the gateway's leaf count, root, spent count and nullifier-set hash at each anchor | individual payments |

**The anonymity set is the set of credited notes.** With one depositor (the live run), the gateway
knows every call came from that depositor's notes, just not which note. Unlinkability across users
needs several depositors.

## Trust model

- **The gateway is trusted** for liveness and for its state: it could refuse to credit a deposit,
  refuse a valid proof, or (by editing its state) allow a double spend. The anchors make its leaf
  set and nullifier set auditable after the fact: a published nullifier list that does not hash to
  the anchored value, or a root that does not match the published leaves, is evidence.
- **Trusted setup:** single-party local Groth16 setup (`packages/circuits/scripts/build.sh`). Whoever
  ran it could forge proofs; a real deployment needs a ceremony.
- **No change:** a note pays one call of its full value; plan notes of the price.
- **Testnet only.** Not audited.

## Do X → see Y

| Do | See |
|---|---|
| `pnpm --filter @z402/circuits test` | real proofs; tampered inputs fail; no proof above a note's value; deposit commitments bind every note |
| `pnpm --filter @z402/gateway test` | a fresh gateway credits the real published deposit (viewing key), refuses a second claim and altered values, accepts a real proof, refuses replay, tamper and wrong request |
| run the live example | one deposit → 20 paid calls, no transaction per call, anchor memo found on-chain |

## Pre-existing work

Circuit and client design from null-402 / near-null-402 (same author). Built Oct 20, 2026.
