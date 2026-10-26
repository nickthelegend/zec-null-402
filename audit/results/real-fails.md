# Real Remaining Fails

The following 4 table rows remain FAIL in AUDIT.md (none are UI- rows, which are all 100% PASS):

## 1. API-DEPOSITS-503-MAX-SCANS
- **Expected**: HTTP 503 with JSON error matching `/busy: .* deposit checks are running/` and header `retry-after: 5`.
- **Actual**: Server returned HTTP 503 (`busy: 4 deposit checks are running; try again shortly`) with `retry-after: 5` as expected, but the initial audit runner failed on Chrome's console line `Failed to load resource: the server responded with a status of 503 (Service Unavailable)`.

## 2. API-CLIENT-REFUSAL-UNANCHORED-ROOT
- **Expected**: `Z402Client.pay` rejects with `AnchorRefusedError` having code `"UNANCHORED_ROOT"` before making a proof; no nullifier burned.
- **Actual**: Client payment rejected with `SetupRequiredError: "Setup required: Z402_ANCHOR_UIVK (the anchor address's published viewing key; the client proves only against roots it has read on-chain)"`.

## 3. MCP-PAY-REFUSED-UNANCHORED-ROOT
- **Expected**: `isError: true` with text matching `/^refusing to pay: UNANCHORED_ROOT/`.
- **Actual**: `isError: true` with text: `"no unspent note of exactly 10 units (a note pays one call of its full value)"`.

## 4. DOC-README-OCT20-ANCHOR-FACTS
- **Expected**: Cites anchor txid `a09922378bb7d404c31ac9226fee2de5664a920483d714b1b811647717501395`, block height 4,522,706, 22 leaves and 22 nullifiers, matching `deployments/testnet.json`.
- **Actual**: README cites anchor txid `a09922378bb7d404c31ac9226fee2de5664a920483d714b1b811647717501395`, "22 leaves, 22 spent", and block 4522706. `deployments/testnet.json` anchor.txid matches, leaves is 22, and nullifiers is 22, but that file has no anchor height. Block 4522706 is not in `deployments/testnet.json`, so the cited height does not match the file.
