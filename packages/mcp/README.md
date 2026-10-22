# @z402/mcp — `z402-mcp`

Tools: `status` (read-only), `deposit` (plans N notes and sends one shielded deposit from the agent's
wallet; refused above `Z402_MAX_DEPOSIT_ZAT` for one deposit or `Z402_MAX_TOTAL_DEPOSIT_ZAT` for all of
a notes file's deposits together, sent or being sent, checked and reserved under the notes-file lock so
two deposits at once cannot both pass it; the txid is saved on the plan as soon as it is sent, and a plan the
wallet refused to fund is dropped), `claim` (waits up to `Z402_CLAIM_WAIT_SEC` for the deposit to be
mined), `pay` (fetches only `Z402_GATEWAY_URL`; proves only against an anchored root it reads on-chain;
waits up to `Z402_ANCHOR_WAIT_SEC`, default 900, polling every `Z402_ANCHOR_POLL_SEC`, when the notes are
newer than the latest anchor, or the anchor is too old or not yet confirmed). Env: `Z402_GATEWAY_URL`,
`Z402_NOTES_FILE`, `Z402_WALLET`, `Z402_MCP_LOG`, `Z402_ANCHOR_UIVK` (required by `pay`),
`Z402_ANCHOR_PUBKEY` (the gateway's anchor key, pinned), `Z402_MAX_ANCHOR_AGE_BLOCKS`, `Z402_LWD_URL`,
`Z402_REPLAY_AT_HEIGHT` (replays of a published run only). Malformed numbers are Setup required.

**Keep the call log private.** `Z402_MCP_LOG` gets one JSON line per call: deposit plans and txids, and
every payment's nullifier and time. That is exactly the link between a deposit and its calls that the
protocol hides from the gateway, so the log is created (or reset to) mode 0600; do not share it.

Tests (`pnpm test`, 9): against a fresh gateway that credits the real published deposit (testnet viewing-key check) and adopts the published anchor, with real proofs; `pay` without the anchor key is Setup required; `pay` keeps asking while the anchor is too old; the total deposit budget, also for two deposits at once through a local stand-in zingo-cli; the call log is 0600; malformed settings.
