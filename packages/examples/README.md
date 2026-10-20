# examples

- `run-live` — the live testnet run (resumable; state in `.demo/run-state.json`): one shielded deposit
  for 22 notes, claimed once, 20 paid calls, then the two fixture notes pay and are used for the
  attacks (replay, changed amount and nullifier, another request's proof, a second claim, altered
  note values), and the gateway anchors its state. Writes `deployments/testnet.json`.
- `demo` — the video: a fresh gateway claims the real deposit through its viewing key, two calls are
  paid with proofs, a replay and a tamper are refused, and the anchor is re-read on testnet.

```sh
CARGO_TARGET_DIR=<where packages/scan is built> Z402_FUNDER_WALLET=<zingo data dir of a funded demo wallet> pnpm --filter @z402/examples run-live
pnpm --filter @z402/examples demo
```
