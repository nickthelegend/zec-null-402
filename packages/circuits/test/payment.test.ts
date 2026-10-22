// Real Groth16 proofs with this repo's own Payment(20) setup; no chain involved.
import { describe, expect, it } from 'vitest';
import { commitmentOf, contextHash, depositCommitment, leafFromItem, leafOf, newNote, nullifierOf, provePayment, R, secretHash, Tree, verificationKey, verifyOffChain } from '../src/index.js';

describe('Payment(20)', () => {
  it('a note in the tree pays: the proof verifies and exposes only nullifier, root, payTo, amount, context', async () => {
    const notes = [newNote(30n), newNote(20n), newNote(50n)];
    const tree = await Tree.build(await Promise.all(notes.map(leafOf)));
    const { proof, publicSignals, signals } = await provePayment(notes[1], 1, tree, 777n, 20n, 99n);
    expect(await verifyOffChain(publicSignals, proof)).toBe(true);
    expect(signals).toEqual({ nullifier: (await nullifierOf(notes[1])).toString(), merkle_root: tree.root.toString(), pay_to: '777', required_amount: '20', context_hash: '99' });
    for (const secret of [notes[1].noteSecret, notes[1].nullifierSecret, await secretHash(notes[1])]) expect(publicSignals).not.toContain(secret.toString());
  }, 60_000);

  it('a tampered payTo, amount or context does not verify', async () => {
    const note = newNote(20n);
    const tree = await Tree.build([await leafOf(note)]);
    const { proof, publicSignals } = await provePayment(note, 0, tree, 5n, 20n, 6n);
    for (const i of [2, 3, 4]) {
      const bad = [...publicSignals];
      bad[i] = String(BigInt(bad[i]) + 1n);
      expect(await verifyOffChain(bad, proof)).toBe(false);
    }
  }, 60_000);

  it('no proof exists above the note value or for a note outside the tree', async () => {
    const note = newNote(20n);
    const tree = await Tree.build([await leafOf(note)]);
    await expect(provePayment(note, 0, tree, 5n, 21n, 6n)).rejects.toThrow();
    await expect(provePayment(newNote(20n), 0, tree, 5n, 20n, 6n)).rejects.toThrow();
  }, 60_000);

  it('deposit commitments bind every note and value; credited leaves equal the notes’ leaves', async () => {
    const notes = [newNote(10n), newNote(10n), newNote(25n)];
    const d = await depositCommitment(notes);
    expect(d.commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(commitmentOf(d.items)).toBe(d.commitment);
    expect(commitmentOf([{ ...d.items[0], value: '11' }, ...d.items.slice(1)])).not.toBe(d.commitment);
    expect(commitmentOf(d.items.slice(1))).not.toBe(d.commitment);
    expect(await Promise.all(d.items.map(leafFromItem))).toEqual(await Promise.all(notes.map(leafOf)));
  });

  it('the verification key is read once per process, and stays usable for every later check', async () => {
    expect(verificationKey()).toBe(verificationKey());
    const note = newNote(10n);
    const tree = await Tree.build([await leafOf(note)]);
    const { proof, publicSignals } = await provePayment(note, 0, tree, 5n, 10n, 6n);
    for (let i = 0; i < 3; i++) expect(await verifyOffChain(publicSignals, proof)).toBe(true);
    expect(await verifyOffChain([publicSignals[0], publicSignals[1], '6', publicSignals[3], publicSignals[4]], proof)).toBe(false);
    expect(await verifyOffChain(publicSignals, proof)).toBe(true);
  }, 60_000);

  it('context hashes differ per nonce and stay below the field modulus', () => {
    const a = contextHash('GET', '/api/quote', 25n, 1n, 'aa');
    expect(a).not.toBe(contextHash('GET', '/api/quote', 25n, 1n, 'ab'));
    expect(a < R).toBe(true);
  });
});
