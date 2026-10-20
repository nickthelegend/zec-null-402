# circuits — `Payment(20)`

The near-null-402 circuit (null-402's Payment with the leaf bound to the note value), copied (same
author, MIT) with **this repo's own** single-party Groth16 setup (`scripts/build.sh`, vk sha256
`8e7fa586…7cd0e3`). Leaf = `Poseidon(Poseidon(noteSecret, nullifierSecret), value)`; public signals
`[nullifier, merkleRoot, payTo, requiredAmount, contextHash]`; 11,920 constraints.

The library builds notes, the 20-level Poseidon tree and proofs, and verifies proofs off-chain
(snarkjs) — the gateway does that, because Zcash has no contracts. `depositCommitment(notes)` is the
memo commitment that lets one shielded deposit fund many notes.

Tests (`pnpm test`, 5): real proofs; tampered public inputs fail; no witness above the note value or
outside the tree; deposit commitments bind every note and value; context per nonce.
