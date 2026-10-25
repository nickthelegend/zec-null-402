import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { agentLog, EXPLORER, expect, HOSTED_INFO, expectInViewport, expectNoHorizontalScroll, isMobile, logButtons, REPO, REPO_ROOT, repoPathOf, run, test, URLS } from './fixtures';

const pass2 = JSON.parse(readFileSync(resolve(REPO_ROOT, 'deployments/testnet-pass2.json'), 'utf8'));
const pass2Tx: string[] = [pass2.txs.deposit1, pass2.txs.deposit2, ...pass2.anchors.map((a: { txid: string }) => a.txid), pass2.competing.txid];
const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: REPO_ROOT }).toString().split('\n'));
type Call = { n: number; status: number; nullifier: string; proveMs: number };
const calls: Call[] = run.calls;
const tickets = [...calls.map((c) => ({ nf: c.nullifier, ms: c.proveMs as number | null })), ...run.fixtureNullifiers.map((nf: string) => ({ nf, ms: null }))];
/** The rail's right-edge fade: present while there is more to scroll, gone at the end so the last ticket is not faded. */
async function expectFadeOnlyBeforeTheEnd(rail: import('@playwright/test').Locator) {
  const mask = () => rail.evaluate((e) => getComputedStyle(e).maskImage || getComputedStyle(e).webkitMaskImage);
  await rail.evaluate((e) => e.scrollTo({ left: 0, behavior: 'instant' }));
  await expect.poll(mask).toMatch(/linear-gradient/);
  await rail.evaluate((e) => e.scrollTo({ left: e.scrollWidth, behavior: 'instant' }));
  await expect.poll(mask).toBe('none');
  const last = rail.locator(':scope > li').last();
  const [r, edge] = await Promise.all([last.evaluate((e) => e.getBoundingClientRect().right), rail.evaluate((e) => e.getBoundingClientRect().right)]);
  expect(r, 'last ticket fully inside the rail').toBeLessThanOrEqual(edge);
  await rail.evaluate((e) => e.scrollTo({ left: 0, behavior: 'instant' }));
  await expect.poll(mask).toMatch(/linear-gradient/);
}

const pad = (n: number) => String(n).padStart(2, '0');
const short = (s: string, a: number, b: number) => `${s.slice(0, a)}…${s.slice(-b)}`;

