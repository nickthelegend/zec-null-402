// zec-null-402 client: plan a deposit of N notes, claim it after the shielded deposit is mined, then
// pay per call with a zero-knowledge proof of one unspent note. Note secrets live in a 0600 file.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { depositCommitment, leafOf, newNote, nullifierOf, provePayment, Tree, type Note } from '@z402/circuits';

export interface StoredNote {
  noteSecret: string;
  nullifierSecret: string;
  value: string;
  /** leaf index once the deposit is claimed */
  index: number | null;
  deposit: string;
  nullifier: string;
  spent: boolean;
}

interface NotesFile {
  type: 'zec-null-402-notes';
  gateway: string;
  plans: Record<string, { commitment: string; units: string; items: { secretHash: string; value: string }[]; txid: string | null }>;
  notes: StoredNote[];
}

export class GatewayError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class Z402Client {
  constructor(readonly gateway: string, readonly notesPath: string) {}

  private read(): NotesFile {
    if (!existsSync(this.notesPath)) return { type: 'zec-null-402-notes', gateway: this.gateway, plans: {}, notes: [] };
    const f = JSON.parse(readFileSync(this.notesPath, 'utf8')) as NotesFile;
    if (f.type !== 'zec-null-402-notes') throw new Error(`${this.notesPath} is not a zec-null-402 notes file`);
    return f;
  }

  private write(f: NotesFile) {
    writeFileSync(`${this.notesPath}.tmp`, JSON.stringify(f, null, 2), { mode: 0o600 });
    renameSync(`${this.notesPath}.tmp`, this.notesPath);
  }

  async get<T>(path: string, init?: RequestInit): Promise<T> {
    let r: Response;
    try {
      r = await fetch(this.gateway + path, init);
    } catch {
      throw new GatewayError(0, `Setup required: no gateway answering at ${this.gateway}`);
    }
    const b = (await r.json()) as T & { error?: string };
    if (!r.ok) throw new GatewayError(r.status, b.error ?? `HTTP ${r.status}`);
    return b;
  }

  info() {
    return this.get<{ depositUa: string; unitZat: number; payTo: string; prices: Record<string, string>; leaves: number; root: string; spent: number; anchors: unknown[] }>('/api/info');
  }

  /** Creates `count` notes of `value` units and returns what to send: address, zatoshi and memo. */
  async plan(count: number, value: bigint): Promise<{ plan: string; address: string; amountZat: bigint; memo: string }> {
    const info = await this.info();
    const notes: Note[] = Array.from({ length: count }, () => newNote(value));
    const d = await depositCommitment(notes);
    const f = this.read();
    f.plans[d.commitment] = { commitment: d.commitment, units: String(value * BigInt(count)), items: d.items, txid: null };
    for (const n of notes) f.notes.push({ noteSecret: n.noteSecret.toString(), nullifierSecret: n.nullifierSecret.toString(), value: n.value.toString(), index: null, deposit: d.commitment, nullifier: (await nullifierOf(n)).toString(), spent: false });
    this.write(f);
    return { plan: d.commitment, address: info.depositUa, amountZat: value * BigInt(count) * BigInt(info.unitZat), memo: `z402:${d.commitment}` };
  }

  /** After the deposit tx is mined: the gateway credits the planned notes. */
  async claim(plan: string, txid: string): Promise<{ first: number; count: number; root: string }> {
    const f = this.read();
    const p = f.plans[plan];
    if (!p) throw new Error(`no deposit plan ${plan}`);
    const r = await this.get<{ first: number; count: number; root: string }>('/api/deposits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid, items: p.items }) });
    p.txid = txid;
    f.notes.filter((n) => n.deposit === plan).forEach((n, i) => (n.index = r.first + i));
    this.write(f);
    return r;
  }

  status() {
    const f = this.read();
    const unspent = f.notes.filter((n) => n.index !== null && !n.spent);
    return { notes: f.notes.length, credited: f.notes.filter((n) => n.index !== null).length, unspent: unspent.length, unspent_units: unspent.reduce((t, n) => t + BigInt(n.value), 0n).toString(), deposits: Object.values(f.plans).map((p) => ({ txid: p.txid, units: p.units })) };
  }

  /**
   * GET a paid URL; on 402, prove with an unspent note of exactly the price and retry.
   * Pays only challenges from this client's gateway, for the path it asked for, to the gateway's payTo:
   * otherwise a server could relay a challenge from the gateway and redeem the proof for its own request.
   */
  async pay(url: string): Promise<{ status: number; body: unknown; nullifier: string | null; proveMs: number }> {
    const target = new URL(url);
    const first = await fetch(url);
    if (first.status !== 402) return { status: first.status, body: await first.json(), nullifier: null, proveMs: 0 };
    const c = ((await first.json()) as { accepts?: { scheme: string; payTo: string; requiredAmount: string; contextHash: string; nonce: string; resource: string }[] }).accepts?.find((a) => a.scheme === 'zec-null-402');
    if (!c) throw new Error('402 without a zec-null-402 challenge');
    const origin = new URL(this.gateway).origin;
    if (target.origin !== origin) throw new Error(`refusing to pay ${target.origin}: this client pays only its gateway ${origin}`);
    if (c.resource !== target.pathname) throw new Error(`refusing to pay: the challenge is for ${c.resource}, the request was ${target.pathname}`);
    if (c.payTo !== (await this.info()).payTo) throw new Error('refusing to pay: the challenge payTo is not the gateway’s');
    const f = this.read();
    const pick = f.notes.find((n) => n.index !== null && !n.spent && n.value === c.requiredAmount);
    if (!pick) throw new Error(`no unspent note of exactly ${c.requiredAmount} units (a note pays one call of its full value)`);
    const { leaves } = await this.get<{ leaves: string[] }>('/api/leaves');
    const tree = await Tree.build(leaves.map(BigInt));
    const note: Note = { noteSecret: BigInt(pick.noteSecret), nullifierSecret: BigInt(pick.nullifierSecret), value: BigInt(pick.value) };
    if ((await leafOf(note)).toString() !== leaves[pick.index!]) throw new Error(`leaf ${pick.index} on the gateway is not this note's leaf`);
    const t0 = Date.now();
    const { proof, signals } = await provePayment(note, pick.index!, tree, BigInt(c.payTo), BigInt(c.requiredAmount), BigInt(c.contextHash));
    const proveMs = Date.now() - t0;
    const res = await fetch(url, { headers: { 'x-payment': Buffer.from(JSON.stringify({ nonce: c.nonce, proof, signals })).toString('base64') } });
    const body = await res.json();
    if (res.status === 200 || (body as { reason?: string }).reason === 'NULLIFIER_SPENT') {
      pick.spent = true;
      this.write(f);
    }
    return { status: res.status, body, nullifier: signals.nullifier, proveMs };
  }
}
