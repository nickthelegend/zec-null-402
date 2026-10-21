# Kippu (zec-null-402): submission draft (portfolio; DO NOT SUBMIT)

Zecathon allows one entry per team: Shielded x402 (Kage). Kippu is a portfolio piece.

**Name:** Kippu (切符, "ticket"); repo name zec-null-402
**One line:** One shielded Zcash deposit, then pay per API call with a zero-knowledge proof: no transaction per call, and a gateway that follows the protocol can't tell which credited note paid.
**Repo:** github.com/nickthelegend/zec-null-402 (public before submission)
**Video:** `zec-null-402-demo.mp4`, recorded Oct 20, before the Oct 21 review fixes (shared separately until hosted)

## Proof (Zcash testnet, Oct 20, 2026)
- Deposit [`05c57a3b…`](https://testnet.zcashexplorer.app/transactions/05c57a3b074c7141a1052ca5197743a5140d5f4fa6178cd3d4894391ffd42a6f) credited 22 notes (checked by the gateway's viewing key); 20 paid calls + 2 fixture-note calls, 0 transactions; replay, tamper, wrong-request and double-claim refused; anchor [`a0992237…`](https://testnet.zcashexplorer.app/transactions/a09922378bb7d404c31ac9226fee2de5664a920483d714b1b811647717501395) matches the gateway state.
- 53 tests + doc (TESTING.md), most against testnet with real proofs.

## Review fixes (Oct 21, 2026)
A strict review (`docs/JUDGE-2026-10-21.md`) found double spends in the Oct 20 gateway: a spent note paid again with a re-encoded nullifier, and parallel requests with one payment were all paid. Fixed, each with a test that fails on the old code, together with a relay attack on the client, an unauthenticated wallet-spending anchor route, the viewing key on `/api/info` and unbounded memory.

Pass 2 (Oct 22): clients prove only against a root they read themselves in a recent on-chain anchor (lightwalletd + the published anchor viewing key), so a gateway can't hand each client its own root; refused before proving otherwise. Gateway state moved to SQLite (restart keeps challenges and spent nullifiers; two processes on one database pay a note once). Tests fail on the old code.

## Honest scope
Off-chain verifier (Zcash has no contracts): the gateway is trusted for liveness and its nullifier set, its state anchored. Clients check the anchor the gateway names but do not scan for competing anchors; new notes wait for the next anchor. Single-party setup. Testnet only. Not audited. Built on null-402 / near-null-402 (same author).
