// The client's judgement of the anchors it finds on the anchor address (no network: the anchors here are
// built and signed in the test, the leaves are real Poseidon leaves). Every anchor of the gateway in the
// window must sit on the one leaf history the gateway serves, and the client proves against the newest of
// them, whichever one the gateway named.
import { describe, expect, it } from 'vitest';
import { leafFromItem, Tree } from '@z402/circuits';
import { anchorSigner, newAnchorSeed, nullifierSetHash, type ScannedAnchor } from '@z402/gateway';
import { AnchorRefusedError, pickAnchor } from '../src/index.js';

const signer = anchorSigner(newAnchorSeed());
const other = anchorSigner(newAnchorSeed());
const leavesOf = async (n: number, salt = 'a') => Promise.all(Array.from({ length: n }, async (_, i) => (await leafFromItem({ secretHash: `${salt.charCodeAt(0)}00${i + 1}`, value: '10' })).toString()));
const rootOf = async (l: string[]) => (await Tree.build(l.map(BigInt))).root.toString();
async function anchor(leaves: string[], n: number, height: number, by: typeof signer | null, txid: string): Promise<ScannedAnchor> {
  const m = { leaves: n, root: await rootOf(leaves.slice(0, n)), nullifiers: 0, nullifierHash: nullifierSetHash([]) };
  return { txid, height, ...m, ...(by ? { signature: by.sign(m) } : {}) };
}
const code = (p: Promise<unknown>) => p.then(() => 'paid', (e) => (e instanceof AnchorRefusedError ? e.code : `other: ${(e as Error).message}`));

describe('pickAnchor', () => {
  it('two anchors on one history: the newest is used even when the gateway named the older one', async () => {
    const l = await leavesOf(5);
    const a3 = await anchor(l, 3, 100, signer, '3'.repeat(64));
    const a5 = await anchor(l, 5, 110, signer, '5'.repeat(64));
    const r = await pickAnchor({ named: a3, window: [a3, a5], leaves: l, anchorPubkey: signer.publicKey });
    expect(r).toMatchObject({ txid: a5.txid, leaves: 5, root: a5.root, height: 110 });
  });

  it('a second signed anchor with a different root (a root made for another client): ANCHOR_COMPETING, whichever one is named', async () => {
    const mine = await leavesOf(4);
    const theirs = [...mine.slice(0, 3), (await leavesOf(1, 'z'))[0]];
    const a = await anchor(mine, 4, 100, signer, 'a'.repeat(64));
    const b = await anchor(theirs, 4, 101, signer, 'b'.repeat(64));
    expect(await code(pickAnchor({ named: a, window: [a, b], leaves: mine, anchorPubkey: signer.publicKey }))).toBe('ANCHOR_COMPETING');
    expect(await code(pickAnchor({ named: b, window: [b, a], leaves: mine, anchorPubkey: signer.publicKey }))).toBe('ANCHOR_COMPETING');
    // an unsigned deployment, read by a client with no key: two unsigned roots for 4 leaves
    const ua = await anchor(mine, 4, 100, null, 'c'.repeat(64));
    const ub = await anchor(theirs, 4, 101, null, 'd'.repeat(64));
    expect(await code(pickAnchor({ named: ua, window: [ua, ub], leaves: mine }))).toBe('ANCHOR_COMPETING');
  });

  it('an anchor for more leaves than the gateway serves: ANCHOR_COMPETING', async () => {
    const l = await leavesOf(6);
    const a = await anchor(l, 4, 100, signer, 'a'.repeat(64));
    const b = await anchor(l, 6, 101, signer, 'b'.repeat(64));
    expect(await code(pickAnchor({ named: a, window: [a, b], leaves: l.slice(0, 5), anchorPubkey: signer.publicKey }))).toBe('ANCHOR_COMPETING');
  });

  it('with a pinned key, memos anyone else sent to the published anchor address are ignored; without one, unsigned memos count and signed ones belong to a gateway whose key the client did not pin', async () => {
    const l = await leavesOf(3);
    const a = await anchor(l, 3, 100, signer, 'a'.repeat(64));
    const junk = await anchor(await leavesOf(3, 'q'), 3, 105, other, 'c'.repeat(64));
    const unsigned = await anchor(await leavesOf(3, 'r'), 3, 106, null, 'd'.repeat(64));
    expect(await pickAnchor({ named: a, window: [a, junk, unsigned], leaves: l, anchorPubkey: signer.publicKey })).toMatchObject({ txid: a.txid });
    // no key pinned: an unsigned deployment (like the Oct 20 one)
    const u = await anchor(l, 3, 100, null, 'e'.repeat(64));
    expect(await pickAnchor({ named: u, window: [u, junk], leaves: l })).toMatchObject({ txid: u.txid });
    expect(await code(pickAnchor({ named: u, window: [u, junk, unsigned], leaves: l }))).toBe('ANCHOR_COMPETING');
    // a signed anchor named to a client that pinned no key: Setup required, never accepted unchecked
    await expect(pickAnchor({ named: a, window: [a], leaves: l })).rejects.toThrow(/^Setup required: Z402_ANCHOR_PUBKEY/);
  });

  it('with a pinned key the named anchor must be signed by it: ANCHOR_BAD_SIGNATURE', async () => {
    const l = await leavesOf(3);
    const forged = await anchor(l, 3, 100, other, 'a'.repeat(64));
    const unsigned = await anchor(l, 3, 100, null, 'b'.repeat(64));
    for (const named of [forged, unsigned]) expect(await code(pickAnchor({ named, window: [named], leaves: l, anchorPubkey: signer.publicKey }))).toBe('ANCHOR_BAD_SIGNATURE');
  });
});
