# scan

`zpay-verify` (Rust), copied unchanged in behaviour from [zec-payment-verify-sdk](https://github.com/nickthelegend/zec-payment-verify-sdk) `packages/core` (same author, MIT). The gateway uses it to check deposits, and the tests use it to read the anchor, with incoming viewing keys: `ZPV_UIVK=… zpay-verify verify <txid> --amount <zat> --memo <memo>`.
