pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

/*
 * null-402 payment circuit, ported to NEAR (near-null-402). One change: the leaf is
 * Poseidon(Poseidon(noteSecret, nullifierSecret), noteValue), see below.
 *
 * Proves, in zero knowledge:
 *   "I know the secret to an unspent note that is a leaf in the Pool's Poseidon
 *    Merkle tree (public root), whose value >= requiredAmount, and I reveal
 *    exactly one nullifier for it, bound to payTo and contextHash."
 *
 * PUBLIC SIGNAL ORDER (must match PaymentPublicSignals in null-402-sdk and the
 * verifier contract's public_inputs):
 *   [0] nullifier       Poseidon(nullifierSecret) — one-time spend tag
 *   [1] merkleRoot      Pool commitment root
 *   [2] payTo           recipient binding
 *   [3] requiredAmount  price tier (noteValue >= requiredAmount)
 *   [4] contextHash     request binding (method+path+price+payTo+nonce)
 */

// hash = Poseidon(left, right)
template HashLeftRight() {
    signal input left;
    signal input right;
    signal output hash;
    component h = Poseidon(2);
    h.inputs[0] <== left;
    h.inputs[1] <== right;
    hash <== h.out;
}

// Order a pair by a boolean selector s (0 => keep, 1 => swap).
template DualMux() {
    signal input in[2];
    signal input s;
    signal output out[2];
    s * (1 - s) === 0;                       // s is boolean
    out[0] <== (in[1] - in[0]) * s + in[0];
    out[1] <== (in[0] - in[1]) * s + in[1];
}

// Verify `leaf` is in the tree with the given `root` via the Merkle path.
template MerkleTreeChecker(levels) {
    signal input leaf;
    signal input root;
    signal input pathElements[levels];
    signal input pathIndices[levels];        // 0 = current node is left child

    component selectors[levels];
    component hashers[levels];

    for (var i = 0; i < levels; i++) {
        selectors[i] = DualMux();
        selectors[i].in[0] <== i == 0 ? leaf : hashers[i - 1].hash;
        selectors[i].in[1] <== pathElements[i];
        selectors[i].s <== pathIndices[i];

        hashers[i] = HashLeftRight();
        hashers[i].left <== selectors[i].out[0];
        hashers[i].right <== selectors[i].out[1];
    }

    root === hashers[levels - 1].hash;
}

template Payment(levels) {
    // ── private witness ────────────────────────────────────────────────────────
    signal input noteSecret;
    signal input nullifierSecret;
    signal input noteValue;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // ── public signals (declaration order = public.json order) ──────────────────
    signal input nullifier;
    signal input merkleRoot;
    signal input payTo;
    signal input requiredAmount;
    signal input contextHash;

    // near-null-402 change from null-402: the leaf binds the value the contract itself saw.
    // secretHash = Poseidon(noteSecret, nullifierSecret) is what the depositor submits; the NEAR
    // contract computes leaf = Poseidon(secretHash, value) from the NEAR actually attached, so a
    // note can never claim more than was deposited (null-402 trusted the depositor's commitment).
    component sh = Poseidon(2);
    sh.inputs[0] <== noteSecret;
    sh.inputs[1] <== nullifierSecret;
    component commit = Poseidon(2);
    commit.inputs[0] <== sh.out;
    commit.inputs[1] <== noteValue;

    // nullifier = Poseidon(nullifierSecret) — unique per note, reveals nothing
    component nh = Poseidon(1);
    nh.inputs[0] <== nullifierSecret;
    nullifier === nh.out;

    // note is a member of the committed tree
    component tree = MerkleTreeChecker(levels);
    tree.leaf <== commit.out;
    tree.root <== merkleRoot;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }

    // noteValue >= requiredAmount (64-bit range)
    component ge = GreaterEqThan(64);
    ge.in[0] <== noteValue;
    ge.in[1] <== requiredAmount;
    ge.out === 1;

    // bind payTo + contextHash into the proof (anti-tamper; keeps them in the
    // constraint system so a valid proof can't be lifted to a different
    // recipient or request)
    signal payToSq;
    signal ctxSq;
    payToSq <== payTo * payTo;
    ctxSq <== contextHash * contextHash;
}

// 20-level tree → up to ~1M notes. Public inputs in SDK signal order.
component main {public [nullifier, merkleRoot, payTo, requiredAmount, contextHash]} = Payment(20);
