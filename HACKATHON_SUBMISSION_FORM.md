# zec-null-402 — submission draft (portfolio; DO NOT SUBMIT)

Zecathon allows one entry per team: Shielded x402.

**Name:** zec-null-402
**One line:** One shielded Zcash deposit, then pay-per-call with zero-knowledge proofs: no transaction per call, the gateway can't tell which note paid (within the set of credited notes).
**Repo:** github.com/nickthelegend/zec-null-402 (public before submission)
**Video:** `zec-null-402-demo.mp4` (shared separately until hosted)

## Proof (Zcash testnet, Oct 20, 2026)
- Deposit [`05c57a3b…`](https://testnet.zcashexplorer.app/transactions/05c57a3b074c7141a1052ca5197743a5140d5f4fa6178cd3d4894391ffd42a6f) credited 22 notes (checked by the gateway's viewing key); 20 paid calls + 2 fixture-note calls, 0 transactions; replay, tamper, wrong-request and double-claim refused; anchor [`a0992237…`](https://testnet.zcashexplorer.app/transactions/a09922378bb7d404c31ac9226fee2de5664a920483d714b1b811647717501395) matches the gateway state.
- 21 tests + doc (TESTING.md).

## Honest scope
Off-chain verifier (Zcash has no contracts): the gateway is trusted, its state anchored. Single-party setup. Testnet only. Built on null-402 / near-null-402 (same author).
