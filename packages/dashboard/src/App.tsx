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
const Tx = ({ id }: { id: string }) => (
  <a className="hash" href={EXPLORER + id} target="_blank" rel="noreferrer" aria-label={`Transaction ${id} on the testnet explorer`}>
    <code>{short(id)}</code>
    <ArrowOut />
  </a>
);
const zec = (zat: number) => `${(zat / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 })} TAZ`;
/** The same number zec() prints, split into the whole part and the faded decimal part. */
const zecParts = (zat: number): [string, string] => {
  const parts = new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).formatToParts(zat / 1e8);
  const i = parts.findIndex((p) => p.type === 'decimal');
  const join = (ps: Intl.NumberFormatPart[]) => ps.map((p) => p.value).join('');
  return i < 0 ? [join(parts), ''] : [join(parts.slice(0, i)), join(parts.slice(i))];
};
const pad = (n: number) => String(n).padStart(2, '0');

const ATTACK: Record<string, string> = {
  replayWithNewContext: 'a paid proof sent again for a new request',
  tamperedAmount: 'the amount in the public signals changed',
  tamperedNullifier: 'the nullifier changed (a different note claimed)',
  proofForAnotherRequest: 'a proof made for one request sent for another',
  replayOfSecondNote: 'the second note’s proof replayed',
};

function ArrowOut() {
  return (
    <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 11 11 5M6 5h5v5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TicketMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo-mark">
      <rect width="32" height="32" rx="10" fill="#ff8a3d" />
      <path d="M8 10H24A1 1 0 0 1 25 11V13.5A2.5 2.5 0 0 0 25 18.5V21A1 1 0 0 1 24 22H8A1 1 0 0 1 7 21V18.5A2.5 2.5 0 0 0 7 13.5V11A1 1 0 0 1 8 10Z" fill="#063b33" />
      <path d="M19 11.5V20.5" stroke="#ff8a3d" strokeWidth="1.2" strokeDasharray="1.4 1.4" />
    </svg>
  );
}

/** Balance-style number: bright whole part, faded tail, small unit. */
function Big({ main, faded, unit, size = 'l' }: { main: string; faded?: string; unit?: string; size?: 'l' | 'm' }) {
  return (
    <span className={`big big-${size}`}>
      <span>{main}</span>
      {faded ? <span className="fade">{faded}</span> : null}
      {unit ? <span className="unit">{unit}</span> : null}
    </span>
  );
}

function ZecBig({ zat, size }: { zat: number; size?: 'l' | 'm' }) {
  const [whole, dec] = zecParts(zat);
  return <Big main={whole} faded={dec} unit="TAZ" size={size} />;
}

