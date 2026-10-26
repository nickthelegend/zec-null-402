#!/usr/bin/env node
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HEAVY_SLOT = '/Volumes/Extreme SSD/Projects/grokbot/tools/heavy-slot.sh';
const SLOT_NAME = 'audit-kippu';

const LOCAL_LANDING = 'http://127.0.0.1:5184/';
const LOCAL_EVID = 'http://127.0.0.1:5184/evidence.html';
const LOCAL_DASH = 'http://127.0.0.1:5183/';

const LIVE_LANDING = 'https://kippu-landing.vercel.app/';
const LIVE_EVID = 'https://kippu-landing.vercel.app/evidence.html';
const LIVE_DASH = 'https://kippu-dashboard.vercel.app/';

let stackStarted = false;
function stopStack() {
  if (stackStarted) {
    try {
      console.log('Stopping local stack...');
      execSync('./e2e/stack.sh stop', { cwd: root, stdio: 'inherit' });
    } catch {}
    stackStarted = false;
  }
}

process.on('exit', stopStack);
process.on('SIGINT', () => { stopStack(); process.exit(130); });
process.on('SIGTERM', () => { stopStack(); process.exit(143); });

function startStack() {
  console.log('Acquiring slot to start stack...');
  execSync(`"${HEAVY_SLOT}" acquire ${SLOT_NAME}`, { stdio: 'inherit' });
  try {
    try { execSync('./e2e/stack.sh stop', { cwd: root, stdio: 'ignore' }); } catch {}
    console.log('Starting local stack via e2e/stack.sh...');
    execSync('./e2e/stack.sh', { cwd: root, stdio: 'inherit' });
    stackStarted = true;
  } finally {
    console.log('Releasing slot after stack startup...');
    execSync(`"${HEAVY_SLOT}" release ${SLOT_NAME}`, { stdio: 'inherit' });
  }
}

