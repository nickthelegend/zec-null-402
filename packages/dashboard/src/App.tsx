import { useEffect, useState } from 'react';
import run from '@deployments/testnet.json';

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
const short = (s: string, a = 8, b = 6) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
const Tx = ({ id }: { id: string }) => (
  <a href={EXPLORER + id} target="_blank" rel="noreferrer">
    <code>{short(id)}</code>
  </a>
);
const zec = (zat: number) => `${(zat / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 })} TAZ`;

const ATTACK: Record<string, string> = {
  replayWithNewContext: 'a paid proof sent again for a new request',
  tamperedAmount: 'the amount in the public signals changed',
  tamperedNullifier: 'the nullifier changed (a different note claimed)',
  proofForAnotherRequest: 'a proof made for one request sent for another',
  replayOfSecondNote: 'the second note’s proof replayed',
};

function AnchorCheck() {
  const [state, setState] = useState<'checking' | 'ok' | 'bad' | 'unavailable'>('checking');
  const [hash, setHash] = useState('');
  useEffect(() => {
    const all = [...r.calls.map((c) => c.nullifier), ...r.fixtureNullifiers].sort();
    if (!globalThis.crypto?.subtle) {
      setState('unavailable');
      return;
    }
    crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(`zec-null-402:v1:nullifiers:${all.join(',')}`))
      .then((buf) => {
        const h = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
        setHash(h);
        setState(h === r.anchor.nullifierHash ? 'ok' : 'bad');
      })
      .catch(() => setState('unavailable'));
  }, []);
  return (
    <div className="check">
      <p className={state === 'ok' ? 'ok' : state === 'bad' ? 'no' : 'muted'}>
        {state === 'unavailable' ? 'This browser cannot hash here (Web Crypto needs https or localhost).' : state === 'checking' ? 'Hashing the published nullifiers in this tab…' : state === 'ok' ? `The ${r.calls.length + r.fixtureNullifiers.length} published nullifiers hash to the anchored value.` : 'The published nullifiers do not match the anchor.'}
      </p>
      <p className="muted small">
        sha256 over the sorted set: <code>{short(hash || '…', 12, 8)}</code> · anchored: <code>{short(r.anchor.nullifierHash, 12, 8)}</code>
      </p>
    </div>
  );
}

export function App() {
  const spentTotal = r.calls.length * Number(r.priceUnits) * r.unitZat;
  return (
    <>
      <header className="top">
        <span className="brand">zec-null-402</span>
        <span className="muted small">Zcash testnet · run {new Date(r.ranAt).toLocaleString()}</span>
      </header>
      <main>
        <section className="hero">
          <h1>{r.calls.length} paid calls. No transaction per call.</h1>
          <p className="lede">
            One shielded deposit bought {r.gateway.leaves} prepaid notes. Each API call was paid with a zero-knowledge proof of one unspent note, checked by the gateway in a few
            hundred milliseconds. The gateway learns that some note paid, not which one.
          </p>
          <div className="lanes" aria-label="On-chain transactions compared with paid calls">
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
          <p className="muted small">
            Deposit {zec(Number(r.deposit.amountZat))} in <Tx id={r.deposit.txid} /> (block {r.deposit.height.toLocaleString()}); {r.calls.length} calls × {r.priceUnits} units ={' '}
            {zec(spentTotal)}; proofs took {Math.min(...r.calls.map((c) => c.proveMs))}–{Math.max(...r.calls.map((c) => c.proveMs))} ms. Two more notes paid one call each and were then used for the attack tests: {r.gateway.spent} notes spent in all.
          </p>
        </section>

        <section aria-labelledby="who">
          <h2 id="who">Who sees what</h2>
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
                  <td>The chain</td>
                  <td>two shielded transactions (deposit, anchor)</td>
                  <td>amounts, memos, who paid, how many calls</td>
                </tr>
                <tr>
                  <td>The gateway</td>
                  <td>the deposit and its {r.gateway.leaves} note leaves; {r.calls.length + r.fixtureNullifiers.length} nullifiers</td>
                  <td>which note paid which call</td>
                </tr>
                <tr>
                  <td>Anyone with the anchor viewing key</td>
                  <td>leaf count {r.anchor.leaves}, root, spent count {r.anchor.nullifiers}, nullifier-set hash</td>
                  <td>individual payments</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="muted small">With one depositor, every call came from that depositor’s notes. Unlinkability between users needs several depositors.</p>
        </section>

        <section aria-labelledby="ref">
          <h2 id="ref">What the gateway refused</h2>
          <div className="table-wrap">
            <table>
              <tbody>
                {Object.entries(ATTACK).map(([k, label]) => (
                  <tr key={k}>
                    <td>{label}</td>
                    <td>
                      <code>{String(r.attacks[k])}</code>
                    </td>
                  </tr>
                ))}
                {Object.entries(r.refusals).map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td>
                      <code>{v.replace(/^HTTP \d+: /, '')}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="anc">
          <h2 id="anc">The anchor</h2>
          <p className="muted">
            The gateway put its state in a shielded memo to an address with a published viewing key (<Tx id={r.anchor.txid} />). The memo was read back on-chain:{' '}
            {r.anchor.memoSeen ? 'yes' : 'no'}.
          </p>
          <p>
            <code className="memo">{r.anchor.memo}</code>
          </p>
          <AnchorCheck />
        </section>
      </main>
      <footer>MIT · Copyright (c) 2026 Nivesh Gajengi · testnet only · the gateway is trusted for liveness; its state is anchored</footer>
    </>
  );
}