type CheckState = 'checking' | 'ok' | 'bad' | 'unavailable';

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

  const total = r.calls.length + r.fixtureNullifiers.length;
  const message =
    state === 'unavailable'
      ? 'This browser cannot hash here (Web Crypto needs https or localhost).'
      : state === 'checking'
        ? 'Hashing the published nullifiers in this tab…'
        : state === 'ok'
          ? `The ${total} published nullifiers hash to the anchored value.`
          : 'The published nullifiers do not match the anchor.';
  const buttonLabel = state === 'checking' ? 'Hashing…' : state === 'ok' ? 'Matches · hash again' : state === 'bad' ? 'Mismatch · hash again' : 'Try again';

  return (
    <div className={`check check-${state}`}>
      <div className="check-head">
        <span className={`pill pill-${state === 'ok' ? 'ok' : state === 'bad' ? 'no' : state === 'unavailable' ? 'warn' : 'idle'}`}>
          <span className="pill-dot" aria-hidden="true" />
          {state === 'ok' ? 'Verified in this tab' : state === 'bad' ? 'Does not match' : state === 'unavailable' ? 'Setup required' : 'Checking'}
        </span>
        <button type="button" className={`btn btn-${state}`} onClick={check} disabled={state === 'checking'} aria-busy={state === 'checking'}>
          {state === 'checking' ? <span className="spinner" aria-hidden="true" /> : null}
          {buttonLabel}
        </button>
      </div>
      <p className={`check-msg ${state === 'ok' ? 'ok' : state === 'bad' ? 'no' : 'muted'}`} role="status" aria-live="polite">
        {message}
      </p>
      <dl className="kv">
        <div>
          <dt>sha256 over the sorted set</dt>
          <dd>
            <code>{short(hash || '…', 12, 8)}</code>
          </dd>
        </div>
        <div>
          <dt>anchored</dt>
          <dd>
            <code>{short(r.anchor.nullifierHash, 12, 8)}</code>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function Tickets() {
  if (r.calls.length === 0 && r.fixtureNullifiers.length === 0) {
    return (
      <div className="empty">
        <TicketMark size={40} />
        <p>No paid calls in this run yet.</p>
        <p className="muted small">Run the testnet script to publish deployments/testnet.json; tickets appear here once a note pays.</p>
      </div>
    );
  }
  return (
    <ol className="tickets">
      {r.calls.map((c) => (
        <li key={c.n} className="ticket">
          <div className="ticket-top">
            <span className="ticket-no">No. {pad(c.n)}</span>
            <span className={`pill pill-sm ${c.status === 200 ? 'pill-paid' : 'pill-no'}`}>HTTP {c.status}</span>
          </div>
          <div className="ticket-rule" aria-hidden="true" />
          <div className="ticket-body">
            <span className="ticket-label">nullifier</span>
            <code className="ticket-hash" title={c.nullifier}>
              {short(c.nullifier, 10, 4)}
            </code>
            <span className="ticket-meta">proof {c.proveMs} ms</span>
          </div>
        </li>
      ))}
      {r.fixtureNullifiers.map((nf, i) => (
        <li key={nf} className="ticket ticket-fixture">
          <div className="ticket-top">
            <span className="ticket-no">Test note {i + 1}</span>
            <span className="pill pill-sm pill-test">fixture</span>
          </div>
          <div className="ticket-rule" aria-hidden="true" />
          <div className="ticket-body">
            <span className="ticket-label">nullifier</span>
            <code className="ticket-hash" title={nf}>
              {short(nf, 10, 4)}
            </code>
            <span className="ticket-meta">paid one call, then used for attack tests</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

const NAV = [
  ['overview', 'Overview'],
  ['tickets', 'Tickets'],
  ['who', 'Who sees what'],
  ['ref', 'Refusals'],
  ['agent', 'Agent run'],
  ['anc', 'Anchor'],
] as const;

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
    const url = String((c.args as { url?: string }).url ?? '');
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    return { what: `pay ${path}`, detail: typeof res === 'string' ? res : `HTTP ${res.status}, proof ${res.prove_ms} ms` };
  }
  if (c.tool === 'claim') return { what: 'claim the deposit', detail: typeof res === 'string' ? res : `credited ${res.count} notes from leaf ${res.first}` };
  const w = typeof res === 'string' ? null : (res.wallet as { credited?: number; unspent_units?: string } | undefined);
  return { what: 'status', detail: w ? `${w.credited} credited, ${w.unspent_units} units unspent` : String(res) };
}

export function App() {
  const spentTotal = r.calls.length * Number(r.priceUnits) * r.unitZat;
  const proveTimes = r.calls.map((c) => c.proveMs);
  const ranAt = new Date(r.ranAt).toLocaleString();
  return (
    <div className="page">
      <div className="frame">
        <header className="bar">
          <a className="brand" href="#overview" aria-label="Kippu, back to overview">
            <TicketMark />
            <span className="wordmark">Kippu</span>
            <span className="kanji" lang="ja">
              切符
            </span>
          </a>
          <nav className="nav" aria-label="Sections">
            {NAV.map(([id, label]) => (
              <a key={id} href={`#${id}`}>
                {label}
              </a>
            ))}
          </nav>
          <div className="bar-pills">
            <span className="pill pill-net">
              <span className="pill-dot" aria-hidden="true" />
              Zcash testnet
            </span>
            <a className="pill pill-gh" href={REPO} target="_blank" rel="noreferrer">
              GitHub
              <ArrowOut />
            </a>
          </div>
        </header>

        <main>
          <section id="overview" className="overview" aria-labelledby="overview-h">
            <div className="ov-main">
              <div className="ov-eyebrow">
                <span className="eyebrow-ico" aria-hidden="true">
                  <TicketMark size={22} />
                </span>
                <span>Prepaid ZK tickets</span>
                <span className="muted">· run {ranAt}</span>
              </div>
              <h1 id="overview-h">
                {r.calls.length} paid calls. <span className="h-fade">No transaction per call.</span>
              </h1>
              <p className="lede">
                One shielded deposit bought {r.gateway.leaves} prepaid notes. Each API call was paid with a zero-knowledge proof of one unspent note, checked by the gateway in a few
                hundred milliseconds. The gateway learns that some note paid, not which one.
              </p>

              <div className="stats">
                <div className="stat">
                  <span className="stat-label">Paid calls</span>
                  <Big main={String(r.calls.length)} unit="calls" />
                </div>
                <div className="stat">
                  <span className="stat-label">Notes spent of credited</span>
                  <Big main={String(r.gateway.spent)} faded={` / ${r.gateway.leaves}`} unit="notes" />
                </div>
                <div className="stat">
                  <span className="stat-label">Proof time</span>
                  {proveTimes.length ? <Big main={String(Math.min(...proveTimes))} faded={`–${Math.max(...proveTimes)}`} unit="ms" /> : <span className="muted">no calls yet</span>}
                </div>
              </div>

              <div className="panel lanes" aria-label="On-chain transactions compared with paid calls">
                <div className="lane">
                  <span className="lane-name">On Zcash</span>
                  <div className="marks">
                    <a className="mark chain" href={EXPLORER + r.txs.deposit} target="_blank" rel="noreferrer" title="deposit">
                      deposit
                    </a>
                    <span className="gap" />
                    <a className="mark chain" href={EXPLORER + r.txs.anchor} target="_blank" rel="noreferrer" title="anchor">
                      anchor
                    </a>
                  </div>
                </div>
                <div className="lane">
                  <span className="lane-name">Paid calls</span>
                  <div className="marks dots">
                    {r.calls.map((c) => (
                      <span key={c.n} className="dot" title={`call ${c.n}: HTTP ${c.status}, proof ${c.proveMs} ms, nullifier ${short(c.nullifier, 10, 4)}`} />
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <aside className="ov-side" aria-label="Deposit and spend">
              <div className="deposit-card">
                <div className="dc-top">
                  <span className="dc-label">Shielded deposit</span>
                  <span className="dc-block">block {r.deposit.height.toLocaleString()}</span>
                </div>
                <div className="dc-perf" aria-hidden="true" />
                <div className="dc-bottom">
                  <span className="stat-label">Deposit</span>
                  <ZecBig zat={Number(r.deposit.amountZat)} />
                  <div className="dc-row">
                    <span className="muted small">{r.gateway.leaves} notes credited</span>
                    <Tx id={r.deposit.txid} />
                  </div>
                </div>
              </div>

              <div className="panel spend">
                <span className="stat-label">Spent on paid calls</span>
                <ZecBig zat={spentTotal} size="m" />
                <dl className="spend-grid">
                  <div>
                    <dt>Calls</dt>
                    <dd>{r.calls.length}</dd>
                  </div>
                  <div>
                    <dt>Price</dt>
                    <dd>{r.priceUnits} units</dd>
                  </div>
                  <div>
                    <dt>Per call</dt>
                    <dd>{zec(Number(r.priceUnits) * r.unitZat)}</dd>
                  </div>
                </dl>
              </div>
              <p className="muted small side-note">
                Deposit {zec(Number(r.deposit.amountZat))} in <Tx id={r.deposit.txid} /> (block {r.deposit.height.toLocaleString()}); {r.calls.length} calls × {r.priceUnits} units ={' '}
                {zec(spentTotal)}
                {proveTimes.length ? `; proofs took ${Math.min(...proveTimes)}–${Math.max(...proveTimes)} ms` : ''}. Two more notes paid one call each and were then used for the attack
                tests: {r.gateway.spent} notes spent in all.
              </p>
            </aside>
          </section>

          <section id="tickets" aria-labelledby="tickets-h">
            <div className="sec-head">
              <h2 id="tickets-h">Tickets punched</h2>
              <span className="pill pill-idle">
                {r.gateway.spent} of {r.gateway.leaves} notes spent
              </span>
            </div>
            <p className="muted sec-lede">One ticket per spent note, identified only by its nullifier. Nothing here says which deposit note it came from.</p>
            <Tickets />
          </section>

          <section id="who" aria-labelledby="who-h">
            <div className="sec-head">
              <h2 id="who-h">Who sees what</h2>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Observer</th>
                    <th scope="col">Sees</th>
                    <th scope="col">Does not see</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="strong">The chain</td>
                    <td>two shielded transactions (deposit, anchor)</td>
                    <td className="muted">amounts, memos, who paid, how many calls</td>
                  </tr>
                  <tr>
                    <td className="strong">The gateway</td>
                    <td>
                      the deposit and its {r.gateway.leaves} note leaves; {r.calls.length + r.fixtureNullifiers.length} nullifiers
                    </td>
                    <td className="muted">which note paid which call</td>
                  </tr>
                  <tr>
                    <td className="strong">Anyone with the anchor viewing key</td>
                    <td>
                      leaf count {r.anchor.leaves}, root, spent count {r.anchor.nullifiers}, nullifier-set hash
                    </td>
                    <td className="muted">individual payments</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="muted small">With one depositor, every call came from that depositor’s notes. Unlinkability between users needs several depositors.</p>
          </section>

          <section id="ref" aria-labelledby="ref-h">
            <div className="sec-head">
              <h2 id="ref-h">What the gateway refused</h2>
              <span className="pill pill-no">
                <span className="pill-dot" aria-hidden="true" />
                {Object.keys(ATTACK).length + Object.keys(r.refusals).length} refused
              </span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Attempt</th>
                    <th scope="col">Gateway answer</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(ATTACK).map(([k, label]) => (
                    <tr key={k}>
                      <td>{label}</td>
                      <td>
                        <code className="code-pill">{String(r.attacks[k])}</code>
                      </td>
                    </tr>
                  ))}
                  {Object.entries(r.refusals).map(([k, v]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td>
                        <code className="code-pill code-long">{v.replace(/^HTTP \d+: /, '')}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section id="agent" aria-labelledby="agent-h">
            <div className="sec-head">
              <h2 id="agent-h">An LLM agent with a spending cap</h2>
              <span className="pill pill-no">
                <span className="pill-dot" aria-hidden="true" />
                {agentCalls.filter((c) => c.isError).length} of {agentCalls.length} calls refused
              </span>
            </div>
            <p className="muted small">
              An opencode agent used the four MCP tools against a local gateway on testnet. A quote response carried an injected order to buy a 50-unit report at any cost; <code>Z402_MAX_DEPOSIT_ZAT=40000</code> refused every 50,000 zat deposit, so it never bought it. Every call below is from{' '}
              <code>deployments/agent-run-2026-10-20.jsonl</code>.
            </p>
            {agentCalls.length === 0 ? (
              <p className="muted small">No agent run recorded yet.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Call</th>
                      <th scope="col">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agentCalls.map((c, i) => {
                      const d = describeCall(c);
                      return (
                        <tr key={c.at + i}>
                          <td>{i + 1}</td>
                          <td>
                            {d.what} <span className={`pill ${c.isError ? 'pill-no' : 'pill-ok'}`}>{c.isError ? 'refused' : 'ok'}</span>
                          </td>
                          <td>
                            <code className="code-pill code-long">{d.detail}</code>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section id="anc" aria-labelledby="anc-h">
            <div className="sec-head">
              <h2 id="anc-h">The anchor</h2>
              <span className={`pill ${r.anchor.memoSeen ? 'pill-ok' : 'pill-no'}`}>
                <span className="pill-dot" aria-hidden="true" />
                memo read back: {r.anchor.memoSeen ? 'yes' : 'no'}
              </span>
            </div>
            <div className="anchor-grid">
              <div className="panel">
                <p className="anchor-text">
                  The gateway put its state in a shielded memo to an address with a published viewing key (<Tx id={r.anchor.txid} />). The memo was read back on-chain:{' '}
                  {r.anchor.memoSeen ? 'yes' : 'no'}.
                </p>
                <div className="anchor-stats">
                  <div className="stat">
                    <span className="stat-label">Leaves</span>
                    <Big main={String(r.anchor.leaves)} size="m" />
                  </div>
                  <div className="stat">
                    <span className="stat-label">Nullifiers</span>
                    <Big main={String(r.anchor.nullifiers)} size="m" />
                  </div>
                </div>
                <code className="memo">{r.anchor.memo}</code>
              </div>
              <div className="panel">
                <span className="stat-label">Recompute in your browser</span>
                <AnchorCheck />
              </div>
            </div>
          </section>
        </main>
        <footer className="foot">
          <span>MIT · Copyright (c) 2026 Nivesh Gajengi</span>
          <span>testnet only · the gateway is trusted for liveness; its state is anchored</span>
        </footer>
      </div>
    </div>
  );
}
