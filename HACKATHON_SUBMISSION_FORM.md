# zec-null-402 — submission draft (portfolio; DO NOT SUBMIT)

Zecathon allows one entry per team: Shielded x402.

**Name:** zec-null-402
**One line:** One shielded Zcash deposit, then pay-per-call with zero-knowledge proofs: no transaction per call, the gateway can't tell which note paid.
**Repo:** github.com/nickthelegend/zec-null-402 (to be created by Nick)

## Proof (Zcash testnet, Oct 20, 2026)
- Deposit `05c57a3b…` credited 22 notes (checked by the gateway's viewing key); 20 paid calls, 0 transactions; replay, tamper, wrong-request and double-claim refused; anchor `a0992237…` matches the gateway state.
- 18 tests (TESTING.md).

## Honest scope
Off-chain verifier (Zcash has no contracts): the gateway is trusted, its state anchored. Single-party setup. Testnet only. Built on null-402 / near-null-402 (same author).
