# @z402/sdk

`Z402Client(gatewayUrl, notesFile)`: `plan(count, units)` (notes + the deposit to send),
`claim(plan, txid)`, `pay(url)` (proves with an unspent note of exactly the price, checks its leaf
against the gateway's; pays only challenges from its own gateway, for the requested path, to the
gateway's `payTo`), `status()`. Note secrets live in a 0600 JSON file and are never returned.

Tests (`pnpm test`, 6): `client.test.ts` 3 and `relay.test.ts` 3 (a real relay server in front of the gateway), against a fresh gateway that credits the real published deposit (testnet viewing-key check), with real proofs.
