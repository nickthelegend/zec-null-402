# Kippu (zec-null-402): design, trust model and why there is no on-chain verifier

## The idea

Pay once with a real shielded Zcash deposit, then pay per API call with a zero-knowledge proof of an
unspent prepaid note. A call costs no transaction and no block wait, and a gateway that follows the
protocol learns only that *some* credited note paid, not which one.

## Why the verifier is off-chain

Zcash has no smart contracts, so null-402's on-chain Groth16 pool (Avalanche) and near-null-402's
pool contract (NEAR) cannot be ported to Zcash L1. Here **the gateway is the pool**:

| Piece | null-402 (Fuji) | near-null-402 (NEAR) | zec-null-402 (Zcash) |
|---|---|---|---|
| deposit | ERC-20 into a contract | NEAR into a contract | shielded ZEC to the gateway's address, memo `z402:<commitment>` |
| leaf value bound to the deposit | no | yes, computed on-chain | the sum is: the gateway checks with its viewing key that the deposit covers the committed values |
| proof verified by | Solidity verifier | `alt_bn128_*` host functions | the gateway (snarkjs, off-chain) |
| nullifiers | contract storage | contract storage | gateway state, anchored on-chain |

## Flow

1. **Plan.** The client creates N notes and a commitment `sha256("zec-null-402:v1:deposit:" ‖ secretHash_i:value_i…)`.
2. **Deposit.** One shielded transaction to the gateway's address, `Σ value × unit` zatoshi, memo
   `z402:<commitment>` (1 unit = 1,000 zat in the live run).
3. **Claim.** The client sends `{txid, items}`. The gateway recomputes the commitment, checks with its
   own incoming viewing key that the transaction pays at least that much with exactly that memo and
   is mined, and appends `Poseidon(secretHash_i, value_i)` for each note. A deposit is credited once:
   it is locked while it is scanned (since Oct 21; the Oct 20 agent run's gateway, before that fix,
   credited deposit `0b12bfc6…` twice, as leaves 25 and 26: the same note and nullifier, so no extra
   value).
4. **Anchor.** The gateway sends `z402:anchor:<leaves>:<root>:<spent>:<sha256 of the sorted nullifier set>:<Ed25519 signature>`
   in a shielded memo to an address whose incoming viewing key is public. With `Z402_AUTO_ANCHOR=1` it
   anchors after every credited deposit, when the spent count changed, and whenever the newest anchor
   is 1,440 blocks old, retrying failed sends. New notes can pay once an anchor covering them is mined.
5. **Pay.** `GET` → 402 `{payTo, requiredAmount, contextHash, nonce, root, anchor: {txid, leaves, root, height}}`
   → the client reads that anchor tx from its lightwalletd with the anchor viewing key it was configured
   with (never one the gateway sends), requires a memo for exactly that leaf count and root, mined and
   at most 2,880 blocks old, signed by the gateway key it pinned (if it pinned one), rebuilds the root
   from the first `leaves` leaves of `GET /api/leaves`, and checks the anchor extends the last one it
   accepted. It then scans the anchor address over its window: every anchor counted there (signed by
   the pinned key, or all of them without one) must be the root of a prefix of the served leaves, else
   `ANCHOR_COMPETING`; it proves against the newest of them, whichever the gateway named → proves
   `Payment(20)` for one note of exactly the price under that anchored root, bound to this request →
   `X-PAYMENT` → the gateway checks canonical signals, binding, known root, unspent nullifier, Groth16
   → 200, nullifier burned. The client fetches nothing outside its gateway's origin and pays only
   challenges for the path it asked for.

## What each party learns