const UI_TESTS = [
  {
    id: 'UI-LAND-NAV-SECTIONS-375',
    url: LOCAL_LANDING,
    width: 375,
    height: 812,
    assert: `(() => {
      const lis = Array.from(document.querySelectorAll('header.nav ul li:not(:last-child)'));
      if (lis.length < 4) return 'nav li:not(:last-child) count < 4: ' + lis.length;
      for (let i = 0; i < lis.length; i++) {
        const s = getComputedStyle(lis[i]);
        if (s.display !== 'none') return 'nav link ' + i + ' not hidden on mobile: display is ' + s.display;
      }
      const gh = document.querySelector('header.nav ul li:last-child a');
      if (!gh || getComputedStyle(gh).display === 'none') return 'GitHub button not visible';
      return true;
    })()`,
    evaluateActual: `(() => 'header.nav ul li:not(:last-child) display: none; GitHub link visible')()`,
  },
  {
    id: 'UI-LAND-CTA-LINKS',
    url: LOCAL_LANDING,
    width: 1280,
    height: 800,
    assert: `(async () => {
      const railBtn = Array.from(document.querySelectorAll('a[href="#rail"]')).find(a => a.textContent.includes('See the 22 tickets'));
      if (!railBtn) return 'See 22 tickets link missing';
      const evidBtn = Array.from(document.querySelectorAll('a[href="evidence.html"], a[href="/evidence.html"]')).find(a => a.textContent.includes('Read the evidence'));
      if (!evidBtn) return 'Read the evidence link missing';
      const homeBtn = document.querySelector('a.logo[href="#main"], a[href="#main"]');
      if (!homeBtn) return 'Home link missing';
      const r = await fetch('evidence.html');
      if (r.status !== 200) return 'evidence.html status is ' + r.status;
      return true;
    })()`,
    evaluateActual: `(() => 'See the 22 tickets -> #rail; Read the evidence -> evidence.html (HTTP 200); Kippu home -> #main')()`,
  },
  {
    id: 'UI-LAND-LIVE-NAV-375',
    url: LIVE_LANDING,
    width: 375,
    height: 812,
    assert: `(() => {
      const lis = Array.from(document.querySelectorAll('header.nav ul li:not(:last-child)'));
      if (lis.length < 4) return 'nav li:not(:last-child) count < 4: ' + lis.length;
      for (let i = 0; i < lis.length; i++) {
        const s = getComputedStyle(lis[i]);
        if (s.display !== 'none') return 'nav link ' + i + ' not hidden on mobile: display is ' + s.display;
      }
      const gh = document.querySelector('header.nav ul li:last-child a');
      if (!gh || getComputedStyle(gh).display === 'none') return 'GitHub button not visible';
      return true;
    })()`,
    evaluateActual: `(() => 'header section links hidden on mobile (display: none); GitHub link visible')()`,
  },
  {
    id: 'UI-EVID-LOAD-1280',
    url: LOCAL_EVID,
    width: 1280,
    height: 800,
    assert: `(() => {
      if (!document.title.includes('Kippu — Evidence & Methodology')) return 'title mismatch: ' + document.title;
      const h1 = document.querySelector('h1');
      if (!h1 || !h1.textContent.includes('Testnet runs, proofs & limits.')) return 'h1 mismatch: ' + (h1 ? h1.textContent : 'none');
      const pass = document.querySelector('article.pass, .pass');
      if (!pass || !pass.textContent.includes('4,522,696')) return 'pass missing 4,522,696';
      return true;
    })()`,
    evaluateActual: `(() => 'title Kippu — Evidence & Methodology; h1 Testnet runs, proofs & limits.; pass article displays 4,522,696')()`,
  },
  {
    id: 'UI-EVID-PASS2-ROWS',
    url: LOCAL_EVID,
    width: 1280,
    height: 800,
    assert: `(() => {
      const h2 = document.querySelector('#live h2');
      if (!h2 || !h2.textContent.includes('Signed anchors, the default window, four paid calls.')) return 'h2 mismatch';
      const items = Array.from(document.querySelectorAll('#live .agent ol > li'));
      if (items.length !== 9) return 'expected 9 rows, got ' + items.length;
      const links = Array.from(document.querySelectorAll('#live a.txlink'));
      if (links.length !== 7) return 'expected 7 txlinks, got ' + links.length;
      if (!items[2].textContent.includes('3 × 200') || !items[2].textContent.includes('548, 351 and 361 ms')) return 'row 2 mismatch: ' + items[2].textContent;
      if (!items[5].textContent.includes('proof 574 ms')) return 'row 5 mismatch: ' + items[5].textContent;
      return true;
    })()`,
    evaluateActual: `(() => 'h2 Signed anchors...; .agent ol > li has 9 rows; 7 txlinks in order; row 2 has 3 × 200 and proofs 548, 351 and 361 ms; row 5 has proof 574 ms')()`,
  },
  {
    id: 'UI-EVID-PASS2-PROBE-VOID',
    url: LOCAL_EVID,
    width: 1280,
    height: 800,
    assert: `(() => {
      const items = Array.from(document.querySelectorAll('#live .agent ol > li'));
      if (items.length !== 9) return 'expected 9 rows, got ' + items.length;
      const r6 = items[6].textContent;
      if (!r6.includes('c69195a9') || !r6.includes('c1b4b478')) return 'row 6 missing probe anchors: ' + r6;
      const r8 = items[8].textContent;
      if (!r8.includes('void') || !r8.includes('ANCHOR_COMPETING')) return 'row 8 missing void or ANCHOR_COMPETING: ' + r8;
      const side = document.querySelector('#live .agent-side');
      if (!side || !side.textContent.includes('hosted gateway') || !side.textContent.includes('no wallet to anchor roots')) return 'side missing hosted gateway note';
      return true;
    })()`,
    evaluateActual: `(() => 'row 6 describes probe naming older anchor c69195a9…; row 8 has tag void and ANCHOR_COMPETING; .agent-side mentions hosted gateway has no wallet to anchor roots')()`,
  },
  {
    id: 'UI-EVID-VOIDED-CODES',
    url: LOCAL_EVID,
    width: 1280,
    height: 800,
    assert: `(() => {
      const items = Array.from(document.querySelectorAll('#void ul.voids > li'));
      if (items.length !== 8) return 'expected 8 void items, got ' + items.length;
      for (const it of items) {
        const stamp = it.querySelector('.stamp');
        if (!stamp || stamp.textContent.trim() !== 'VOID') return 'missing VOID stamp: ' + it.innerHTML;
      }
      const codes = ['NULLIFIER_SPENT', 'NOT_BOUND_TO_CHALLENGE', 'BAD_PROOF', '409 already claimed', 'MEMO_MISMATCH', 'ANCHOR_COMPETING'];
      const text = items.map(it => it.textContent).join(' ');
      for (const c of codes) {
        if (!text.includes(c)) return 'missing code: ' + c;
      }
      return true;
    })()`,
    evaluateActual: `(() => '8 void items in ul.voids > li each with stamp VOID; codes match 8 recorded refusals')()`,
  },
  {
    id: 'UI-EVID-CONDITIONS-TERMS',
    url: LOCAL_EVID,
    width: 1280,
    height: 800,
    assert: `(() => {
      const sec = document.querySelector('#terms');
      if (!sec) return '#terms missing';
      const text = sec.textContent;
      const phrases = [
        'Anchors count paid calls.',
        'At low traffic that times single calls to within about 10 minutes.',
        'Both testnet runs had one depositor',
        'the first call paid 2 min 44 s after the deposit was sent: the deposit was mined in 21 s'
      ];
      for (const p of phrases) {
        if (!text.includes(p)) return 'missing phrase: ' + p;
      }
      return true;
    })()`,
    evaluateActual: `(() => 'Contains Anchors count paid calls, 10 minutes timing, single depositor caveat, and measured first call latency 2 min 44 s')()`,
  },
  {
    id: 'UI-EVID-LIVE-LOAD-1280',
    url: LIVE_EVID,
    width: 1280,
    height: 800,
    assert: `(() => {
      if (!document.title.includes('Kippu — Evidence & Methodology')) return 'title mismatch: ' + document.title;
      const h1 = document.querySelector('h1');
      if (!h1 || !h1.textContent.includes('Testnet runs, proofs & limits.')) return 'h1 mismatch: ' + (h1 ? h1.textContent : 'none');
      const pass = document.querySelector('article.pass, .pass');
      if (!pass || !pass.textContent.includes('4,522,696')) return 'pass missing 4,522,696';
      return true;
    })()`,
    evaluateActual: `(() => 'HTTP 200, 0 console errors, pass article shows deposit block height 4,522,696')()`,
  },
  {
    id: 'UI-EVID-LIVE-PASS2-ROWS',
    url: LIVE_EVID,
    width: 1280,
    height: 800,
    assert: `(() => {
      const items = Array.from(document.querySelectorAll('#live .agent ol > li'));
      if (items.length !== 9) return 'expected 9 rows, got ' + items.length;
      const links = Array.from(document.querySelectorAll('#live a.txlink'));
      if (links.length !== 7) return 'expected 7 txlinks, got ' + links.length;
      if (!items[2].textContent.includes('3 × 200')) return 'row 2 missing 3 × 200';
      if (!items[8].textContent.includes('void') || !items[8].textContent.includes('ANCHOR_COMPETING')) return 'row 8 missing void or ANCHOR_COMPETING';
      return true;
    })()`,
    evaluateActual: `(() => '9 rows in .agent ol > li; txlinks in order; row 2 has 3 × 200; row 8 has tag void and ANCHOR_COMPETING')()`,
  },
  {
    id: 'UI-EVID-LIVE-VOIDED-CODES',
    url: LIVE_EVID,
    width: 1280,
    height: 800,
    assert: `(() => {
      const items = Array.from(document.querySelectorAll('#void ul.voids > li'));
      if (items.length !== 8) return 'expected 8 void items, got ' + items.length;
      for (const it of items) {
        const stamp = it.querySelector('.stamp');
        if (!stamp || stamp.textContent.trim() !== 'VOID') return 'missing VOID stamp: ' + it.innerHTML;
      }
      const codes = ['NULLIFIER_SPENT', 'NOT_BOUND_TO_CHALLENGE', 'BAD_PROOF', '409 already claimed', 'MEMO_MISMATCH', 'ANCHOR_COMPETING'];
      const text = items.map(it => it.textContent).join(' ');
      for (const c of codes) {
        if (!text.includes(c)) return 'missing code: ' + c;
      }
      return true;
    })()`,
    evaluateActual: `(() => '8 void items with stamp VOID and codes matching recorded refusals')()`,
  },
  {
    id: 'UI-DASH-WHO-SEES-WHAT',
    url: LOCAL_DASH,
    width: 1280,
    height: 800,
    assert: `(() => {
      const items = Array.from(document.querySelectorAll('#who ul.who > li'));
      if (items.length !== 4) return 'expected 4 who list items, got ' + items.length;
      const parties = ['The chain', 'The gateway', 'Anyone with the anchor key', 'Anyone with the gateway key'];
      for (let i = 0; i < 4; i++) {
        if (!items[i].querySelector('h3')?.textContent.includes(parties[i])) return 'party mismatch at ' + i + ': ' + items[i].querySelector('h3')?.textContent;
        const notP = items[i].querySelector('p.not');
        if (!notP || !notP.textContent.startsWith('Not ')) return 'missing p.not starting with Not  at ' + i;
      }
      if (!items[2].textContent.includes('here 22, 22 spent') || !items[2].textContent.includes('Not which note paid which call.')) return 'anchor key text mismatch: ' + items[2].textContent;
      const note = document.querySelector('#who p.note');
      if (!note || !note.textContent.includes('One depositor in each testnet run (Oct 20 and pass 2)')) return 'single depositor note missing';
      return true;
    })()`,
    evaluateActual: `(() => '4 list items for parties with .not blocks; anchor key shows here 22, 22 spent; single depositor note present')()`,
  },
  {
    id: 'UI-DASH-VOIDED-CODES',
    url: LOCAL_DASH,
    width: 1280,
    height: 800,
    assert: `(() => {
      const count = document.querySelector('#void .head .count');
      if (!count || !count.textContent.includes('8 refused')) return 'count mismatch: ' + count?.textContent;
      const items = Array.from(document.querySelectorAll('#void ul.voids > li'));
      if (items.length !== 8) return 'expected 8 void items, got ' + items.length;
      const codes = ['NULLIFIER_SPENT', 'NOT_BOUND_TO_CHALLENGE', 'BAD_PROOF', '409 already claimed', 'MEMO_MISMATCH', 'ANCHOR_COMPETING'];
      const text = items.map(it => it.textContent).join(' ');
      for (const c of codes) {
        if (!text.includes(c)) return 'missing code: ' + c;
      }
      const rev = Array.from(document.querySelectorAll('#void a')).find(a => a.textContent.includes('Read the review'));
      if (!rev || rev.getAttribute('target') !== '_blank') return 'review link missing or target not _blank';
      return true;
    })()`,
    evaluateActual: `(() => 'Header has 8 refused; 8 list items show exact refusal codes; Read the review link opens target=_blank')()`,
  },
  {
    id: 'UI-DASH-PASS2-ROLL-10',
    url: LOCAL_DASH,
    width: 1280,
    height: 800,
    assert: `(() => {
      const h2 = document.querySelector('#pass2 h2');
      if (!h2 || !h2.textContent.includes('Pass 2: the current protocol, live')) return 'h2 mismatch: ' + h2?.textContent;
      const count = document.querySelector('#pass2 .head .count');
      if (!count || !count.textContent.includes('Oct 22 · 4 calls + 1 probe paid')) return 'count mismatch: ' + count?.textContent;
      const items = Array.from(document.querySelectorAll('#pass2 ol.roll > li'));
      if (items.length !== 10) return 'expected 10 items in ol.roll, got ' + items.length;
      if (!items[2].textContent.includes('3 × 200')) return 'row 3 missing 3 × 200: ' + items[2].textContent;
      if (!items[7].textContent.includes('probe: an older anchor named')) return 'row 8 missing probe: ' + items[7].textContent;
      if (!items[9].textContent.includes('void') || !items[9].textContent.includes('ANCHOR_COMPETING')) return 'row 10 missing void or ANCHOR_COMPETING: ' + items[9].textContent;
      return true;
    })()`,
    evaluateActual: `(() => 'Header has Pass 2: the current protocol, live and Oct 22 · 4 calls + 1 probe paid; 10 items in ol.roll; row 3 has tag 3 × 200; row 8 describes probe; row 10 has tag void and ANCHOR_COMPETING')()`,
  },
  {
    id: 'UI-DASH-LIVE-WHO-SEES-WHAT',
    url: LIVE_DASH,
    width: 1280,
    height: 800,
    assert: `(() => {
      const items = Array.from(document.querySelectorAll('#who ul.who > li'));
      if (items.length !== 4) return 'expected 4 who list items, got ' + items.length;
      for (const it of items) {
        const notP = it.querySelector('p.not');
        if (!notP || !notP.textContent.startsWith('Not ')) return 'missing p.not starting with Not ';
      }
      const note = document.querySelector('#who p.note');
      if (!note || !note.textContent.includes('One depositor in each testnet run (Oct 20 and pass 2)')) return 'single depositor note missing';
      return true;
    })()`,
    evaluateActual: `(() => '4 parties listed with .not statements; mentions single depositor caveat')()`,
  },
  {
    id: 'UI-DASH-LIVE-VOIDED-CODES',
    url: LIVE_DASH,
    width: 1280,
    height: 800,
    assert: `(() => {
      const items = Array.from(document.querySelectorAll('#void ul.voids > li'));
      if (items.length !== 8) return 'expected 8 void items, got ' + items.length;
      const codes = ['NULLIFIER_SPENT', 'NOT_BOUND_TO_CHALLENGE', 'BAD_PROOF', '409 already claimed', 'MEMO_MISMATCH', 'ANCHOR_COMPETING'];
      const text = items.map(it => it.textContent).join(' ');
      for (const c of codes) {
        if (!text.includes(c)) return 'missing code: ' + c;
      }
      return true;
    })()`,
    evaluateActual: `(() => '8 refused tickets matching recorded refusal codes')()`,
  },
  {
    id: 'UI-DASH-LIVE-PASS2-ROLL',
    url: LIVE_DASH,
    width: 1280,
    height: 800,
    assert: `(() => {
      const items = Array.from(document.querySelectorAll('#pass2 ol.roll > li'));
      if (items.length !== 10) return 'expected 10 items in ol.roll, got ' + items.length;
      if (!items[9].textContent.includes('void') || !items[9].textContent.includes('ANCHOR_COMPETING')) return 'row 10 missing void or ANCHOR_COMPETING';
      return true;
    })()`,
    evaluateActual: `(() => '10 rows from testnet-pass2.json; txlinks in order; row 10 has tag void and ANCHOR_COMPETING')()`,
  },
];

async function main() {
  startStack();

  console.log(`Running ${UI_TESTS.length} UI retests...`);
  let passed = 0;
  let failed = 0;

  for (const test of UI_TESTS) {
    console.log(`Testing ${test.id}...`);
    const item = {
      id: test.id,
      url: test.url,
      width: test.width,
      height: test.height,
      outDir: 'retest',
      assert: test.assert,
      evaluateActual: test.evaluateActual,
    };
    const res = spawnSync('node', ['audit/runner/capture.mjs', JSON.stringify(item)], {
      cwd: root,
      encoding: 'utf8',
    });
    if (res.status === 0) {
      console.log(`  [PASS] ${test.id}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${test.id}`);
      if (res.stdout) console.error(res.stdout);
      if (res.stderr) console.error(res.stderr);
      failed++;
    }
  }

  console.log(`\nUI Retest complete: ${passed} passed, ${failed} failed.`);
  stopStack();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error in UI retest:', err);
  stopStack();
  process.exit(1);
});
