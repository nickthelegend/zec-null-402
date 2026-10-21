# landing

One static page (`index.html`, no build). Ticket-stub layout: a centred launch hero with the deposit
as one perforated pass, then a horizontal rail of the 22 real tickets (nullifier and proof time of
each call, from `deployments/testnet.json`), the run in numbers, how it works, the voided attempts,
the Oct 21 fixes, the agent run and the conditions (limits). Plus Jakarta Sans and Azeret Mono.

The only motion: the tickets tear off the pass once when the rail comes into view (off with
`prefers-reduced-motion`; shown after 2.5 s regardless). 375 px without horizontal page scroll.

```sh
python3 -m http.server 5395 --bind 127.0.0.1   # from this folder
```
