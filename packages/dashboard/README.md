# dashboard

The run record, as ticket stubs: the deposit as one perforated pass (with a punch per spent note),
the run in numbers, a rail of the 22 spent tickets (pick one to read its stub: full nullifier,
request, answer, price, proof time), who sees what, the voided attempts with the gateway's own
codes, the Oct 21 fixes, the LLM agent's 23 MCP calls as a receipt roll, and the anchor memo with
the nullifier-set hash recomputed in the browser ("Setup required" where Web Crypto is missing).
All data comes from `deployments/testnet.json` and `deployments/agent-run-2026-10-20.jsonl`.

```sh
pnpm --filter @z402/dashboard dev   # http://localhost:5183
```

Plus Jakarta Sans + Azeret Mono on mint; 375 px without horizontal page scroll; reduced motion respected.
