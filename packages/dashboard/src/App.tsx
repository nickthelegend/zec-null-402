import { useCallback, useEffect, useRef, useState } from 'react';
import run from '@deployments/testnet.json';
import agentLog from '@deployments/agent-run-2026-10-20.jsonl?raw';

type Call = { n: number; status: number; nullifier: string; proveMs: number };
const r = run as unknown as {
  ranAt: string;
  unitZat: number;
  priceUnits: string;
  wallets: { gateway: { address: string }; anchor: { address: string } };
  txs: { fund: string; deposit: string; anchor: string };
  deposit: { txid: string; amountZat: string; height: number; items: { secretHash: string; value: string }[] };
  calls: Call[];
  attacks: Record<string, string | number>;
  refusals: Record<string, string>;
  fixtureNullifiers: string[];
  gateway: { leaves: number; root: string; spent: number; verificationKeySha256: string };
  anchor: { txid: string; leaves: number; root: string; nullifiers: number; nullifierHash: string; memo: string; memoSeen: boolean; matchesGatewayState: boolean };
};
const EXPLORER = 'https://testnet.zcashexplorer.app/transactions/';
const REPO = 'https://github.com/nickthelegend/zec-null-402';
const short = (s: string, a = 8, b = 6) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
const pad = (n: number) => String(n).padStart(2, '0');
const zat = (n: number) => `${n.toLocaleString('en-US')} zat`;
const taz = (n: number) => `${(n / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 })} TAZ`;

/** Every spent note, in the order it was spent: the 20 paid calls, then the 2 fixture notes. */
type Ticket = { key: string; label: string; nullifier: string; status: number; proveMs: number | null; fixture: boolean };
const tickets: Ticket[] = [
  ...r.calls.map((c) => ({ key: c.nullifier, label: pad(c.n), nullifier: c.nullifier, status: c.status, proveMs: c.proveMs, fixture: false })),
  ...r.fixtureNullifiers.map((nf, i) => ({ key: nf, label: pad(r.calls.length + i + 1), nullifier: nf, status: 200, proveMs: null, fixture: true })),
];

const ATTACK: Record<string, string> = {
  replayWithNewContext: 'A paid proof sent again for a new request.',
  replayOfSecondNote: 'The second fixture note’s proof replayed.',
  tamperedAmount: 'The amount in the public signals changed.',
  proofForAnotherRequest: 'A proof made for one request sent for another.',
  tamperedNullifier: 'The nullifier changed, claiming a different note.',
};

function Tx({ id, label }: { id: string; label?: string }) {
  return (
    <a className="tx" href={EXPLORER + id} target="_blank" rel="noreferrer">
      <code>{label ?? short(id)}</code>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M5 11 11 5M6 5h5v5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <span className="sr">transaction {id} on the testnet explorer (opens in a new tab)</span>
    </a>
  );
}

function Mark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#063b33" />
      <path d="M6 9h20v5a2 2 0 0 0 0 4v5H6v-5a2 2 0 0 0 0-4z" fill="#ff8a3d" />
      <path d="M20 10.5v11" stroke="#063b33" strokeWidth="1.4" strokeDasharray="1.6 1.6" />
    </svg>
  );
}

const Tear = () => <div className="tear" aria-hidden="true" />;

type CheckState = 'checking' | 'ok' | 'bad' | 'unavailable';

