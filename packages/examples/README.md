# examples

- `run-live` — the Oct 20 live testnet run (resumable; state in `.demo/run-state.json`): one shielded
  deposit for 22 notes, claimed once, 20 paid calls, then the two fixture notes pay and are used for
  the attacks (replay, changed amount and nullifier, another request's proof, a second claim, altered
  note values), and the gateway anchors its state. Writes `deployments/testnet.json`.
- `pass2` — the Oct 22 live run of the current protocol (resumable; `.demo/pass2/`): a fresh gateway
  with auto-anchoring and a new anchor signing key, two deposits, paid calls through `Z402Client` with
  the default 2,880-block window, a proxy naming an older anchor, then a competing signed anchor that
  clients refuse. Uses the demo wallets from `run-live`. Writes `deployments/testnet-pass2.json`.
- `demo` — no transaction: the shipped client against a fresh gateway that claims the Oct 20 deposit
  and adopts its anchor. The default window refuses it (`ANCHOR_TOO_OLD`), a dishonest root is
  `UNANCHORED_ROOT`, and two fixture-note calls pay under an explicitly widened window. About 10 s.

```sh
CARGO_TARGET_DIR=<where packages/scan is built> Z402_FUNDER_WALLET=<zingo data dir of a funded demo wallet> pnpm --filter @z402/examples run-live
pnpm --filter @z402/examples pass2
pnpm --filter @z402/examples demo
```
