# scan

`zpay-verify` (Rust), copied unchanged in behaviour from [zec-payment-verify-sdk](https://github.com/nickthelegend/zec-payment-verify-sdk) `packages/core` (same author, MIT). The verifier and solver use it to check funding, fills, releases, refunds and anchors with incoming viewing keys: `ZPV_UIVK=… zpay-verify verify <txid> --amount <zat> --memo <memo>`.