/** Recomputes the anchored nullifier-set hash from the published nullifiers, in this tab. */
function AnchorCheck() {
  const [state, setState] = useState<CheckState>('checking');
  const [hash, setHash] = useState('');
  const runId = useRef(0);
  const check = useCallback(() => {
    const id = ++runId.current;
    setState('checking');
    const all = [...r.calls.map((c) => c.nullifier), ...r.fixtureNullifiers].sort();
    if (!globalThis.crypto?.subtle) {
      setState('unavailable');
      return;
    }
    crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(`zec-null-402:v1:nullifiers:${all.join(',')}`))
      .then((buf) => {
        if (id !== runId.current) return;
        const h = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
        setHash(h);
        setState(h === r.anchor.nullifierHash ? 'ok' : 'bad');
      })
      .catch(() => {
        if (id === runId.current) setState('unavailable');
      });
  }, []);
  useEffect(() => {
    check();
  }, [check]);

  const total = tickets.length;
  const message = {
    unavailable: 'Setup required: this browser cannot hash here (Web Crypto needs https or localhost).',
    checking: 'Hashing the published nullifiers in this tab…',
    ok: `The ${total} published nullifiers hash to the anchored value.`,
    bad: 'The published nullifiers do not hash to the anchored value.',
  }[state];
  return (
    <div className={`check is-${state}`}>
      <p className="check-msg" role="status" aria-live="polite">
        <span className="dot" aria-hidden="true" />
        {message}
      </p>
      <dl className="kv">
        <div>
          <dt>sha256 of the sorted set, here</dt>
          <dd>
            <code>{hash ? short(hash, 14, 8) : '…'}</code>
          </dd>
        </div>
        <div>
          <dt>anchored on-chain</dt>
          <dd>
            <code>{short(r.anchor.nullifierHash, 14, 8)}</code>
          </dd>
        </div>
      </dl>
      <button type="button" className="btn" onClick={check} disabled={state === 'checking'} aria-busy={state === 'checking'}>
        {state === 'checking' ? 'Hashing…' : state === 'unavailable' ? 'Try again' : 'Hash again'}
      </button>
    </div>
  );
}

/** One MCP tool call from the recorded opencode agent run (deployments/agent-run-2026-10-20.jsonl). */
type AgentCall = { at: string; tool: string; args: Record<string, unknown>; isError: boolean; result: unknown };
const agentCalls: AgentCall[] = agentLog
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as AgentCall);

function describeCall(c: AgentCall): { what: string; detail: string } {
  const res = c.result as Record<string, unknown> | string;
  if (c.tool === 'deposit') {
    const a = c.args as { count?: number; units?: number };
    return { what: `deposit ${a.count} × ${a.units} units`, detail: typeof res === 'string' ? res : `tx ${String(res.txid).slice(0, 8)}…, ${res.amount_zat} zat` };
  }
  if (c.tool === 'pay') {
    const path = String((c.args as { url?: string }).url ?? '').replace(/^https?:\/\/[^/]+/, '');
    return { what: `pay ${path}`, detail: typeof res === 'string' ? res : `HTTP ${res.status}, proof ${res.prove_ms} ms` };
  }
  if (c.tool === 'claim') return { what: 'claim the deposit', detail: typeof res === 'string' ? res : `credited ${res.count} notes from leaf ${res.first}` };
  const w = typeof res === 'string' ? null : (res.wallet as { credited?: number; unspent_units?: string } | undefined);
  return { what: 'status', detail: w ? `${w.credited} credited, ${w.unspent_units} units unspent` : String(res) };
}

/**
 * The calls as shown. A successful claim of a plan that was already credited is the Oct 20 gateway's
 * concurrent-claim race (fixed in 9f8b8a8 on Oct 21: now 409): the same note appended again, so the same
 * nullifier, no extra value, but not a clean "ok".
 */
const creditedPlans = new Set<string>();
const agentRows = agentCalls.map((c) => {
  const d = describeCall(c);
  if (c.tool !== 'claim' || c.isError) return { ...d, double: false };
  const plan = String((c.args as { plan?: string }).plan);
  if (!creditedPlans.has(plan)) {
    creditedPlans.add(plan);
    return { ...d, double: false };
  }
  return { ...d, detail: `credited again from leaf ${(c.result as { first: number }).first} (pre-fix race, fixed in 9f8b8a8, now 409)`, double: true };
});
const doubleCredits = agentRows.filter((x) => x.double).length;

