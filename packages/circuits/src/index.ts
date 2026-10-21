// null-402 notes, tree and proofs (copied from near-null-402, same author, MIT). The gateway verifies
// proofs off-chain: Zcash has no contracts.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPoseidon } from 'circomlibjs';
import * as snarkjs from 'snarkjs';

export const LEVELS = 20;
export const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const BUILD = resolve(import.meta.dirname, '../build');
export const WASM = resolve(BUILD, 'payment.wasm');
export const ZKEY = resolve(BUILD, 'payment_final.zkey');
export const VKEY = resolve(BUILD, 'verification_key.json');

let P: Awaited<ReturnType<typeof buildPoseidon>> | null = null;
async function H(...xs: bigint[]): Promise<bigint> {
  P ??= await buildPoseidon();
  return BigInt(P.F.toString(P(xs)));
}

const rand248 = () => BigInt('0x' + randomBytes(31).toString('hex'));

export interface Note {
  noteSecret: bigint;
  nullifierSecret: bigint;
  /** value in gateway units (1 unit = unitZat zatoshi; 1,000 in the live run) */
  value: bigint;
}

export const newNote = (value: bigint): Note => ({ noteSecret: rand248(), nullifierSecret: rand248(), value });
/** What the depositor submits: Poseidon(noteSecret, nullifierSecret). */
export const secretHash = (n: Note) => H(n.noteSecret, n.nullifierSecret);
/** The leaf the gateway computes for a credited note: Poseidon(secretHash, value). */
export const leafOf = async (n: Note) => H(await secretHash(n), n.value);
export const nullifierOf = (n: Note) => H(n.nullifierSecret);

/** sha256(bytes)[..31] as a field element (248 bits, always below the BN254 modulus). */
export function fieldOfSha256(data: Uint8Array | string): bigint {
  return BigInt('0x' + createHash('sha256').update(data).digest('hex').slice(0, 62));
}


/** Request binding: method, path, price, payTo and a server nonce. */
export const contextHash = (method: string, path: string, price: bigint, payTo: bigint, nonce: string) =>
  fieldOfSha256(`zec-null-402:v1:${method.toUpperCase()}:${path}:${price}:${payTo}:${nonce}`);

/** The pool's Merkle tree, rebuilt from its leaves (zero leaf 0, zeros[i+1] = H(zeros[i], zeros[i])). */
export class Tree {
  private constructor(readonly levels: bigint[][], readonly zeros: bigint[]) {}

  static async build(leaves: bigint[], depth = LEVELS): Promise<Tree> {
    const zeros = [0n];
    for (let i = 0; i < depth; i++) zeros.push(await H(zeros[i], zeros[i]));
    const levels: bigint[][] = [leaves.slice()];
    for (let d = 0; d < depth; d++) {
      const cur = levels[d];
      const next: bigint[] = [];
      for (let i = 0; i < cur.length; i += 2) next.push(await H(cur[i], i + 1 < cur.length ? cur[i + 1] : zeros[d]));
      levels.push(next);
    }
    return new Tree(levels, zeros);
  }

  get root(): bigint {
    return this.levels[this.levels.length - 1][0] ?? this.zeros[this.zeros.length - 1];
  }

  path(index: number): { pathElements: bigint[]; pathIndices: number[] } {
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    let i = index;
    for (let d = 0; d < this.levels.length - 1; d++) {
      const sib = i ^ 1;
      pathElements.push(this.levels[d][sib] ?? this.zeros[d]);
      pathIndices.push(i & 1);
      i >>= 1;
    }
    return { pathElements, pathIndices };
  }
}

export interface PaymentPublic {
  nullifier: string;
  merkle_root: string;
  pay_to: string;
  required_amount: string;
  context_hash: string;
}

export async function provePayment(note: Note, leafIndex: number, tree: Tree, payTo: bigint, requiredAmount: bigint, ctx: bigint) {
  const { pathElements, pathIndices } = tree.path(leafIndex);
  const input = {
    noteSecret: note.noteSecret.toString(),
    nullifierSecret: note.nullifierSecret.toString(),
    noteValue: note.value.toString(),
    pathElements: pathElements.map(String),
    pathIndices: pathIndices.map(String),
    nullifier: (await nullifierOf(note)).toString(),
    merkleRoot: tree.root.toString(),
    payTo: payTo.toString(),
    requiredAmount: requiredAmount.toString(),
    contextHash: ctx.toString(),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  const [nullifier, merkle_root, pay_to, required_amount, context_hash] = publicSignals as string[];
  return { proof, publicSignals: publicSignals as string[], signals: { nullifier, merkle_root, pay_to, required_amount, context_hash } as PaymentPublic };
}

export const verificationKey = () => JSON.parse(readFileSync(VKEY, 'utf8')) as object;
export const verifyOffChain = (publicSignals: string[], proof: object) => snarkjs.groth16.verify(verificationKey(), publicSignals, proof);

/**
 * One shielded deposit can fund many notes. The deposit memo is `z402:<commitment>`, where the
 * commitment is sha256 over the notes' secret hashes and values, so the gateway credits exactly those
 * notes (and their values must add up to at most the deposit).
 */
export async function depositCommitment(notes: Note[]): Promise<{ commitment: string; items: { secretHash: string; value: string }[] }> {
  const items = await Promise.all(notes.map(async (n) => ({ secretHash: (await secretHash(n)).toString(), value: n.value.toString() })));
  return { commitment: commitmentOf(items), items };
}

export const commitmentOf = (items: { secretHash: string; value: string }[]) =>
  createHash('sha256').update(`zec-null-402:v1:deposit:${items.map((i) => `${i.secretHash}:${i.value}`).join(',')}`).digest('hex');

/** Leaf for a credited note, as the gateway computes it from a deposit item. */
export const leafFromItem = (i: { secretHash: string; value: string }) => H(BigInt(i.secretHash), BigInt(i.value));