test.describe('dashboard', () => {
  test('loads: the punched deposit pass and the run in numbers, no horizontal scroll', async ({ page }, info) => {
    await page.goto(URLS.dashboard + '/');
    await expect(page).toHaveTitle(/Kippu/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${calls.length} paid calls. No transaction per call.`);
    const pass = page.getByRole('article', { name: 'The shielded deposit' });
    await expect(pass).toContainText(`${(Number(run.deposit.amountZat) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 })} TAZ`);
    await expect(pass).toContainText(run.deposit.height.toLocaleString('en-US'));
    await expect(pass).toContainText(`Punched ${run.gateway.spent} of ${run.gateway.leaves}`);
    const punches = page.getByRole('list', { name: `${run.gateway.spent} of ${run.gateway.leaves} notes spent` }).locator('li');
    await expect(punches).toHaveCount(run.gateway.leaves);
    await expect(punches.and(page.locator('.p'))).toHaveCount(calls.length);
    await expect(punches.and(page.locator('.f'))).toHaveCount(run.fixtureNullifiers.length);
    const ms = calls.map((c) => c.proveMs);
    await expect(page.locator('.stats')).toContainText(`${Math.min(...ms)}–${Math.max(...ms)}ms`);
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: info.outputPath(`dash-loaded-${info.project.name}.png`) });
  });

  test('picking a ticket shows its stub: full nullifier, request, answer, price, proof time', async ({ page }, info) => {
    await page.goto(URLS.dashboard + '/');
    const rail = page.getByRole('list', { name: 'Spent tickets' });
    const buttons = rail.getByRole('button');
    await expect(buttons).toHaveCount(tickets.length);
    const stub = page.locator('article.stub');
    // Ticket 01 is picked on load.
    await expect(buttons.first()).toHaveAttribute('aria-pressed', 'true');
    await expect(stub).toHaveAttribute('aria-label', 'Ticket 01');
    for (const i of [4, 19, 20, 21]) {
      const b = buttons.nth(i);
      await b.scrollIntoViewIfNeeded();
      await b.click();
      await expect(b).toHaveAttribute('aria-pressed', 'true');
      await expect(rail.locator('[aria-pressed="true"]')).toHaveCount(1);
      await expect(stub).toHaveAttribute('aria-label', `Ticket ${pad(i + 1)}`);
      await expect(stub.locator('.wide').first().locator('code')).toHaveText(tickets[i].nf);
      await expect(stub).toContainText('GET /api/quote');
      await expect(stub).toContainText('HTTP 200');
      await expect(stub).toContainText(`${run.priceUnits} units · ${(Number(run.priceUnits) * run.unitZat).toLocaleString('en-US')} zat`);
      if (tickets[i].ms !== null) {
        await expect(stub).toContainText('paid call');
        await expect(stub).toContainText(`${tickets[i].ms} ms`);
      } else {
        await expect(stub).toContainText('fixture note');
        await expect(stub).toContainText('not timed (fixture)');
      }
      await expect(b).toContainText(short(tickets[i].nf, 9, 4));
    }
    await stub.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`dash-ticket-22-${info.project.name}.png`) });
    await expectNoHorizontalScroll(page);
  });

  test('keyboard: Tab through the rail, Enter and Space pick a ticket, focus is visible', async ({ page }) => {
    await page.goto(URLS.dashboard + '/');
    const buttons = page.getByRole('list', { name: 'Spent tickets' }).getByRole('button');
    await buttons.first().focus();
    await page.keyboard.press('Tab');
    await expect(buttons.nth(1)).toBeFocused();
    expect(await buttons.nth(1).evaluate((e) => getComputedStyle(e).outlineStyle)).toBe('solid');
    await page.keyboard.press('Enter');
    await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('article.stub')).toHaveAttribute('aria-label', 'Ticket 02');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(buttons.nth(3)).toBeFocused();
    await page.keyboard.press('Space');
    await expect(buttons.nth(3)).toHaveAttribute('aria-pressed', 'true');
    await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('article.stub code').first()).toHaveText(tickets[3].nf);
    // A focused ticket off the edge of the rail is scrolled into view.
    for (let i = 4; i < 15; i++) await page.keyboard.press('Tab');
    await expect(buttons.nth(14)).toBeFocused();
    await expect(buttons.nth(14)).toBeInViewport();
  });

  test('rail arrows scroll the rail; the edge fade goes at the end', async ({ page }) => {
    await page.goto(URLS.dashboard + '/#tickets');
    const rail = page.getByRole('list', { name: 'Spent tickets' });
    const left = () => rail.evaluate((e) => e.scrollLeft);
    await page.getByRole('button', { name: 'Scroll tickets right' }).click();
    await expect.poll(left).toBeGreaterThan(100);
    await page.getByRole('button', { name: 'Scroll tickets left' }).click();
    await expect.poll(left).toBe(0);
    await expectFadeOnlyBeforeTheEnd(rail);
  });

  test('section nav, brand and skip link land on their sections', async ({ page }, info) => {
    await page.goto(URLS.dashboard + '/');
    const nav = page.getByRole('navigation', { name: 'Sections' });
    const sections = ['Deposit:#pass', 'Tickets:#tickets', 'Pass 2:#pass2', 'Who sees what:#who', 'Voided:#void', 'Agent:#agent', 'Anchor:#anchor'].map((s) => s.split(':'));
    if (isMobile(info.project.name)) {
      await expect(nav).toBeHidden(); // hidden on phones by design; the page is one column
    } else {
      for (const [name, hash] of sections) {
        await nav.getByRole('link', { name, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`${hash}$`));
        if (hash !== '#anchor') await expectInViewport(page, hash);
        else await expect(page.locator(hash)).toBeInViewport();
        // Not hidden under the sticky header.
        const top = await page.locator(`${hash} h1, ${hash} h2`).first().evaluate((e) => e.getBoundingClientRect().top);
        const header = await page.locator('header.top').evaluate((e) => e.getBoundingClientRect().bottom);
        expect(top, `${hash} heading below the sticky header`).toBeGreaterThanOrEqual(header - 1);
      }
    }
    await page.getByRole('link', { name: 'Kippu run record, top' }).click();
    await expect(page).toHaveURL(/#pass$/);
    await expect(page.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', REPO);
    await page.goto(URLS.dashboard + '/');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
  });

  test('who sees what: four parties, each with what it does not see', async ({ page }) => {
    await page.goto(URLS.dashboard + '/#who');
    const who = page.locator('ul.who > li');
    await expect(who).toHaveCount(4);
    await expect(who.locator('h3')).toHaveText(['The chain', 'The gateway', 'Anyone with the anchor key', 'Anyone with the gateway key']);
    for (const li of await who.all()) await expect(li.locator('.not')).toHaveText(/^Not /);
    await expect(who.nth(0).locator('.not')).toContainText('in the clear');
    await expect(who.nth(0).locator('.not')).toContainText('publishes the gateway viewing key');
    await expect(who.nth(2)).toContainText(`here ${run.anchor.leaves}, ${run.anchor.nullifiers} spent`);
    await expect(who.nth(2)).toContainText('how many calls were paid between two anchors');
    await expect(who.nth(2).locator('.not')).toHaveText('Not which note paid which call.');
  });

  test('refused attempts: the seven voided tickets with the gateway codes, and the pass-2 client refusal', async ({ page }, info) => {
    await page.goto(URLS.dashboard + '/#void');
    await expect(page.locator('#void .count')).toHaveText('8 refused');
    const voids = page.locator('ul.voids > li');
    await expect(voids).toHaveCount(8);
    await expect(voids.locator('code')).toHaveText([
      String(run.attacks.replayWithNewContext),
      String(run.attacks.replayOfSecondNote),
      String(run.attacks.tamperedAmount),
      String(run.attacks.proofForAnotherRequest),
      String(run.attacks.tamperedNullifier),
      '409 already claimed',
      'MEMO_MISMATCH, AMOUNT_TOO_LOW',
      pass2.competingRefusal.code,
    ]);
    expect(pass2.competingRefusal.code).toBe('ANCHOR_COMPETING');
    await expect(voids.nth(7)).toContainText('pass 2, Oct 22');
    await expect(voids.nth(5)).toContainText('Second claim of the deposit.');
    const review = page.getByRole('link', { name: 'Read the review' });
    expect(tracked.has(repoPathOf((await review.getAttribute('href'))!)!)).toBe(true);
    await expect(review).toHaveAttribute('target', '_blank');
    await page.locator('#void').screenshot({ path: info.outputPath(`dash-voided-${info.project.name}.png`) });
  });

  test('agent calls: every MCP call of the recorded run, refused ones marked, the pre-fix double credit marked; no "log" button exists', async ({ page }, info) => {
    await page.goto(URLS.dashboard + '/#agent');
    const refused = agentLog.filter((c) => c.isError).length;
    // a successful claim of a plan that was already credited: the Oct 20 concurrent-claim race (fixed in 9f8b8a8)
    const seen = new Set<string>();
    const doubles = agentLog.map((c) => {
      if (c.tool !== 'claim' || c.isError) return false;
      const plan = String(c.args.plan);
      return seen.has(plan) || (seen.add(plan), false);
    });
    expect(doubles.filter(Boolean)).toHaveLength(1);
    expect(doubles.indexOf(true)).toBe(15); // row 16: deposit 0b12bfc6 credited again at leaf 26
    expect((agentLog[15].args as { txid: string }).txid).toMatch(/^0b12bfc6/);
    await expect(page.locator('#agent .count')).toHaveText(`${refused} of ${agentLog.length} calls refused`);
    await expect(page.locator('#agent .lede')).toContainText('credited deposit 0b12bfc6 twice (row 16, leaves 25 and 26');
    await expect(page.locator('#agent .lede')).toContainText('+1 double credit, the pre-fix race closed on Oct 21');
    await expect(page.locator('#agent .lede')).toContainText("The operator's prompt relayed a provider's");
    await expect(page.locator('#agent .lede')).not.toContainText('quote response carried');
    const rows = page.locator('#agent ol.roll > li');
    await expect(rows).toHaveCount(agentLog.length);
    for (let i = 0; i < agentLog.length; i++) {
      const c = agentLog[i];
      await expect(rows.nth(i).locator('.roll-n')).toHaveText(pad(i + 1));
      await expect(rows.nth(i).locator('.tag')).toHaveText(c.isError ? 'refused' : doubles[i] ? 'double' : 'ok');
      await expect(rows.nth(i).locator('.roll-what')).toContainText(c.tool === 'claim' ? 'claim' : c.tool);
      if (c.isError) await expect(rows.nth(i).locator('.roll-detail')).toHaveText(String(c.result));
      if (c.tool === 'pay' && !c.isError) await expect(rows.nth(i).locator('.roll-detail')).toHaveText(`HTTP ${(c.result as { status: number }).status}, proof ${(c.result as { prove_ms: number }).prove_ms} ms`);
      if (c.tool === 'claim' && !c.isError) await expect(rows.nth(i).locator('.roll-detail')).toHaveText(doubles[i] ? `credited again from leaf ${(c.result as { first: number }).first} (pre-fix race, fixed in 9f8b8a8, now 409)` : `credited ${(c.result as { count: number }).count} notes from leaf ${(c.result as { first: number }).first}`);
    }
    await expect(rows.locator('.tag.no')).toHaveCount(refused + 1);
    // the tag stays inside its column, clear of the detail text
    const [tagRight, detailLeft] = await Promise.all([rows.nth(15).locator('.tag').evaluate((e) => e.getBoundingClientRect().right), rows.nth(15).locator('.roll-detail').evaluate((e) => e.getBoundingClientRect().left)]);
    if (!isMobile(info.project.name)) expect(tagRight).toBeLessThanOrEqual(detailLeft);
    // Nick's "log" button: there is no button whose label contains "log" on the dashboard.
    expect(await logButtons(page)).toHaveLength(0);
    await expect(page.locator('#agent')).toContainText('deployments/agent-run-2026-10-20.jsonl');
    await expectNoHorizontalScroll(page);
    await page.locator('#agent').screenshot({ path: info.outputPath(`dash-agent-calls-${info.project.name}.png`) });
  });

  test('anchor check: the browser recomputes the nullifier-set hash; Hash again re-runs it', async ({ page }, info) => {
    await page.addInitScript(() => {
      const orig = crypto.subtle.digest.bind(crypto.subtle);
      (window as unknown as { __digests: number }).__digests = 0;
      crypto.subtle.digest = (...a: Parameters<SubtleCrypto['digest']>) => {
        (window as unknown as { __digests: number }).__digests++;
        return orig(...a);
      };
    });
    await page.goto(URLS.dashboard + '/#anchor');
    const check = page.locator('.check');
    const status = check.getByRole('status');
    await expect(status).toHaveText(`The ${tickets.length} published nullifiers hash to the anchored value.`);
    await expect(check).toHaveClass(/is-ok/);
    await expect(check.locator('dd code').first()).toHaveText(short(run.anchor.nullifierHash, 14, 8));
    await expect(check.locator('dd code').nth(1)).toHaveText(short(run.anchor.nullifierHash, 14, 8));
    await expect(page.locator('#anchor code.memo')).toHaveText(run.anchor.memo);
    expect(run.anchor.memo.endsWith(run.anchor.nullifierHash)).toBe(true);
    const before = await page.evaluate(() => (window as unknown as { __digests: number }).__digests);
    await page.getByRole('button', { name: 'Hash again' }).click();
    await expect(check).toHaveClass(/is-ok/);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __digests: number }).__digests)).toBe(before + 1);
    const tx = page.locator('#anchor a.tx');
    await expect(tx).toHaveAttribute('href', EXPLORER + run.anchor.txid);
    await page.locator('#anchor').screenshot({ path: info.outputPath(`dash-anchor-ok-${info.project.name}.png`) });
  });

  test('anchor check: a tampered nullifier set shows the mismatch', async ({ page }, info) => {
    // Hash a set with one nullifier dropped: the real digest of the wrong input.
    await page.addInitScript(() => {
      const orig = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = (alg: AlgorithmIdentifier, data: BufferSource) => {
        const s = new TextDecoder().decode(data as Uint8Array);
        return orig(alg, new TextEncoder().encode(s.replace(/,[0-9]+$/, '')));
      };
    });
    await page.goto(URLS.dashboard + '/#anchor');
    const check = page.locator('.check');
    await expect(check.getByRole('status')).toHaveText('The published nullifiers do not hash to the anchored value.');
    await expect(check).toHaveClass(/is-bad/);
    await expect(check.locator('dd code').first()).not.toHaveText(short(run.anchor.nullifierHash, 14, 8));
    await expect(page.getByRole('button', { name: 'Hash again' })).toBeEnabled();
    await page.locator('#anchor').screenshot({ path: info.outputPath(`dash-anchor-tampered-${info.project.name}.png`) });
  });

  test('anchor check: Setup required where Web Crypto is missing, and Try again', async ({ page }, info) => {
    await page.addInitScript(() => Object.defineProperty(Crypto.prototype, 'subtle', { get: () => undefined }));
    await page.goto(URLS.dashboard + '/#anchor');
    const check = page.locator('.check');
    await expect(check.getByRole('status')).toHaveText('Setup required: this browser cannot hash here (Web Crypto needs https or localhost).');
    await expect(check).toHaveClass(/is-unavailable/);
    await expect(check.locator('dd code').first()).toHaveText('…');
    const again = page.getByRole('button', { name: 'Try again' });
    await again.click();
    await expect(check).toHaveClass(/is-unavailable/);
    await expect(again).toBeEnabled();
    await page.locator('#anchor').screenshot({ path: info.outputPath(`dash-anchor-setup-required-${info.project.name}.png`) });
  });

  test('every link: explorer links name the run txids, repo links name tracked files, external ones open in a new tab', async ({ page }) => {
    await page.goto(URLS.dashboard + '/');
    const runTx = new Set([run.txs.fund, run.txs.deposit, run.txs.anchor, ...pass2Tx]);
    const links = await page.locator('a[href]').evaluateAll((as) => as.map((a) => ({ href: a.getAttribute('href')!, target: a.getAttribute('target'), rel: a.getAttribute('rel') })));
    for (const l of links) {
      if (l.href.startsWith('#')) {
        expect(await page.locator(l.href).count(), l.href).toBe(1);
        continue;
      }
      expect(l.target, l.href).toBe('_blank');
      expect(l.rel, l.href).toContain('noreferrer');
      if (l.href.startsWith(EXPLORER)) expect(runTx.has(l.href.slice(EXPLORER.length)), l.href).toBe(true);
      else if (l.href !== REPO && l.href !== HOSTED_INFO) expect(tracked.has(repoPathOf(l.href) ?? ''), l.href).toBe(true);
    }
    // Deposit, fund and anchor transactions are all linked.
    for (const t of runTx) await expect(page.locator(`a[href="${EXPLORER + t}"]`).first()).toBeAttached();
  });

  test('no overclaims: the corrected wording is shown and the old claims are gone', async ({ page }) => {
    await page.goto(URLS.dashboard + '/');
    const text = await page.locator('body').innerText();
    for (const gone of [/transactions in the run/, /quote response carried an injected/i, /can't hand one client its own root \(/, /Clients now read this memo/, /transactions per run/, /Not individual payments/, /One depositor in this run/, /Not amounts, memos, who paid or how many calls\./]) expect(text, String(gone)).not.toMatch(gone);
    await expect(page.locator('.stats')).toContainText('transactions in the Oct 20 run: the deposit and its anchor (plus the demo funding tx). Auto-anchoring now adds one per deposit and periodic ones');
    await expect(page.locator('#who')).toContainText('In the Oct 20 run, two shielded transactions: the deposit and the anchor (plus one funding tx). Auto-anchoring now adds an anchor per deposit and periodic ones.');
    await expect(page.locator('#who')).toContainText('at low traffic times single calls');
    await expect(page.locator('#who .note')).toContainText('One depositor in each testnet run (Oct 20 and pass 2)');
    await expect(page.locator('#pass')).toContainText('pre-anchored-root protocol');
    await expect(page.locator('#tickets')).toContainText('Oct 20 run, pre-anchored-root protocol.');
    await expect(page.locator('#void .fixed')).toContainText("can't hand one client its own root without putting it on-chain");
    await expect(page.locator('#void .fixed')).toContainText('ANCHOR_COMPETING');
    await expect(page.locator('#void .fixed')).toContainText('trusts its lightwalletd');
    await expect(page.locator('#anchor')).toContainText('This Oct 20 anchor is unsigned');
  });

  test('pass 2: the current protocol live, every row from deployments/testnet-pass2.json', async ({ page }, info) => {
    await page.goto(URLS.dashboard + '/#pass2');
    const sec = page.locator('#pass2');
    await expect(sec.locator('h2')).toHaveText('Pass 2: the current protocol, live');
    await expect(sec.locator('.count')).toHaveText(`Oct 22 · ${pass2.calls.length} calls + 1 probe paid`);
    expect(pass2.protocol.clientWindowBlocks).toBe(2880);
    const rows = sec.locator('ol.roll > li');
    await expect(rows).toHaveCount(10);
    // every transaction of the run is linked, in order
    const hrefs = await sec.locator('a.tx').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs).toEqual([pass2.txs.deposit1, pass2.anchors[0].txid, pass2.anchors[1].txid, pass2.txs.deposit2, pass2.anchors[2].txid, pass2.anchors[3].txid, pass2.competing.txid].map((t) => EXPLORER + t));
    await expect(rows.nth(2)).toContainText(`proofs ${pass2.calls.slice(0, 3).map((c: { proveMs: number }) => c.proveMs).join(', ')} ms`);
    await expect(rows.nth(2).locator('.tag')).toHaveText('3 × 200');
    await expect(rows.nth(6)).toContainText(`proof ${pass2.calls[3].proveMs} ms`);
    await expect(rows.nth(7)).toContainText(`named ${pass2.probe.named.txid.slice(0, 8)}…, the client proved against the newest, ${pass2.probe.used.txid.slice(0, 8)}…`);
    expect(pass2.probe.status).toBe(200);
    await expect(rows.nth(9).locator('.tag')).toHaveText('void');
    await expect(rows.nth(9)).toContainText(`ANCHOR_COMPETING once a client's scan held that block`);
    for (const a of pass2.anchors as { height: number }[]) await expect(sec).toContainText(`block ${a.height.toLocaleString('en-US')}`);
    // the hosted gateway is linked, and the page says it cannot be paid yet (no anchors)
    await expect(sec.locator('.lede')).not.toContainText('No live gateway of this protocol is running');
    await expect(sec.locator('.lede')).toContainText('has no wallet to anchor roots, so no client can pay it yet');
    await expect(sec.locator('.lede a')).toHaveAttribute('href', HOSTED_INFO);
    await expectNoHorizontalScroll(page);
    await sec.screenshot({ path: info.outputPath(`dash-pass2-${info.project.name}.png`) });
  });

  test('reduced motion: smooth scrolling and ticket hover lift are off', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(URLS.dashboard + '/');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
    const t = page.getByRole('list', { name: 'Spent tickets' }).getByRole('button').first();
    expect(await t.evaluate((e) => getComputedStyle(e).transitionDuration)).toMatch(/^0s/);
    await page.getByRole('button', { name: 'Scroll tickets right' }).click();
    // Instant scroll: already moved without waiting for an animation.
    expect(await page.getByRole('list', { name: 'Spent tickets' }).evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
  });
});