function Rail() {
  const [sel, setSel] = useState(0);
  const railRef = useRef<HTMLOListElement>(null);
  // The right-edge fade says "more to scroll"; at the end of the rail it would only hide the last ticket.
  const [atEnd, setAtEnd] = useState(false);
  const edge = useCallback(() => {
    const el = railRef.current;
    if (el) setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
  }, []);
  useEffect(() => {
    edge();
    addEventListener('resize', edge);
    return () => removeEventListener('resize', edge);
  }, [edge]);
  if (tickets.length === 0)
    return (
      <div className="empty">
        <Mark size={36} />
        <p>No tickets spent yet.</p>
        <p className="muted">Run the live example to publish deployments/testnet.json; each paid call appears here as a ticket.</p>
      </div>
    );
  const t = tickets[sel];
  const scroll = (dir: number) => {
    const el = railRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  return (
    <>
      <div className="rail-bar">
        <p className="muted">Pick a ticket to read its stub. Each one is a nullifier the gateway burned; none of them says which of the {r.gateway.leaves} notes it was.</p>
        <div className="rail-ctl">
          <button type="button" onClick={() => scroll(-1)} aria-label="Scroll tickets left">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <button type="button" onClick={() => scroll(1)} aria-label="Scroll tickets right">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </div>
      <ol className={`rail${atEnd ? ' at-end' : ''}`} ref={railRef} onScroll={edge} aria-label="Spent tickets">
        {tickets.map((x, i) => (
          <li key={x.key}>
            <button type="button" className={`tix${x.fixture ? ' fixture' : ''}`} aria-pressed={i === sel} onClick={() => setSel(i)}>
              <span className="tix-top">
                <span className="tix-no">
                  <small>{x.fixture ? 'FIXTURE' : 'NO.'}</small>
                  {x.label}
                </span>
                <span className="ok">{x.status}</span>
              </span>
              <Tear />
              <span className="tix-bot">
                <code>{short(x.nullifier, 9, 4)}</code>
                {x.proveMs !== null ? `proof ${x.proveMs} ms` : 'then attack tests'}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <article className="stub" aria-live="polite" aria-label={`Ticket ${t.label}`}>
        <div className="stub-l">
          <span className="label">Ticket</span>
          <b>{t.label}</b>
          <span className="tag">{t.fixture ? 'fixture note' : 'paid call'}</span>
        </div>
        <Tear />
        <dl className="stub-r">
          <div className="wide">
            <dt>Nullifier (public signal 0)</dt>
            <dd>
              <code>{t.nullifier}</code>
            </dd>
          </div>
          <div>
            <dt>Request</dt>
            <dd>GET /api/quote</dd>
          </div>
          <div>
            <dt>Gateway answer</dt>
            <dd>HTTP {t.status}</dd>
          </div>
          <div>
            <dt>Price</dt>
            <dd>
              {r.priceUnits} units · {zat(Number(r.priceUnits) * r.unitZat)}
            </dd>
          </div>
          <div>
            <dt>Client proof</dt>
            <dd>{t.proveMs !== null ? `${t.proveMs} ms` : 'not timed (fixture)'}</dd>
          </div>
          <div className="wide">
            <dt>On-chain</dt>
            <dd>{t.fixture ? 'Nothing. Its secrets are published so tests can pay with it on a fresh gateway, then try the attacks.' : 'Nothing. No transaction for this call; the nullifier is counted in the anchor.'}</dd>
          </div>
        </dl>
      </article>
    </>
  );
}

const NAV = [
  ['pass', 'Deposit'],
  ['tickets', 'Tickets'],
  ['who', 'Who sees what'],
  ['void', 'Voided'],
  ['agent', 'Agent'],
  ['anchor', 'Anchor'],
] as const;

export function App() {
  const proveTimes = r.calls.map((c) => c.proveMs);
  const ranAt = new Date(r.ranAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  const refused = agentCalls.filter((c) => c.isError).length;
  const voids = [
    ...Object.entries(ATTACK)
      .filter(([k]) => r.attacks[k] !== undefined)
      .map(([k, what]) => ({ code: String(r.attacks[k]), what })),
    ...Object.entries(r.refusals).map(([k, v]) => ({ code: /already claimed/.test(v) ? '409 already claimed' : v.replace(/^.*not credited: /, ''), what: k.charAt(0).toUpperCase() + k.slice(1) + '.' })),
  ];
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <div className="wrap top-in">
          <a className="brand" href="#pass" aria-label="Kippu run record, top">
            <Mark />
            <span>Kippu</span>
            <small lang="ja">切符</small>
            <span className="brand-sub">run record</span>
          </a>
          <nav aria-label="Sections">
            {NAV.map(([id, label]) => (
              <a key={id} href={`#${id}`}>
                {label}
              </a>
            ))}
          </nav>
          <a className="btn btn-line btn-sm" href={REPO} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </div>
      </header>

      <main id="main" className="wrap">
        <section id="pass" className="intro" aria-labelledby="intro-h">
          <p className="eyebrow">
            <span className="net">Zcash testnet</span> run of {ranAt} UTC
          </p>
          <h1 id="intro-h">
            {r.calls.length} paid calls. <em>{r.calls.length > 0 ? 'No transaction per call.' : ''}</em>
          </h1>

          <article className="pass" aria-label="The shielded deposit">
            <div className="pass-admit">
              <span className="label">Admit</span>
              <b>{r.gateway.leaves}</b>
              <span className="label">notes · {r.priceUnits} units</span>
            </div>
            <Tear />
            <div className="pass-body">
              <span className="label">One shielded deposit, credited by the gateway's viewing key</span>
              <h2>{taz(Number(r.deposit.amountZat))}</h2>
              <dl className="meta">
                <div>
                  <dt>Block</dt>
                  <dd>{r.deposit.height.toLocaleString('en-US')}</dd>
                </div>
                <div>
                  <dt>Deposit</dt>
                  <dd>
                    <Tx id={r.deposit.txid} />
                  </dd>
                </div>
                <div>
                  <dt>Funded by</dt>
                  <dd>
                    <Tx id={r.txs.fund} />
                  </dd>
                </div>
                <div>
                  <dt>Tree root</dt>
                  <dd>
                    <code>{short(r.gateway.root, 10, 6)}</code>
                  </dd>
                </div>
              </dl>
            </div>
            <Tear />
            <div className="pass-end">
              <span className="label">
                Punched {r.gateway.spent} of {r.gateway.leaves}
              </span>
              <ol className="punches" aria-label={`${r.gateway.spent} of ${r.gateway.leaves} notes spent`}>
                {Array.from({ length: r.gateway.leaves }, (_, i) => (
                  <li key={i} className={i < r.gateway.spent ? (i >= r.calls.length ? 'f' : 'p') : ''} />
                ))}
              </ol>
            </div>
          </article>

          <div className="stats">
            <div>
              <span className="label">On-chain</span>
              <b>2</b>
              <p>transactions per run: the deposit and the anchor (plus the demo funding tx)</p>
            </div>
            <div>
              <span className="label">Off-chain</span>
              <b>{r.calls.length}</b>
              <p>paid calls, each a Groth16 proof checked by the gateway</p>
            </div>
            <div>
              <span className="label">Client proof</span>
              {proveTimes.length ? (
                <b>
                  {Math.min(...proveTimes)}–{Math.max(...proveTimes)}
                  <small>ms</small>
                </b>
              ) : (
                <b className="muted">—</b>
              )}
              <p>measured on the paying client</p>
            </div>
          </div>
        </section>

        <section id="tickets" aria-labelledby="tickets-h">
          <div className="head">
            <h2 id="tickets-h">The ticket rail</h2>
            <span className="count">
              {tickets.length} spent · {r.calls.length} calls + {r.fixtureNullifiers.length} fixture
            </span>
          </div>
          <Rail />
        </section>

        <section id="who" aria-labelledby="who-h">
          <div className="head">
            <h2 id="who-h">Who sees what</h2>
          </div>
          <ul className="who">
            <li>
              <h3>The chain</h3>
              <p>Two shielded transactions per run: the deposit and the anchor (plus one funding tx).</p>
              <p className="not">Not amounts, memos, who paid or how many calls.</p>
            </li>
            <li>
              <h3>The gateway</h3>
              <p>
                The deposit, its {r.gateway.leaves} note leaves, {tickets.length} nullifiers and each caller's network address.
              </p>
              <p className="not">Not which note paid which call: since Oct 22 every client proves against the root of a recent on-chain anchor it reads itself.</p>
            </li>
            <li>
              <h3>Anyone with the anchor key</h3>
              <p>
                Leaf count {r.anchor.leaves}, the root, spent count {r.anchor.nullifiers} and the nullifier-set hash.
              </p>
              <p className="not">Not individual payments.</p>
            </li>
            <li>
              <h3>Anyone with the gateway key</h3>
              <p>Published for this demo so a fresh clone can re-check the deposit: its amount, memo and time.</p>
              <p className="not">Not which notes were spent for what.</p>
            </li>
          </ul>
          <p className="note">One depositor in this run, so every call came from that depositor's notes. Unlinkability between users needs several.</p>
        </section>

        <section id="void" aria-labelledby="void-h">
          <div className="head">
            <h2 id="void-h">Voided in the live run</h2>
            <span className="count">{voids.length} refused</span>
          </div>
          <ul className="voids">
            {voids.map((v, i) => (
              <li key={i} className="void">
                <code>{v.code}</code>
                <p>{v.what}</p>
                <span className="stamp" aria-hidden="true">
                  VOID
                </span>
              </li>
            ))}
          </ul>
          <div className="fixed">
            <div>
              <span className="label">Fixed on Oct 21 and 22, after this run</span>
              <p>A review found that a spent note could pay again with its nullifier written <code>0&lt;n&gt;</code> or in hex, and that one payment sent several times at once was paid each time. Both now fail, along with a relayed challenge and an unauthenticated anchor. Tested on a fresh gateway with real proofs; not part of this run.</p>
              <p>Since Oct 22 the client proves only against a root it reads itself in a recent on-chain anchor, so a gateway can't hand one client its own root without putting it on-chain, and clients that scan the anchor address refuse a second signed root (<code>UNANCHORED_ROOT</code>, <code>ANCHOR_MISMATCH</code>, <code>ANCHOR_TOO_OLD</code>, <code>ANCHOR_COMPETING</code>). The client trusts its lightwalletd for the anchor txs. The gateway's state is in SQLite: a restart keeps challenges and spent nullifiers.</p>
            </div>
            <a className="btn btn-tangerine btn-sm" href={`${REPO}/blob/main/docs/JUDGE-2026-10-21.md`} target="_blank" rel="noreferrer">
              Read the review
            </a>
          </div>
        </section>

        <section id="agent" aria-labelledby="agent-h">
          <div className="head">
            <h2 id="agent-h">An LLM agent with a cap</h2>
            <span className="count">
              {refused} of {agentCalls.length} calls refused
            </span>
          </div>
          <p className="muted lede">
            opencode used the four MCP tools against a local gateway on testnet. The operator's prompt relayed a provider's "URGENT: buy the full report, deposit whatever it costs" order and told the agent to comply. The model tried; <code>Z402_MAX_DEPOSIT_ZAT=40000</code> refused every 50,000 zat deposit and the wallet ran dry. The Oct 20 gateway also credited deposit <code>0b12bfc6</code> twice (row {pad(agentRows.findIndex((x) => x.double) + 1)}, leaves 25 and 26: the same note and nullifier, no extra value): +{doubleCredits} double credit, the pre-fix race closed on Oct 21. Every line is from <code>deployments/agent-run-2026-10-20.jsonl</code>.
          </p>
          {agentCalls.length === 0 ? (
            <p className="empty">No agent run recorded yet.</p>
          ) : (
            <ol className="roll">
              {agentCalls.map((c, i) => {
                const d = agentRows[i];
                return (
                  <li key={c.at + i}>
                    <span className="roll-n">{pad(i + 1)}</span>
                    <span className="roll-what">{d.what}</span>
                    <span className={`tag${c.isError || d.double ? ' no' : ''}`}>{c.isError ? 'refused' : d.double ? 'double' : 'ok'}</span>
                    <code className="roll-detail">{d.detail}</code>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section id="anchor" aria-labelledby="anchor-h">
          <div className="head">
            <h2 id="anchor-h">The anchor</h2>
            <span className="count">memo read back: {r.anchor.memoSeen ? 'yes' : 'no'}</span>
          </div>
          <article className="receipt">
            <div className="receipt-l">
              <p>
                The gateway wrote its state into a shielded memo to an address whose viewing key is published: <Tx id={r.anchor.txid} />. Clients now read anchors from lightwalletd themselves and prove only against an anchored root. This Oct 20 anchor is unsigned; anchors are signed with the gateway's key since Oct 22.
              </p>
              <dl className="meta">
                <div>
                  <dt>Leaves</dt>
                  <dd>{r.anchor.leaves}</dd>
                </div>
                <div>
                  <dt>Nullifiers</dt>
                  <dd>{r.anchor.nullifiers}</dd>
                </div>
                <div>
                  <dt>Matches the gateway</dt>
                  <dd>{r.anchor.matchesGatewayState ? 'yes' : 'no'}</dd>
                </div>
              </dl>
              <code className="memo">{r.anchor.memo}</code>
            </div>
            <Tear />
            <div className="receipt-r">
              <span className="label">Recompute in your browser</span>
              <AnchorCheck />
            </div>
          </article>
        </section>
      </main>
      <footer className="wrap foot">
        <span>Kippu · MIT · Copyright (c) 2026 Nivesh Gajengi</span>
        <span>Zcash testnet · not audited · the gateway is trusted for liveness; clients prove only against anchored roots</span>
      </footer>
    </>
  );
}
