#!/usr/bin/env bash
# Compiles Payment(20) and runs a local Groth16 setup: powers of tau (2^14) with a random local
# contribution, then a circuit-specific contribution. This is a single-party trusted setup by the
# builder (documented in packages/docs); anyone can re-run it, and the vk hash is printed.
set -euo pipefail
cd "$(dirname "$0")/.."
SNARKJS=node_modules/.bin/snarkjs
mkdir -p build
circom circuits/payment.circom --r1cs --wasm --sym -o build >/dev/null
$SNARKJS r1cs info build/payment.r1cs | grep -E "Constraints|Public|Private" || true
if [ ! -f build/pot14_final.ptau ]; then
  $SNARKJS powersoftau new bn128 14 build/pot14_0.ptau >/dev/null
  $SNARKJS powersoftau contribute build/pot14_0.ptau build/pot14_1.ptau --name="local" -e="$(head -c 64 /dev/urandom | base64)" >/dev/null
  $SNARKJS powersoftau prepare phase2 build/pot14_1.ptau build/pot14_final.ptau >/dev/null
  rm -f build/pot14_0.ptau build/pot14_1.ptau
fi
$SNARKJS groth16 setup build/payment.r1cs build/pot14_final.ptau build/payment_0.zkey >/dev/null
$SNARKJS zkey contribute build/payment_0.zkey build/payment_final.zkey --name="z402" -e="$(head -c 64 /dev/urandom | base64)" >/dev/null
rm -f build/payment_0.zkey
$SNARKJS zkey export verificationkey build/payment_final.zkey build/verification_key.json >/dev/null
cp build/payment_js/payment.wasm build/payment.wasm
echo "vk sha256 $(shasum -a 256 build/verification_key.json | cut -d' ' -f1)"
