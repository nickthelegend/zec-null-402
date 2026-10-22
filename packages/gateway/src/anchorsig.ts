// Signed anchors. The anchor address's viewing key is published so anyone can read anchors, which also
// means anyone can send a z402:anchor memo to it. The gateway signs each anchor with an Ed25519 key whose
// public half clients pin (Z402_ANCHOR_PUBKEY), so an anchor is attributable to the gateway: a second,
// conflicting signed anchor is evidence against it, and memos from anyone else are ignored.
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { SetupRequiredError, type AnchorMemo } from './scan.js';

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** What the signature covers: every field of the anchor, under a domain tag. */
export const anchorSignedText = (m: AnchorMemo) => `zec-null-402:v1:anchor:${m.leaves}:${m.root}:${m.nullifiers}:${m.nullifierHash}`;

/** A fresh 32-byte Ed25519 seed (hex), for Z402_ANCHOR_SIGNING_KEY. */
export const newAnchorSeed = () => randomBytes(32).toString('hex');

/** The gateway's signer from its seed (Z402_ANCHOR_SIGNING_KEY, 64 hex). The seed is never echoed. */
export function anchorSigner(seedHex: string): { publicKey: string; sign: (m: AnchorMemo) => string } {
  if (!/^[0-9a-f]{64}$/.test(seedHex)) throw new SetupRequiredError('Z402_ANCHOR_SIGNING_KEY', 'an Ed25519 seed as 64 lowercase hex characters');
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  return { publicKey, sign: (m) => sign(null, Buffer.from(anchorSignedText(m)), key).toString('hex') };
}

/** True only for a memo signed by `publicKeyHex` (64 hex) over exactly these fields. */
export function verifyAnchorSignature(publicKeyHex: string, m: AnchorMemo): boolean {
  if (!m.signature || !/^[0-9a-f]{64}$/.test(publicKeyHex)) return false;
  try {
    const pub = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(anchorSignedText(m)), pub, Buffer.from(m.signature, 'hex'));
  } catch {
    return false;
  }
}
