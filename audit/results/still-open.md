# Still open

- API-DEPOSITS-503-MAX-SCANS — FAIL. Left for a later re-run.
- MCP-DEPOSIT-SETUP-REQUIRED-WALLET — UNTESTED, but the expected cell is the concrete error "Setup required: Z402_WALLET".
- MCP-DEPOSIT-REFUSED-MAX-CAP — UNTESTED, but the expected cell is the concrete refusal above Z402_MAX_DEPOSIT_ZAT.
- MCP-DEPOSIT-REFUSED-TOTAL-BUDGET — UNTESTED, but the expected cell is the concrete refusal above Z402_MAX_TOTAL_DEPOSIT_ZAT.
- MCP-CLAIM-SUCCESS — UNTESTED, but the expected cell is a claim of the already mined Oct 20 deposit (first 0, count 22, recorded root).
- MCP-CLAIM-409-ALREADY-CLAIMED — UNTESTED, but the expected cell is the concrete error matching /already claimed/.

No other id is outside PASS and UNTESTED. No id is absent from both a PASS row and a real evidence file. MCP-DEPOSIT-UNTESTED-FUNDED and MCP-CLAIM-WAIT-UNTESTED-FUNDED stay UNTESTED; their expected cell is the sentence "Later audit marks UNTESTED".
