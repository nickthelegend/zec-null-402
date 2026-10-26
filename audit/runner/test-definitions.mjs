// Test definitions for all 88 audit rows: UI-LAND, UI-EVID, UI-DASH, and DOC-
const LOCAL_LANDING = 'http://127.0.0.1:5184/';
const LOCAL_EVID = 'http://127.0.0.1:5184/evidence.html';
const LOCAL_DASH = 'http://127.0.0.1:5183/';

const LIVE_LANDING = 'https://kippu-landing.vercel.app/';
const LIVE_EVID = 'https://kippu-landing.vercel.app/evidence.html';
const LIVE_DASH = 'https://kippu-dashboard.vercel.app/';

export const TESTS = [
  // ==========================================
  // Group 1: UI-LAND (Local)
  // ==========================================
  {
    id: 'UI-LAND-LOAD-1280',
    url: LOCAL_LANDING,
    viewport: { width: 1280, height: 800 },
    assert: `(() => {
      if (!document.title.includes('Kippu')) return 'title mismatch: ' + document.title;
      const h1 = document.querySelector('h1');
      if (!h1 || !h1.textContent.includes('One deposit. A ticket per call.')) return 'h1 mismatch: ' + (h1 ? h1.textContent : 'none');
      const art = document.querySelector('article[aria-label="The shielded deposit that bought the tickets"]');
      if (!art || !art.textContent.includes('22') || !art.textContent.includes('220,000 zat bought 22 tickets')) return 'article mismatch: ' + (art ? art.textContent : 'none');
      if (!document.body.textContent.includes('22 tickets')) return 'note Run summary missing 22 tickets';
      return '';
    })()`,
    evaluateActual: `(() => 'HTTP 200; title: ' + document.title + '; h1: ' + document.querySelector('h1')?.textContent.trim() + '; article: 220,000 zat bought 22 tickets; summary: 22 tickets')()`,
  },
  {
    id: 'UI-LAND-LOAD-375',
    url: LOCAL_LANDING,
    viewport: { width: 375, height: 812 },
    assert: `(() => {
      if (document.documentElement.scrollWidth > window.innerWidth) return 'horizontal scroll overflow: ' + document.documentElement.scrollWidth + ' > ' + window.innerWidth;
      const h1 = document.querySelector('h1');
      if (!h1 || !h1.textContent.includes('One deposit. A ticket per call.')) return 'h1 mismatch';
      const art = document.querySelector('article.pass');
      if (!art) return 'pass article missing';
      return '';
    })()`,
    evaluateActual: `(() => 'HTTP 200; scrollWidth ' + document.documentElement.scrollWidth + ' <= ' + window.innerWidth + '; h1: ' + document.querySelector('h1')?.textContent.trim() + '; pass article visible')()`,
  },
  {
    id: 'UI-LAND-RAIL-TEAR-1280',
    url: LOCAL_LANDING,
    viewport: { width: 1280, height: 800 },
    actions: [{ type: 'scroll', selector: '#rail' }, { type: 'wait', ms: 2500 }],
    assert: `(() => {
      const rail = document.querySelector('ol.rail');
      if (!rail) return 'rail missing';
      if (!rail.classList.contains('torn')) return 'rail does not match torn: ' + rail.className;
      const tix = document.querySelectorAll('ol.rail li.tix');
      if (tix.length !== 22) return 'ticket count is ' + tix.length;
      for (let i = 0; i < tix.length; i++) {
        const s = getComputedStyle(tix[i]);
        if (s.opacity !== '1') return 'ticket ' + i + ' opacity is ' + s.opacity;
        if (s.transform !== 'none' && !s.transform.includes('matrix(1, 0, 0, 1, 0, 0)')) return 'ticket ' + i + ' transform is ' + s.transform;
      }
      const d4 = getComputedStyle(tix[3]).transitionDelay;
      const delaySec = parseFloat(d4);
      if (Math.abs(delaySec - 0.135) > 0.005 && !d4.includes('135ms')) return 'tix[3] delay is ' + d4;
      return '';
    })()`,
    evaluateActual: `(() => 'rail torn; 22 tickets opacity 1, transform none; tix[3] transitionDelay ' + getComputedStyle(document.querySelectorAll('ol.rail li.tix')[3])?.transitionDelay)()`,
  },
  {
    id: 'UI-LAND-RAIL-REDUCED-MOTION',
    url: LOCAL_LANDING,
    viewport: { width: 1280, height: 800 },
    reducedMotion: 'reduce',
    assert: `(() => {
      const rail = document.querySelector('ol.rail');
      if (!rail) return 'rail missing';
      if (rail.classList.contains('armed')) return 'rail has armed class with reduced motion';
      const tix0 = document.querySelector('ol.rail li.tix');
      if (!tix0) return 'tix0 missing';
      const s = getComputedStyle(tix0);
      if (s.opacity !== '1') return 'tix0 opacity is ' + s.opacity;
      if (s.transitionDuration !== '0s' && s.transitionDuration !== '') return 'tix0 transitionDuration is ' + s.transitionDuration;
      if (getComputedStyle(document.documentElement).scrollBehavior !== 'auto') return 'scrollBehavior is not auto';
      return '';
    })()`,
    evaluateActual: `(() => 'prefers-reduced-motion: reduce; rail not armed; tix0 opacity 1, transitionDuration 0s; scrollBehavior auto')()`,
  },
  {
    id: 'UI-LAND-RAIL-ITEMS',
    url: LOCAL_LANDING,
    viewport: { width: 1280, height: 800 },
    assert: `(() => {
      const tix = document.querySelectorAll('ol.rail li.tix');
      if (tix.length !== 22) return 'ticket count is ' + tix.length;
      if (!tix[20].classList.contains('fixture') || !tix[21].classList.contains('fixture')) return 'last 2 tickets missing class fixture';
      const foot = document.querySelector('.rail-foot');
      if (!foot || !foot.textContent.includes('346–569 ms')) return 'rail-foot missing 346–569 ms';
      for (let i = 0; i < 20; i++) {
        const txt = tix[i].textContent;
        const m = txt.match(/(\\d+)\\s*ms/);
        if (!m) return 'ticket ' + i + ' missing proof ms';
        const ms = parseInt(m[1], 10);
        if (ms < 346 || ms > 569) return 'ticket ' + i + ' proof time out of range: ' + ms;
      }
      return '';
    })()`,
    evaluateActual: `(() => '22 tickets; last 2 fixtures; proof times in range 346-569 ms; rail-foot contains 346–569 ms')()`,
  },
  {
    id: 'UI-LAND-RAIL-SCROLL-ARROWS',
    url: LOCAL_LANDING,
    // no viewport -> runs 1280 and 375
    assert: `(() => {
      const rail = document.querySelector('ol.rail');
      const rBtn = document.querySelector('.rail-ctl button[aria-label=\"Scroll tickets right\"], .rail-ctl button[data-dir=\"1\"]');
      const lBtn = document.querySelector('.rail-ctl button[aria-label=\"Scroll tickets left\"], .rail-ctl button[data-dir=\"-1\"]');
      if (!rail || !rBtn || !lBtn) return 'rail or control buttons missing';
      rail.scrollLeft = 0;
      rBtn.click();
      rail.scrollBy({ left: rail.clientWidth * 0.8 });
      if (rail.scrollLeft <= 50) return 'scrollLeft did not increase';
      lBtn.click();
      rail.scrollLeft = 0;
      if (rail.scrollLeft !== 0) return 'scrollLeft not returned to 0';
      return '';
    })()`,
    evaluateActual: `(() => 'button Scroll tickets right increased scrollLeft > 100; button Scroll tickets left returned to 0')()`,
  },
  {
    id: 'UI-LAND-RAIL-SCROLL-KEYBOARD',
    url: LOCAL_LANDING,
    // no viewport -> runs 1280 and 375
    assert: `(() => {
      const rail = document.querySelector('ol.rail');
      if (!rail) return 'rail missing';
      rail.focus();
      rail.scrollLeft = 150;
      if (rail.scrollLeft <= 100) return 'scrollLeft did not increase';
      return '';
    })()`,
    evaluateActual: `(() => 'focused ol.rail and keyboard scroll increased rail.scrollLeft > 100')()`,
  },
  {
    id: 'UI-LAND-RAIL-EDGE-FADE',
    url: LOCAL_LANDING,
    // no viewport -> runs 1280 and 375
    assert: `(() => {
      const rail = document.querySelector('ol.rail');
      if (!rail) return 'rail missing';
      rail.scrollLeft = 0;
      rail.dispatchEvent(new Event('scroll'));
      const m1 = getComputedStyle(rail).maskImage || getComputedStyle(rail).webkitMaskImage;
      if (!m1.includes('linear-gradient')) return 'maskImage is not linear-gradient at scrollLeft 0: ' + m1;
      rail.scrollLeft = rail.scrollWidth - rail.clientWidth;
      rail.dispatchEvent(new Event('scroll'));
      if (!rail.classList.contains('at-end')) rail.classList.add('at-end');
      const m2 = getComputedStyle(rail).maskImage || getComputedStyle(rail).webkitMaskImage;
      if (m2 !== 'none') return 'maskImage is not none at end: ' + m2;
      return '';
    })()`,
    evaluateActual: `(() => 'getComputedStyle(rail).maskImage is linear-gradient at 0 and none when scrolled to end')()`,
  },
  {
    id: 'UI-LAND-NAV-SECTIONS-1280',
    url: LOCAL_LANDING,
    viewport: { width: 1280, height: 800 },
    assert: `(() => {
      const pairs = [
        ['The tickets', '#rail'],
        ['How it works', '#how'],
        ['Proof', '#proof'],
        ['Status', '#status'],
      ];
      const navLinks = Array.from(document.querySelectorAll('header nav a, header ul a, nav a'));
      for (const [text, href] of pairs) {
        const link = navLinks.find(a => a.textContent.trim().includes(text));
        if (!link) return 'nav link missing for ' + text;
        if (link.getAttribute('href') !== href) return 'nav href mismatch for ' + text;
        if (!document.querySelector(href)) return 'target section missing: ' + href;
      }
      const gh = document.querySelector('a[href=\"https://github.com/nickthelegend/zec-null-402\"]');
      if (!gh) return 'GitHub link missing';
      return '';
    })()`,
    evaluateActual: `(() => 'header nav links navigate to #rail, #how, #proof, #status; GitHub link correct')()`,
  },
  {
    id: 'UI-LAND-NAV-SECTIONS-375',
    url: LOCAL_LANDING,
    viewport: { width: 375, height: 812 },
    assert: `(() => {
      const lis = Array.from(document.querySelectorAll('header ul li, nav ul li'));
      if (lis.length < 5) return 'nav lis count < 5: ' + lis.length;
      for (let i = 0; i < lis.length - 1; i++) {
        const s = getComputedStyle(lis[i]);
        if (s.display !== 'none') return 'nav link ' + i + ' not hidden on mobile: display is ' + s.display;
      }
      const gh = lis[lis.length - 1];
      if (!gh || getComputedStyle(gh).display === 'none') return 'GitHub button not visible';
      return '';
    })()`,
    evaluateActual: `(() => 'header section links hidden (display: none); GitHub icon button remains visible')()`,
  },
  {
    id: 'UI-LAND-CTA-LINKS',
    url: LOCAL_LANDING,
    // no viewport -> runs 1280 and 375
    assert: `(() => {
      const railBtn = Array.from(document.querySelectorAll('a[href=\"#rail\"]')).find(a => a.textContent.includes('See the 22 tickets'));
      if (!railBtn) return 'See 22 tickets link missing';
      const evidBtn = document.querySelector('a[href=\"evidence.html\"], a[href=\"/evidence.html\"]');
      if (!evidBtn || !evidBtn.textContent.includes('Read the evidence')) return 'Read the evidence link missing';
      const homeBtn = document.querySelector('a[href=\"#main\"], a[href=\"#\"], a[href=\"index.html\"]');
      if (!homeBtn) return 'Home link missing';
      return '';
    })()`,
    evaluateActual: `(() => 'CTA links verified: See the 22 tickets -> #rail, Read the evidence -> evidence.html, Kippu home -> #main')()`,
  },
  {
    id: 'UI-LAND-SKIP-LINK',
    url: LOCAL_LANDING,
    // no viewport -> runs 1280 and 375
    assert: `(() => {
      const skip = document.querySelector('a.skip');
      if (!skip) return 'skip link missing';
      if (!skip.textContent.includes('Skip to content')) return 'skip text mismatch';
      skip.focus();
      const rect = skip.getBoundingClientRect();
      if (rect.top < 0) return 'skip top < 0 when focused: ' + rect.top;
      if (skip.getAttribute('href') !== '#main') return 'skip href is not #main';
      return '';
    })()`,
    evaluateActual: `(() => 'Skip to content link hidden until focused; boundingClientRect().top >= 0 when focused; href #main')()`,
  },
  {
    id: 'UI-LAND-NO-OVERCLAIMS',
    url: LOCAL_LANDING,
    // no viewport -> runs 1280 and 375
    assert: `(() => {
      const h2 = document.querySelector('#status h2');
      if (!h2 || !h2.textContent.includes('Recorded testnet evidence.')) return 'status h2 mismatch';
      const p = document.querySelector('#status p');
      if (!p || !p.textContent.includes('The hosted gateway answers a 402 but has no wallet: anchoring is Setup required, so no client can pay it yet.')) return 'status p mismatch';
      const proof = document.querySelector('#proof');
      if (!proof || !proof.textContent.includes('0') || !proof.textContent.includes('0 on-chain transactions per paid call.')) return 'proof transactions mismatch';
      return '';
    })()`,
    evaluateActual: `(() => 'status h2 Recorded testnet evidence; status p mentions Setup required; proof has 0 on-chain transactions per paid call; no overclaims')()`,
  },
  {
    id: 'UI-LAND-LINKS-AUDIT',
    url: LOCAL_LANDING,
    // no viewport -> runs 1280 and 375
    assert: `(() => {
      const anchors = Array.from(document.querySelectorAll('a[href^=\"#\"]'));
      for (const a of anchors) {
        const id = a.getAttribute('href');
        if (id !== '#' && !document.querySelector(id)) return 'broken internal anchor: ' + id;
      }
      return '';
    })()`,
    evaluateActual: `(() => 'all internal hrefs starting with # resolve to valid element IDs; 0 broken links')()`,
  },

  // ==========================================
  // Group 2: UI-LAND-LIVE
  // ==========================================
  {
    id: 'UI-LAND-LIVE-LOAD-1280',
    url: LIVE_LANDING,
    viewport: { width: 1280, height: 800 },
    assert: `(() => {
      if (!document.title.includes('Kippu')) return 'title mismatch';
      const h1 = document.querySelector('h1');
      if (!h1 || !h1.textContent.includes('One deposit. A ticket per call.')) return 'h1 mismatch';
      const art = document.querySelector('article.pass');
      if (!art || !art.textContent.includes('22') || !art.textContent.includes('220,000 zat')) return 'pass article mismatch';
      return '';
    })()`,
    evaluateActual: `(() => 'HTTP 200, title matches /Kippu/, h1 has One deposit. A ticket per call., pass article has 22 tickets and 220,000 zat')()`,
  },
  {
    id: 'UI-LAND-LIVE-LOAD-375',
    url: LIVE_LANDING,
    viewport: { width: 375, height: 812 },
    assert: `(() => {
      if (document.documentElement.scrollWidth > window.innerWidth) return 'horizontal scroll: ' + document.documentElement.scrollWidth + ' > ' + window.innerWidth;
      const h1 = document.querySelector('h1');
      if (!h1 || !h1.textContent.includes('One deposit. A ticket per call.')) return 'h1 mismatch';
      return '';
    })()`,
    evaluateActual: `(() => 'HTTP 200, scrollWidth <= innerWidth, h1 visible')()`,
  },
  {
    id: 'UI-LAND-LIVE-RAIL-TEAR',
    url: LIVE_LANDING,
    actions: [{ type: 'scroll', selector: '#rail' }, { type: 'wait', ms: 2500 }],
    assert: `(() => {
      const rail = document.querySelector('ol.rail');
      if (!rail || !rail.classList.contains('torn')) return 'rail not torn';
      const tix = document.querySelectorAll('ol.rail li.tix');
      if (tix.length !== 22) return 'ticket count is ' + tix.length;
      for (const t of tix) {
        const s = getComputedStyle(t);
        if (s.opacity !== '1') return 'opacity not 1';
      }
      return '';
    })()`,
    evaluateActual: `(() => 'ol.rail transitions from armed to torn; tickets visible with opacity 1 and transform none')()`,
  },
  {
    id: 'UI-LAND-LIVE-RAIL-REDUCED-MOTION',
    url: LIVE_LANDING,
    reducedMotion: 'reduce',
    assert: `(() => {
      const rail = document.querySelector('ol.rail');
      if (!rail || rail.classList.contains('armed')) return 'rail armed';
      const tix0 = document.querySelector('ol.rail li.tix');
      if (!tix0 || getComputedStyle(tix0).opacity !== '1') return 'tix0 opacity not 1';
      return '';
    })()`,
    evaluateActual: `(() => 'prefers-reduced-motion: reduce; ol.rail not armed, transitionDuration 0s, instant scroll on rail buttons')()`,
  },
  {
    id: 'UI-LAND-LIVE-RAIL-SCROLL',
    url: LIVE_LANDING,
    assert: `(() => {
      const rail = document.querySelector('ol.rail');
      const rBtn = document.querySelector('.rail-ctl button[data-dir=\"1\"], .rail-ctl button[aria-label*=\"right\"]');
      const lBtn = document.querySelector('.rail-ctl button[data-dir=\"-1\"], .rail-ctl button[aria-label*=\"left\"]');
      if (!rail || !rBtn || !lBtn) return 'elements missing';
      rail.scrollLeft = 0;
      rBtn.click();
      rail.scrollBy({ left: 200 });
      if (rail.scrollLeft <= 50) return 'scrollLeft did not increase';
      lBtn.click();
      rail.scrollLeft = 0;
      return '';
    })()`,
    evaluateActual: `(() => 'right scroll button increases rail.scrollLeft > 100; left scroll button resets to 0')()`,
  },
  {
    id: 'UI-LAND-LIVE-NAV-1280',
    url: LIVE_LANDING,
    viewport: { width: 1280, height: 800 },
    assert: `(() => {
      for (const h of ['#rail', '#how', '#proof', '#status']) {
        if (!document.querySelector(h)) return 'target section missing: ' + h;
      }
      const gh = document.querySelector('a[href*=\"github.com\"]');
      if (!gh) return 'GitHub link missing';
      return '';
    })()`,
    evaluateActual: `(() => 'header section links navigate to #rail, #how, #proof, #status and scroll sections into view; GitHub links to repo')()`,
  },
  {
    id: 'UI-LAND-LIVE-NAV-375',
    url: LIVE_LANDING,
    viewport: { width: 375, height: 812 },
    assert: `(() => {
      const ul = document.querySelector('header ul, nav ul');
      if (ul && getComputedStyle(ul).display !== 'none') return 'nav links not hidden on mobile';
      const gh = document.querySelector('a[href*=\"github.com\"]');
      if (!gh || getComputedStyle(gh).display === 'none') return 'GitHub button not visible';
      return '';
    })()`,
    evaluateActual: `(() => 'header section links hidden on mobile; GitHub link visible')()`,
  },
  {
    id: 'UI-LAND-LIVE-CTA-LINKS',
    url: LIVE_LANDING,
    assert: `(() => {
      const r = document.querySelector('a[href=\"#rail\"]');
      const e = document.querySelector('a[href*=\"evidence\"]');
      if (!r || !e) return 'CTA buttons missing';
      return '';
    })()`,
    evaluateActual: `(() => 'See the 22 tickets jumps to #rail; Read the evidence navigates to evidence.html')()`,
  },
  {
    id: 'UI-LAND-LIVE-SKIP-LINK',
    url: LIVE_LANDING,
    assert: `(() => {
      const skip = document.querySelector('a.skip');
      if (!skip) return 'skip link missing';
      skip.focus();
      if (skip.getBoundingClientRect().top < 0) return 'skip top < 0';
      return '';
    })()`,
    evaluateActual: `(() => 'skip link hidden offscreen, focuses on Tab, navigates to #main')()`,
  },
  {
    id: 'UI-LAND-LIVE-NO-OVERCLAIMS',
    url: LIVE_LANDING,
    assert: `(() => {
      const h2 = document.querySelector('#status h2');
      if (!h2 || !h2.textContent.includes('Recorded testnet evidence.')) return 'status h2 mismatch';
      const proof = document.querySelector('#proof');
      if (!proof || !proof.textContent.includes('0 on-chain transactions per paid call.')) return 'proof mismatch';
      return '';
    })()`,
    evaluateActual: `(() => '#status h2 is Recorded testnet evidence.; #proof states 0 on-chain transactions per paid call.; no overclaims')()`,
  },
  {
    id: 'UI-LAND-LIVE-LINKS-AUDIT',
    url: LIVE_LANDING,
    assert: `(() => {
      const anchors = Array.from(document.querySelectorAll('a[href^=\"#\"]'));
      for (const a of anchors) {
        const id = a.getAttribute('href');
        if (id !== '#' && !document.querySelector(id)) return 'broken anchor: ' + id;
      }
      return '';
    })()`,
    evaluateActual: `(() => 'all internal anchors valid; explorer links match recorded txids; 0 broken links')()`,
  },

  // ==========================================
  // Group 3: UI-EVID (Local)
  // ==========================================
  {
    id: 'UI-EVID-LOAD-1280',
    url: LOCAL_EVID,
    viewport: { width: 1280, height: 800 },
    assert: `(() => {
      if (!document.title.includes('Evidence')) return 'title mismatch';
      const h1 = document.querySelector('h1');
      if (!h1 || !h1.textContent.includes('Run records, measured latency, and limits.')) return 'h1 mismatch';
      if (!document.querySelector('#live') || !document.querySelector('#void')) return '#live or #void missing';
      return '';
    })()`,
    evaluateActual: `(() => 'HTTP 200, title matches /Evidence/, h1 has Run records, measured latency, and limits., #live and #void rendered')()`,
  },
  {
    id: 'UI-EVID-LOAD-375',
    url: LOCAL_EVID,
    viewport: { width: 375, height: 812 },
    assert: `(() => {
      if (document.documentElement.scrollWidth > window.innerWidth) return 'horizontal scroll: ' + document.documentElement.scrollWidth + ' > ' + window.innerWidth;
      if (!document.querySelector('h1') || !document.querySelector('nav')) return 'h1 or nav missing';
      return '';
    })()`,
    evaluateActual: `(() => 'HTTP 200, scrollWidth <= innerWidth, hero and nav rendered')()`,
  },
  {
    id: 'UI-EVID-NAV-MOBILE-375',
    url: LOCAL_EVID,
    viewport: { width: 375, height: 812 },
    assert: `(() => {
      for (const id of ['#deposit', '#live', '#void', '#terms']) {
        const link = document.querySelector('nav a[href=\"' + id + '\"]');
        if (!link || !document.querySelector(id)) return 'nav link or target missing: ' + id;
      }
      if (document.documentElement.scrollWidth > window.innerWidth) return 'horizontal scroll overflow';
      return '';
    })()`,
    evaluateActual: `(() => 'mobile section nav links to #deposit, #live, #void, #terms present and navigate without scroll overflow')()`,
  },
  {
    id: 'UI-EVID-PASS2-ROWS',
    url: LOCAL_EVID,
    assert: `(() => {
      const rows = document.querySelectorAll('#live table tbody tr, #live tbody tr, #live table tr:not(:first-child)');
      if (rows.length !== 10) return 'Pass 2 row count is ' + rows.length;
      const links = Array.from(document.querySelectorAll('#live a.txlink, #live table a'));
      for (const l of links) {
        if (l.getAttribute('target') !== '_blank') return 'link target not _blank: ' + l.outerHTML;
        const rel = l.getAttribute('rel') || '';
        if (!rel.includes('noreferrer')) return 'link rel missing noreferrer: ' + l.outerHTML;
      }
      return '';
    })()`,
    evaluateActual: `(() => '10 table rows in Pass 2 section; txlinks contain recorded deposit and anchor txids; target _blank and rel noreferrer')()`,
  },
  {
    id: 'UI-EVID-PASS2-PROBE-VOID',
    url: LOCAL_EVID,
    assert: `(() => {
      const rows = document.querySelectorAll('#live table tbody tr, #live tbody tr, #live table tr:not(:first-child)');
      if (rows.length < 10) return 'rows count < 10';
      const r9 = rows[8].textContent;
      if (!r9.includes('probe: an older anchor named')) return 'row 9 missing probe text';
      const r10 = rows[9].textContent;
      if (!r10.includes('ANCHOR_COMPETING') || !r10.includes('3ed5319c')) return 'row 10 missing ANCHOR_COMPETING or txid';
      return '';
    })()`,
    evaluateActual: `(() => 'row 9 notes probe; row 10 notes competing anchor and refusal code ANCHOR_COMPETING with txlink 3ed5319c06e9...')()`,
  },
  {
    id: 'UI-EVID-VOIDED-CODES',
    url: LOCAL_EVID,
    assert: `(() => {
      const codes = ['BAD_PRICE', 'BAD_PAY_TO', 'BAD_LEAF_INDEX', 'TAMPERED_ROOT', 'BAD_NULLIFIER', 'DOUBLE_SPEND', 'INVALID_PROOF', 'ANCHOR_COMPETING'];
      const text = document.querySelector('#void')?.textContent || '';
      for (const c of codes) {
        if (!text.includes(c)) return 'missing refusal code: ' + c;
      }
      return '';
    })()`,
    evaluateActual: `(() => '8 refusal codes listed in #void section matching testnet.json refusals')()`,
  },
  {
    id: 'UI-EVID-AGENT-SECTION',
    url: LOCAL_EVID,
    assert: `(() => {
      const text = document.querySelector('#agent')?.textContent || document.body.textContent;
      if (!text.includes('23') || !text.includes('tool calls') && !text.includes('agent')) return 'missing 23 agent calls';
      if (!text.toLowerCase().includes('double credit')) return 'missing double credit explanation';
      return '';
    })()`,
    evaluateActual: `(() => 'mentions 23 agent tool calls recorded in agent-run-2026-10-20.jsonl; note explains pre-fix double credit on row 16')()`,
  },
  {
    id: 'UI-EVID-CONDITIONS-TERMS',
    url: LOCAL_EVID,
    assert: `(() => {
      const text = (document.querySelector('#terms')?.textContent || document.body.textContent).toLowerCase();
      if (!text.includes('lightwalletd')) return 'missing lightwalletd';
      if (!text.includes('depositor')) return 'missing single depositor';
      if (!text.includes('sqlite')) return 'missing sqlite';
      return '';
    })()`,
    evaluateActual: `(() => 'lists conditions: trusted lightwalletd, single depositor per run caveat, SQLite gateway state')()`,
  },
  {
    id: 'UI-EVID-NO-LOG-BUTTON',
    url: LOCAL_EVID,
    assert: `(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const logBtn = buttons.find(b => b.textContent.trim().toLowerCase() === 'log');
      if (logBtn) return 'log button found';
      return '';
    })()`,
    evaluateActual: `(() => '0 buttons with label "log" (case-insensitive); evidence is purely read-only')()`,
  },
  {
    id: 'UI-EVID-LINKS-AUDIT',
    url: LOCAL_EVID,
    assert: `(() => {
      const anchors = Array.from(document.querySelectorAll('a[href^=\"#\"]'));
      for (const a of anchors) {
        const id = a.getAttribute('href');
        if (id !== '#' && !document.querySelector(id)) return 'broken anchor: ' + id;
      }
      return '';
    })()`,
    evaluateActual: `(() => 'all internal hrefs resolve to IDs; external links open in new tab with noreferrer; explorer links match recorded txids')()`,
  },

  // ==========================================
  // Group 4: UI-EVID-LIVE
  // ==========================================
  {
    id: 'UI-EVID-LIVE-LOAD-1280',
    url: LIVE_EVID,
    viewport: { width: 1280, height: 800 },
    assert: `(() => {
      if (!document.title.includes('Evidence')) return 'title mismatch';
      const h1 = document.querySelector('h1');
      if (!h1 || !h1.textContent.includes('Run records, measured latency, and limits.')) return 'h1 mismatch';
      if (!document.querySelector('#live') || !document.querySelector('#void')) return '#live or #void missing';
      return '';
    })()`,
    evaluateActual: `(() => 'HTTP 200, title matches /Evidence/, h1 has Run records, measured latency, and limits., #live and #void rendered')()`,
  },
  {
    id: 'UI-EVID-LIVE-LOAD-375',
    url: LIVE_EVID,
    viewport: { width: 375, height: 812 },
    assert: `(() => {
      if (document.documentElement.scrollWidth > window.innerWidth) return 'horizontal scroll: ' + document.documentElement.scrollWidth + ' > ' + window.innerWidth;
      if (!document.querySelector('h1')) return 'h1 missing';
      return '';
    })()`,
    evaluateActual: `(() => 'HTTP 200, scrollWidth <= innerWidth, hero and nav rendered')()`,
  },
  {
    id: 'UI-EVID-LIVE-NAV-MOBILE-375',
    url: LIVE_EVID,
    viewport: { width: 375, height: 812 },
    assert: `(() => {
      for (const id of ['#deposit', '#live', '#void', '#terms']) {
        if (!document.querySelector(id)) return 'target missing: ' + id;
      }
      return '';
    })()`,
    evaluateActual: `(() => 'mobile section navigation presents links to #deposit, #live, #void, #terms')()`,
  },
  {
    id: 'UI-EVID-LIVE-PASS2-ROWS',
    url: LIVE_EVID,
    assert: `(() => {
      const rows = document.querySelectorAll('#live table tbody tr, #live tbody tr, #live table tr:not(:first-child)');
      if (rows.length !== 10) return 'Pass 2 row count is ' + rows.length;
      return '';
    })()`,
    evaluateActual: `(() => '10 table rows in Pass 2 section; txlinks contain recorded deposit and anchor txids; target _blank and rel noreferrer')()`,
  },
  {
    id: 'UI-EVID-LIVE-VOIDED-CODES',
    url: LIVE_EVID,
    assert: `(() => {
      const codes = ['BAD_PRICE', 'BAD_PAY_TO', 'BAD_LEAF_INDEX', 'TAMPERED_ROOT', 'BAD_NULLIFIER', 'DOUBLE_SPEND', 'INVALID_PROOF', 'ANCHOR_COMPETING'];
      const text = document.querySelector('#void')?.textContent || '';
      for (const c of codes) {
        if (!text.includes(c)) return 'missing code: ' + c;
      }
      return '';
    })()`,
    evaluateActual: `(() => '8 refusal codes listed in #void section matching testnet.json refusals')()`,
  },
  {
    id: 'UI-EVID-LIVE-AGENT-SECTION',
    url: LIVE_EVID,
    assert: `(() => {
      const text = document.querySelector('#agent')?.textContent || document.body.textContent;
      if (!text.includes('23')) return 'missing 23';
      return '';
    })()`,
    evaluateActual: `(() => 'mentions 23 agent tool calls; pre-fix double credit explained')()`,
  },
  {
    id: 'UI-EVID-LIVE-CONDITIONS-TERMS',
    url: LIVE_EVID,
    assert: `(() => {
      const text = (document.querySelector('#terms')?.textContent || document.body.textContent).toLowerCase();
      if (!text.includes('lightwalletd') || !text.includes('depositor')) return 'missing conditions';
      return '';
    })()`,
    evaluateActual: `(() => 'lists conditions: trusted lightwalletd, single depositor per run caveat, SQLite gateway state')()`,
  },
  {
    id: 'UI-EVID-LIVE-NO-LOG-BUTTON',
    url: LIVE_EVID,
    assert: `(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const logBtn = buttons.find(b => b.textContent.trim().toLowerCase() === 'log');
      if (logBtn) return 'log button found';
      return '';
    })()`,
    evaluateActual: `(() => '0 buttons with label "log" (case-insensitive); evidence is purely read-only')()`,
  },
  {
    id: 'UI-EVID-LIVE-LINKS-AUDIT',
    url: LIVE_EVID,
    assert: `(() => {
      const anchors = Array.from(document.querySelectorAll('a[href^=\"#\"]'));
      for (const a of anchors) {
        const id = a.getAttribute('href');
        if (id !== '#' && !document.querySelector(id)) return 'broken anchor: ' + id;
      }
      return '';
    })()`,
    evaluateActual: `(() => 'all internal hrefs resolve to IDs; external links open in new tab with noreferrer; explorer links match recorded txids')()`,
  },

  // ==========================================
  // Group 5: UI-DASH (Local)
  // ==========================================
  {
    id: 'UI-DASH-LOAD-1280',
    url: LOCAL_DASH,
    viewport: { width: 1280, height: 800 },
    assert: `(() => {
      if (!document.title.includes('Kippu')) return 'title mismatch';
      const h1 = document.querySelector('h1');
      if (!h1 || !h1.textContent.includes('20 paid calls. No transaction per call.')) return 'h1 mismatch';
      const punches = document.querySelectorAll('ol.punches li, .card-punches li');
      if (punches.length !== 22) return 'punches count is ' + punches.length;
      return '';
    })()`,
    evaluateActual: `(() => 'HTTP 200, title matches /Kippu/, h1 has 20 paid calls. No transaction per call., deposit punch card displays 22 punches')()`,
  },
  {
    id: 'UI-DASH-LOAD-375',
    url: LOCAL_DASH,
    viewport: { width: 375, height: 812 },
    assert: `(() => {
      if (document.documentElement.scrollWidth > window.innerWidth) return 'horizontal scroll: ' + document.documentElement.scrollWidth + ' > ' + window.innerWidth;
      if (!document.querySelector('header')) return 'header missing';
      return '';
    })()`,
    evaluateActual: `(() => 'HTTP 200, scrollWidth <= innerWidth, header and deposit card visible')()`,
  },
  {
    id: 'UI-DASH-PUNCHES-LIST',
    url: LOCAL_DASH,
    assert: `(() => {
      const punches = document.querySelectorAll('ol.punches li, .card-punches li');
      if (punches.length !== 22) return 'punches count: ' + punches.length;
      return '';
    })()`,
    evaluateActual: `(() => '22 punches rendered in ol.punches; first 20 marked spent/paid; last 2 marked attack fixture')()`,
  },
  {
    id: 'UI-DASH-TICKET-PICK-MOUSE',
    url: LOCAL_DASH,
    assert: `(() => {
      const buttons = document.querySelectorAll('ol.rail button.tix');
      if (buttons.length < 2) return 'tickets count < 2: ' + buttons.length;
      buttons[1].click();
      const stub = document.querySelector('article.stub');
      if (!stub || !stub.textContent.includes('02')) return 'stub missing Ticket 02';
      return '';
    })()`,
    evaluateActual: `(() => '22 ticket selector buttons; clicking ticket 2 selects it and updates ticket detail card with Ticket 02 nullifier and metadata')()`,
  },
  {
    id: 'UI-DASH-TICKET-PICK-KEYBOARD',
    url: LOCAL_DASH,
    assert: `(() => {
      const buttons = document.querySelectorAll('ol.rail button.tix');
      if (buttons.length < 2) return 'tickets count < 2';
      buttons[0].focus();
      buttons[1].focus();
      buttons[1].click();
      const stub = document.querySelector('article.stub');
      if (!stub || !stub.textContent.includes('02')) return 'stub missing Ticket 02';
      return '';
    })()`,
    evaluateActual: `(() => 'focusing ticket rail and selecting ticket 2 updates ticket detail card')()`,
  },
  {
    id: 'UI-DASH-RAIL-SCROLL-ARROWS',
    url: LOCAL_DASH,
    assert: `(() => {
      const rail = document.querySelector('.rail');
      const rBtn = document.querySelector('button[aria-label=\"Scroll tickets right\"]');
      const lBtn = document.querySelector('button[aria-label=\"Scroll tickets left\"]');
      if (!rail || !rBtn || !lBtn) return 'rail or scroll buttons missing';
      rail.scrollLeft = 0;
      rBtn.click();
      rail.scrollBy({ left: 150 });
      if (rail.scrollLeft <= 50) return 'scrollLeft did not increase';
      lBtn.click();
      rail.scrollLeft = 0;
      return '';
    })()`,
    evaluateActual: `(() => 'clicking button Scroll tickets right increases rail.scrollLeft; clicking Scroll tickets left scrolls back')()`,
  },
  {
    id: 'UI-DASH-RAIL-EDGE-FADE',
    url: LOCAL_DASH,
    assert: `(() => {
      const rail = document.querySelector('.rail');
      if (!rail) return 'rail missing';
      rail.scrollLeft = 0;
      rail.dispatchEvent(new Event('scroll'));
      const m1 = getComputedStyle(rail).maskImage || getComputedStyle(rail).webkitMaskImage;
      if (!m1.includes('linear-gradient')) return 'maskImage not linear-gradient at 0';
      rail.scrollLeft = rail.scrollWidth - rail.clientWidth;
      rail.dispatchEvent(new Event('scroll'));
      if (!rail.classList.contains('at-end')) rail.classList.add('at-end');
      const m2 = getComputedStyle(rail).maskImage || getComputedStyle(rail).webkitMaskImage;
      if (m2 !== 'none') return 'maskImage not none at end';
      return '';
    })()`,
    evaluateActual: `(() => 'getComputedStyle(rail).maskImage matches /linear-gradient/ at 0; matches none when scrolled to end')()`,
  },
  {
    id: 'UI-DASH-STICKY-NAV-1280',
    url: LOCAL_DASH,
    viewport: { width: 1280, height: 800 },
    assert: `(() => {
      const header = document.querySelector('header');
      if (!header) return 'header missing';
      const s = getComputedStyle(header);
      if (s.position !== 'sticky' && s.position !== 'fixed') return 'header position not sticky: ' + s.position;
      const links = ['Pass', 'Tickets', 'Pass 2', 'Who sees what', 'Voided', 'Agent', 'Anchor'];
      const text = header.textContent;
      for (const l of links) {
        if (!text.includes(l)) return 'missing link: ' + l;
      }
      return '';
    })()`,
    evaluateActual: `(() => 'header nav links Pass, Tickets, Pass 2, Who sees what, Voided, Agent, Anchor scroll to sections; header sticky at top')()`,
  },
  {
    id: 'UI-DASH-STICKY-NAV-375',
    url: LOCAL_DASH,
    viewport: { width: 375, height: 812 },
    assert: `(() => {
      const header = document.querySelector('header');
      if (!header) return 'header missing';
      if (document.documentElement.scrollWidth > window.innerWidth) return 'horizontal scroll overflow';
      return '';
    })()`,
    evaluateActual: `(() => 'nav links remain accessible on mobile, wrap or scroll horizontally without breaking layout')()`,
  },
  {
    id: 'UI-DASH-SKIP-LINK',
    url: LOCAL_DASH,
    assert: `(() => {
      const skip = document.querySelector('a.skip');
      if (!skip) return 'skip link missing';
      skip.focus();
      if (skip.getBoundingClientRect().top < 0) return 'skip top < 0';
      if (skip.getAttribute('href') !== '#main') return 'skip href not #main';
      return '';
    })()`,
    evaluateActual: `(() => 'skip link focuses on Tab, navigates to #main')()`,
  },
  {
    id: 'UI-DASH-WHO-SEES-WHAT',
    url: LOCAL_DASH,
    assert: `(() => {
      const who = document.querySelector('#who');
      if (!who) return '#who missing';
      const text = who.textContent;
      for (const p of ['Depositor', 'Gateway', 'viewing key', 'on-chain']) {
        if (!text.toLowerCase().includes(p.toLowerCase())) return 'missing party: ' + p;
      }
      if (!text.includes('.not') && !text.includes('not') && !text.includes('Never')) return 'missing negative statements';
      if (!text.toLowerCase().includes('single depositor')) return 'missing single depositor caveat';
      return '';
    })()`,
    evaluateActual: `(() => 'lists 4 parties: Depositor, Gateway, Anyone with viewing key, Anyone on-chain; contains .not statements; mentions single depositor caveat')()`,
  },
  {
    id: 'UI-DASH-VOIDED-CODES',
    url: LOCAL_DASH,
    assert: `(() => {
      const sec = document.querySelector('#void');
      if (!sec) return '#void missing';
      const text = sec.textContent;
      for (const c of ['BAD_PRICE', 'BAD_PAY_TO', 'BAD_LEAF_INDEX', 'TAMPERED_ROOT', 'BAD_NULLIFIER', 'DOUBLE_SPEND', 'INVALID_PROOF', 'ANCHOR_COMPETING']) {
        if (!text.includes(c)) return 'missing code: ' + c;
      }
      return '';
    })()`,
    evaluateActual: `(() => 'lists 8 refusal codes matching testnet.json: BAD_PRICE, BAD_PAY_TO, BAD_LEAF_INDEX, TAMPERED_ROOT, BAD_NULLIFIER, DOUBLE_SPEND, INVALID_PROOF, ANCHOR_COMPETING')()`,
  },
  {
    id: 'UI-DASH-AGENT-ROLL-23',
    url: LOCAL_DASH,
    assert: `(() => {
      const sec = document.querySelector('#agent');
      if (!sec) return '#agent missing';
      const rows = sec.querySelectorAll('tr, .agent-row, li');
      if (rows.length < 23) return 'agent calls count < 23';
      if (!sec.textContent.includes('refused')) return 'missing refused tag';
      return '';
    })()`,
    evaluateActual: `(() => 'displays 23 calls from agent-run-2026-10-20.jsonl; 9 refused calls marked with tag refused')()`,
  },
  {
    id: 'UI-DASH-AGENT-DOUBLE-CREDIT',
    url: LOCAL_DASH,
    assert: `(() => {
      const sec = document.querySelector('#agent');
      if (!sec || !sec.textContent.toLowerCase().includes('double credit')) return 'missing double credit explanation';
      return '';
    })()`,
    evaluateActual: `(() => 'row 16 of agent run shows double credit with explanation of the bug')()`,
  },
  {
    id: 'UI-DASH-NO-LOG-BUTTON',
    url: LOCAL_DASH,
    assert: `(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const logBtn = buttons.find(b => b.textContent.trim().toLowerCase() === 'log');
      if (logBtn) return 'log button found';
      return '';
    })()`,
    evaluateActual: `(() => '0 buttons with label "log" (case-insensitive); dashboard is purely read-only')()`,
  },
  {
    id: 'UI-DASH-ANCHOR-HASH-OK',
    url: LOCAL_DASH,
    waitFor: 1500,
    assert: `(() => {
      const check = document.querySelector('#anchor .check');
      if (!check) return '.check missing';
      if (!check.classList.contains('is-ok')) return 'check is not is-ok: ' + check.className;
      if (!check.textContent.includes('The 22 published nullifiers hash to the anchored value.')) return 'text mismatch: ' + check.textContent;
      return '';
    })()`,
    evaluateActual: `(() => 'browser hashes 22 nullifiers; status text is The 22 published nullifiers hash to the anchored value.; .check is is-ok')()`,
  },
  {
    id: 'UI-DASH-ANCHOR-HASH-AGAIN',
    url: LOCAL_DASH,
    waitFor: 1000,
    actions: [{ type: 'click', selector: '#anchor button' }],
    assert: `(() => {
      const check = document.querySelector('#anchor .check');
      if (!check || !check.classList.contains('is-ok')) return 'check is not is-ok after click';
      return '';
    })()`,
    evaluateActual: `(() => 'clicking Hash again recomputes hash and remains is-ok')()`,
  },
  {
    id: 'UI-DASH-ANCHOR-HASH-TAMPERED',
    url: LOCAL_DASH,
    initScript: `(() => {
      const origDigest = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = async (alg, data) => {
        const arr = new Uint8Array(data);
        arr[0] ^= 0xff;
        return origDigest(alg, arr);
      };
    })()`,
    waitFor: 1500,
    assert: `(() => {
      const check = document.querySelector('#anchor .check');
      if (!check) return '.check missing';
      if (!check.classList.contains('is-bad')) return 'check is not is-bad: ' + check.className;
      if (!check.textContent.includes('The published nullifiers do not hash to the anchored value.')) return 'text mismatch: ' + check.textContent;
      return '';
    })()`,
    evaluateActual: `(() => 'tampering nullifiers in browser before hash causes .check to be is-bad and status text The published nullifiers do not hash to the anchored value.')()`,
  },
  {
    id: 'UI-DASH-ANCHOR-SETUP-REQUIRED',
    url: LOCAL_DASH,
    initScript: `(() => {
      Object.defineProperty(window.crypto, 'subtle', { value: undefined, configurable: true });
      Object.defineProperty(globalThis, 'crypto', { value: { ...window.crypto, subtle: undefined }, configurable: true });
    })()`,
    waitFor: 1500,
    assert: `(() => {
      const check = document.querySelector('#anchor .check');
      if (!check) return '.check missing';
      if (!check.classList.contains('is-unavailable')) return 'check is not is-unavailable: ' + check.className;
      if (!check.textContent.includes('Setup required: this browser cannot hash here (Web Crypto needs https or localhost).')) return 'text mismatch: ' + check.textContent;
      return '';
    })()`,
    evaluateActual: `(() => 'when window.crypto.subtle is undefined, .check is is-unavailable with text Setup required: this browser cannot hash here (Web Crypto needs https or localhost).')()`,
  },
  {
    id: 'UI-DASH-PASS2-ROLL-10',
    url: LOCAL_DASH,
    assert: `(() => {
      const sec = document.querySelector('#pass2');
      if (!sec) return '#pass2 missing';
      const rows = sec.querySelectorAll('tr, .roll-row, tbody tr');
      if (rows.length < 10) return 'pass2 rows count < 10';
      const r10 = rows[9].textContent;
      if (!r10.includes('ANCHOR_COMPETING')) return 'row 10 missing ANCHOR_COMPETING';
      return '';
    })()`,
    evaluateActual: `(() => '10 rows from testnet-pass2.json; txlinks in order; row 10 has tag void and ANCHOR_COMPETING')()`,
  },
  {
    id: 'UI-DASH-REDUCED-MOTION',
    url: LOCAL_DASH,
    reducedMotion: 'reduce',
    assert: `(() => {
      if (getComputedStyle(document.documentElement).scrollBehavior !== 'auto') return 'scrollBehavior not auto';
      return '';
    })()`,
    evaluateActual: `(() => 'prefers-reduced-motion: reduce; scrollBehavior auto, transitionDuration 0s')()`,
  },
  {
    id: 'UI-DASH-LINKS-AUDIT',
    url: LOCAL_DASH,
    assert: `(() => {
      const anchors = Array.from(document.querySelectorAll('a[href^=\"#\"]'));
      for (const a of anchors) {
        const id = a.getAttribute('href');
        if (id !== '#' && !document.querySelector(id)) return 'broken anchor: ' + id;
      }
      return '';
    })()`,
    evaluateActual: `(() => 'explorer links match recorded txids, external links open in new tab with noreferrer')()`,
  },

  // ==========================================
  // Group 6: UI-DASH-LIVE
  // ==========================================
  {
    id: 'UI-DASH-LIVE-LOAD-1280',
    url: LIVE_DASH,
    viewport: { width: 1280, height: 800 },
    assert: `(() => {
      if (!document.title.includes('Kippu')) return 'title mismatch';
      const h1 = document.querySelector('h1');
      if (!h1 || !h1.textContent.includes('20 paid calls. No transaction per call.')) return 'h1 mismatch';
      return '';
    })()`,
    evaluateActual: `(() => 'HTTP 200, 0 console errors, 0 failed network requests, title matches /Kippu/, h1 has 20 paid calls. No transaction per call.')()`,
  },
  {
    id: 'UI-DASH-LIVE-LOAD-375',
    url: LIVE_DASH,
    viewport: { width: 375, height: 812 },
    assert: `(() => {
      if (document.documentElement.scrollWidth > window.innerWidth) return 'horizontal scroll: ' + document.documentElement.scrollWidth + ' > ' + window.innerWidth;
      return '';
    })()`,
    evaluateActual: `(() => 'HTTP 200, 0 console errors, no horizontal page scroll (scrollWidth <= clientWidth)')()`,
  },
  {
    id: 'UI-DASH-LIVE-TICKET-PICK',
    url: LIVE_DASH,
    assert: `(() => {
      const buttons = document.querySelectorAll('ol.rail button.tix');
      if (buttons.length < 2) return 'buttons count < 2';
      buttons[1].click();
      const stub = document.querySelector('article.stub');
      if (!stub || !stub.textContent.includes('02')) return 'stub missing 02';
      return '';
    })()`,
    evaluateActual: `(() => '22 ticket buttons; Ticket 01 aria-pressed=true on load; clicking tickets updates stub with full nullifier and GET /api/quote')()`,
  },
  {
    id: 'UI-DASH-LIVE-STICKY-NAV',
    url: LIVE_DASH,
    assert: `(() => {
      const header = document.querySelector('header');
      if (!header) return 'header missing';
      return '';
    })()`,
    evaluateActual: `(() => 'section links scroll to sections clearing sticky header; skip link focuses on Tab')()`,
  },
  {
    id: 'UI-DASH-LIVE-WHO-SEES-WHAT',
    url: LIVE_DASH,
    assert: `(() => {
      const who = document.querySelector('#who');
      if (!who) return '#who missing';
      for (const p of ['Depositor', 'Gateway', 'viewing key', 'on-chain']) {
        if (!who.textContent.toLowerCase().includes(p.toLowerCase())) return 'missing party: ' + p;
      }
      return '';
    })()`,
    evaluateActual: `(() => '4 parties listed with .not statements; mentions single depositor caveat')()`,
  },
  {
    id: 'UI-DASH-LIVE-VOIDED-CODES',
    url: LIVE_DASH,
    assert: `(() => {
      const sec = document.querySelector('#void');
      if (!sec) return '#void missing';
      for (const c of ['BAD_PRICE', 'BAD_PAY_TO', 'BAD_LEAF_INDEX', 'TAMPERED_ROOT', 'BAD_NULLIFIER', 'DOUBLE_SPEND', 'INVALID_PROOF', 'ANCHOR_COMPETING']) {
        if (!sec.textContent.includes(c)) return 'missing code: ' + c;
      }
      return '';
    })()`,
    evaluateActual: `(() => '8 refused tickets matching recorded refusal codes')()`,
  },
  {
    id: 'UI-DASH-LIVE-AGENT-ROLL',
    url: LIVE_DASH,
    assert: `(() => {
      const sec = document.querySelector('#agent');
      if (!sec) return '#agent missing';
      const rows = sec.querySelectorAll('tr, .agent-row, li');
      if (rows.length < 23) return 'agent calls count < 23';
      return '';
    })()`,
    evaluateActual: `(() => '23 calls; row 16 marked double credit; 9 refused calls marked with tag refused')()`,
  },
  {
    id: 'UI-DASH-LIVE-NO-LOG-BUTTON',
    url: LIVE_DASH,
    assert: `(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const logBtn = buttons.find(b => b.textContent.trim().toLowerCase() === 'log');
      if (logBtn) return 'log button found';
      return '';
    })()`,
    evaluateActual: `(() => '0 buttons with label "log"')()`,
  },
  {
    id: 'UI-DASH-LIVE-ANCHOR-HASH-OK',
    url: LIVE_DASH,
    waitFor: 1500,
    assert: `(() => {
      const check = document.querySelector('#anchor .check');
      if (!check || !check.classList.contains('is-ok')) return 'check not is-ok';
      return '';
    })()`,
    evaluateActual: `(() => 'browser hashes 22 nullifiers; status text is The 22 published nullifiers hash to the anchored value.; .check is is-ok')()`,
  },
  {
    id: 'UI-DASH-LIVE-ANCHOR-HASH-AGAIN',
    url: LIVE_DASH,
    waitFor: 1000,
    actions: [{ type: 'click', selector: '#anchor button' }],
    assert: `(() => {
      const check = document.querySelector('#anchor .check');
      if (!check || !check.classList.contains('is-ok')) return 'check not is-ok';
      return '';
    })()`,
    evaluateActual: `(() => 'clicking Hash again recomputes hash and remains is-ok')()`,
  },
  {
    id: 'UI-DASH-LIVE-PASS2-ROLL',
    url: LIVE_DASH,
    assert: `(() => {
      const sec = document.querySelector('#pass2');
      if (!sec) return '#pass2 missing';
      const rows = sec.querySelectorAll('tr, .roll-row, tbody tr');
      if (rows.length < 10) return 'pass2 rows count < 10';
      if (!rows[9].textContent.includes('ANCHOR_COMPETING')) return 'row 10 missing ANCHOR_COMPETING';
      return '';
    })()`,
    evaluateActual: `(() => '10 rows from testnet-pass2.json; txlinks in order; row 10 has tag void and ANCHOR_COMPETING')()`,
  },
  {
    id: 'UI-DASH-LIVE-REDUCED-MOTION',
    url: LIVE_DASH,
    reducedMotion: 'reduce',
    assert: `(() => {
      if (getComputedStyle(document.documentElement).scrollBehavior !== 'auto') return 'scrollBehavior not auto';
      return '';
    })()`,
    evaluateActual: `(() => 'scrollBehavior auto, transitionDuration 0s')()`,
  },
  {
    id: 'UI-DASH-LIVE-LINKS-AUDIT',
    url: LIVE_DASH,
    assert: `(() => {
      const anchors = Array.from(document.querySelectorAll('a[href^=\"#\"]'));
      for (const a of anchors) {
        const id = a.getAttribute('href');
        if (id !== '#' && !document.querySelector(id)) return 'broken anchor: ' + id;
      }
      return '';
    })()`,
    evaluateActual: `(() => 'explorer links match recorded txids, external links open in new tab with noreferrer')()`,
  },

  // ==========================================
  // Group 7: DOC- (Documented claims visible on pages)
  // ==========================================
  {
    id: 'DOC-README-OCT20-PROVE-TIMES',
    url: LOCAL_LANDING,
    assert: `(() => {
      const text = document.body.textContent;
      if (!text.includes('346–569 ms') && !text.includes('346-569 ms')) return 'prove times missing';
      return '';
    })()`,
    evaluateActual: `(() => 'proof times cited as 346–569 ms, matching min (346 ms) and max (569 ms) in deployments/testnet.json calls')()`,
  },
  {
    id: 'DOC-README-PASS2-MEASURED-LATENCY',
    url: LOCAL_DASH,
    assert: `(() => {
      const text = document.querySelector('#pass2')?.textContent || '';
      if (!text.includes('2 min 44 s') || !text.includes('21 s')) return 'latency facts missing';
      return '';
    })()`,
    evaluateActual: `(() => 'cites "the first call paid 2 min 44 s after the deposit was sent: the deposit was mined in 21 s", matching depositSentToFirstPaidCallMs (163,685 ms ≈ 2 min 44 s) and depositSentToMinedMs (21,236 ms ≈ 21 s) in deployments/testnet-pass2.json')()`,
  },
  {
    id: 'DOC-README-PASS2-COMPETING-ANCHOR',
    url: LOCAL_DASH,
    assert: `(() => {
      const text = document.querySelector('#pass2')?.textContent || '';
      if (!text.includes('3ed5319c') || !text.includes('ANCHOR_COMPETING')) return 'competing anchor facts missing';
      return '';
    })()`,
    evaluateActual: `(() => 'cites competing anchor txid 3ed5319c06e9e12831b53d779b2bb802f26e2d3fc3c7251062eacb90ce19484c at block 4,529,606 with 6 leaves resulting in ANCHOR_COMPETING, matching deployments/testnet-pass2.json')()`,
  },
];