| Party | Learns | Does not learn |
|---|---|---|
| the chain | a shielded deposit and the anchor transactions happened | amounts, memos, who deposited (but see below: the demo's gateway viewing key is published) |
| the gateway | each deposit (amount, its note leaves), each paid call's nullifier and the caller's network address | which note paid which call, if it serves everyone the same leaves |
| anyone with the gateway's viewing key (published for the demo) | each deposit's amount, memo commitment and time | which notes were spent for what |
| anyone with the anchor viewing key | the gateway's leaf count, root, spent count and nullifier-set hash at each anchor | individual payments |

**The anonymity set is the credited notes of that price inside the latest anchor.** A payment
reveals its price (the circuit's `required_amount`; the SDK spends notes of exactly the price), and
only notes inside the anchored leaf count can pay. With one depositor (the live run), the gateway knows
every call came from that depositor's notes, just not which note. Unlinkability across users needs
several depositors.

## Trust model

- **The gateway is trusted** for liveness and for its nullifier set: it could refuse to credit a
  deposit, refuse a valid proof, or (by editing its state) allow a double spend. The anchors make
  its nullifier set auditable after the fact: a published nullifier list that does not hash to a
  value anchored with the gateway's signature is evidence against it. Unsigned memos prove nothing:
  the anchor address is public, so anyone can send one (the Oct 20 anchor is unsigned; anchors are
  signed since Oct 22).
- **The gateway must keep anchoring.** Clients refuse anchors older than their window (2,880 blocks),
  so a gateway that stops anchoring stops being payable. With `Z402_AUTO_ANCHOR=1` it re-anchors every
  1,440 blocks and after every change; each anchor costs 10,000 zat plus the fee.
- **Roots come from anchors, not from the gateway's word** (the bold idea in
  [JUDGE-2026-10-21.md](../../docs/JUDGE-2026-10-21.md), built Oct 22). Every client proves against
  the root of a recent anchor it has read on-chain itself, so clients that see the same anchor prove
  against the same root, and leaves served after the anchor never enter a proof. To partition
  clients by root, a gateway would have to anchor one root per client on-chain, signed with its key.
  Clients, first-time ones included, scan the anchor address over their window and refuse when two
  signed anchors are not on one leaf history (`ANCHOR_COMPETING`), and prove against the newest anchor
  whichever one is named, so stepping a payer through older anchors to see where its note is no
  longer works. Limits: a gateway can still time its anchors (a payer whose note is newer than the
  newest anchor is told `NOTE_NOT_ANCHORED`, which the gateway can see as a client that does not
  pay); it sees network addresses. A client that has not pinned the anchor key treats the deployment
  as unsigned: it refuses a signed anchor and counts only unsigned memos, which anyone can send (so
  anyone can make it refuse) and a dishonest unsigned gateway can dodge by signing a competing anchor
  with a throwaway key. Pinning the key is what makes the check hold.
- **Lightwalletd is trusted for anchors.** The client reads anchor transactions and their heights from
  its configured lightwalletd (`Z402_LWD_URL`) and checks no block header or Merkle path; that server
  learns the client's address and which blocks and anchor txs it reads (one window scan per 30 s per
  client, plus the named anchor when it is outside the window).
- **State** is SQLite: a restart keeps outstanding challenges, nullifiers, deposits and anchors;
  two gateway processes on one database cannot both accept one nullifier or one challenge.
- **Anchoring over HTTP** needs `Z402_ADMIN_TOKEN`: it spends from the gateway wallet.
- **Trusted setup:** single-party local Groth16 setup (`packages/circuits/scripts/build.sh`). Whoever
  ran it could forge proofs; a real deployment needs a ceremony.
- **No change:** a note pays one call of its full value; plan notes of the price.
- **Testnet only.** Not audited.

## Do X → see Y

| Do | See |
|---|---|
| `pnpm --filter @z402/circuits test` | real proofs; tampered inputs fail; no proof above a note's value; deposit commitments bind every note |
| `pnpm --filter @z402/gateway test` | a fresh gateway credits the real published deposit (viewing key), refuses a second claim and altered values, accepts a real proof, refuses replay, tamper and wrong request; re-encoded nullifiers, parallel double spends, concurrent claims and an unauthenticated anchor are refused; a restart keeps challenges and nullifiers; a second gateway process on the same database cannot pay a note twice; the published anchor is read on-chain, found by a block-range scan, and adopted only when it matches; anchors are signed, sent one at a time, refreshed when stale and retried; per-request work is bounded; malformed settings stop the gateway |
| `pnpm --filter @z402/sdk test` | a real relay server in front of the gateway cannot get the client to pay its challenge or fetch anything; dishonest gateways serving the client its own root, a fake anchor, a rewritten leaf or no anchor are refused before proving; leaves added after the anchor never reach the proof; an unsigned anchor is refused with a pinned key; a competing signed anchor is refused; the newest anchor is used; concurrent calls keep every note |
| `pnpm --filter @z402/examples demo` | about 10 s, no transaction: the default window refuses the Oct 20 anchor, a dishonest root is refused, two fixture notes pay under a widened window |
| `pnpm --filter @z402/examples pass2` | the current protocol live on testnet (demo wallets): `deployments/testnet-pass2.json` |
| run the live example | one deposit → 20 paid calls, no transaction per call, anchor memo found on-chain |

## Pre-existing work

Circuit and client design from null-402 / near-null-402 (same author). Built Oct 20, 2026.
