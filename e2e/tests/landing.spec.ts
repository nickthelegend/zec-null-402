import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { agentLog, EXPLORER, expect, HOSTED_INFO, expectInViewport, expectNoHorizontalScroll, isMobile, logButtons, REPO, REPO_ROOT, repoPathOf, run, test, URLS } from './fixtures';

const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: REPO_ROOT }).toString().split('\n'));
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

const tickets: string[] = [...run.calls.map((c: { nullifier: string }) => c.nullifier), ...run.fixtureNullifiers];
const pass2 = JSON.parse(readFileSync(resolve(REPO_ROOT, 'deployments/testnet-pass2.json'), 'utf8'));
const pass2Tx: string[] = [pass2.txs.deposit1, pass2.txs.deposit2, ...pass2.anchors.map((a: { txid: string }) => a.txid), pass2.competing.txid];
const agentSec = 'section[aria-labelledby="agent-h"]';

test.describe('landing', () => {
  test('loads: the pass, the strip and the hero, no horizontal scroll', async ({ page }, info) => {
    await page.goto(URLS.landing + '/');
    await expect(page).toHaveTitle(/Kippu/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('One deposit. A ticket per call.');
    const pass = page.getByRole('article', { name: 'The shielded deposit that bought the tickets' });
    await expect(pass).toContainText(`${run.gateway.leaves}`);
    await expect(pass).toContainText(`${Number(run.deposit.amountZat).toLocaleString('en-US')} zat bought ${tickets.length} tickets`);
    await expect(pass).toContainText(run.deposit.height.toLocaleString('en-US'));
    await expect(page.getByRole('note', { name: 'Run summary' })).toContainText(`${tickets.length} tickets`);
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: info.outputPath(`landing-hero-${info.project.name}.png`) });
  });

  test('tickets tear off the pass once when the rail comes into view', async ({ page }, info) => {
    await page.goto(URLS.landing + '/');
    const rail = page.locator('ol.rail');
    // Armed: the tickets wait folded, then tear off when the rail is in view (or after 2.5 s at most).
    await expect(rail).toHaveClass(/armed/);
    await rail.scrollIntoViewIfNeeded();
    await expect(rail).toHaveClass(/torn/);
    const first = rail.locator('li.tix').first();
    const last = rail.locator('li.tix').last();
    await expect.poll(() => first.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
    await expect.poll(() => last.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
    await expect.poll(() => first.evaluate((e) => getComputedStyle(e).transform)).toBe('none');
    // Staggered: each ticket's delay is 45 ms more than the one before.
    expect(await rail.locator('li.tix').nth(3).evaluate((e) => getComputedStyle(e).transitionDelay)).toMatch(/0\.135s/);
    await page.screenshot({ path: info.outputPath(`landing-rail-torn-${info.project.name}.png`) });
  });

  test('reduced motion: tickets are never hidden or animated', async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(URLS.landing + '/');
    const rail = page.locator('ol.rail');
    await expect(rail).not.toHaveClass(/armed/);
    const t = rail.locator('li.tix').first();
    expect(await t.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
    expect(await t.evaluate((e) => getComputedStyle(e).transitionDuration)).toMatch(/^0s/);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
    // The rail buttons scroll instantly.
    await rail.scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'Scroll tickets right' }).click();
    expect(await rail.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath(`landing-reduced-motion-${info.project.name}.png`) });
  });

  test('ticket rail: the 22 nullifiers in spend order, with proof times; arrows and keyboard scroll it; the edge fade goes at the end', async ({ page }) => {
    await page.goto(URLS.landing + '/');
    const items = page.locator('ol.rail li.tix');
    await expect(items).toHaveCount(tickets.length);
    for (let i = 0; i < tickets.length; i++) {
      await expect(items.nth(i).locator('code')).toHaveAttribute('title', tickets[i]);
      if (i < run.calls.length) await expect(items.nth(i)).toContainText(`proof ${run.calls[i].proveMs} ms`);
      else await expect(items.nth(i)).toHaveClass(/fixture/);
    }
    const proveMs = run.calls.map((c: { proveMs: number }) => c.proveMs);
    await expect(page.locator('.rail-foot')).toContainText(`${Math.min(...proveMs)}–${Math.max(...proveMs)} ms`);

    const rail = page.locator('ol.rail');
    await rail.scrollIntoViewIfNeeded();
    const left = () => rail.evaluate((e) => e.scrollLeft);
    await page.getByRole('button', { name: 'Scroll tickets right' }).click();
    await expect.poll(left).toBeGreaterThan(100);
    const after = await left();
    await page.getByRole('button', { name: 'Scroll tickets left' }).click();
    await expect.poll(left).toBeLessThan(after);
    await expect.poll(left).toBe(0);
    // Keyboard: the rail is focusable and scrolls with the arrow keys.
    await rail.focus();
    await expect(rail).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('End');
    await expect.poll(left).toBeGreaterThan(100);
    await expectFadeOnlyBeforeTheEnd(rail);
  });

  test('nav links, CTAs and the skip link land on their sections', async ({ page }, info) => {
    await page.goto(URLS.landing + '/');
    const nav = page.locator('header.nav');
    const links: [string, string][] = [
      ['The tickets', '#rail'],
      ['How it works', '#how'],
      ['Voided', '#void'],
      ['Conditions', '#terms'],
    ];
    if (isMobile(info.project.name)) {
      // The section links are hidden on phones by design; the GitHub button stays.
      for (const [name] of links) await expect(nav.getByRole('link', { name })).toBeHidden();
    } else {
      for (const [name, hash] of links) {
        await nav.getByRole('link', { name }).click();
        await expect(page).toHaveURL(new RegExp(`${hash}$`));
        await expectInViewport(page, hash);
      }
    }
    await expect(nav.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', REPO);
    await page.evaluate(() => scrollTo(0, 0));
    await page.getByRole('link', { name: /See the 22 tickets/ }).click();
    await expect(page).toHaveURL(/#rail$/);
    await expectInViewport(page, '#rail');
    await page.evaluate(() => scrollTo(0, 0));
    await page.getByRole('link', { name: 'Read the conditions' }).click();
    await expect(page).toHaveURL(/#terms$/);
    await expectInViewport(page, '#terms');
    await page.getByRole('link', { name: 'Kippu, home' }).click();
    await expect(page).toHaveURL(/#main$/);
    // Skip link: hidden until focused, then jumps to the content.
    await page.goto(URLS.landing + '/');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect.poll(() => skip.evaluate((e) => e.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
  });

  test('voided tickets and the agent section match the published run record', async ({ page }) => {
    await page.goto(URLS.landing + '/');
    const voids = page.locator('#void ul.voids > li');
    await expect(voids).toHaveCount(8);
    const codes = await voids.locator('code').allTextContents();
    const expected = ['replayWithNewContext', 'replayOfSecondNote', 'tamperedAmount', 'proofForAnotherRequest', 'tamperedNullifier'].map((k) => String(run.attacks[k]));
    expect(codes.slice(0, 5)).toEqual(expected);
    expect(codes[5]).toBe('409 already claimed');
    expect(run.refusals['second claim of the deposit']).toMatch(/409.*already claimed/);
    expect(run.refusals['claim with an altered note value (fresh gateway)']).toContain(codes[6]);
    expect(codes[7]).toBe(pass2.competingRefusal.code);
    for (const li of await voids.all()) await expect(li.locator('.stamp')).toHaveText('VOID');
    const refused = agentLog.filter((c) => c.isError).length;
    await expect(page.locator(`${agentSec} .agent-side`)).toContainText(`${refused} / ${agentLog.length}`);
    await expect(page.locator(`${agentSec} .agent-side`)).toContainText('+1 double credit (pre-fix)');
    await expect(page.locator(`${agentSec} .agent`)).toContainText('credited it twice (leaves 25 and 26');
    // The deposits the agent made are the txids in its own log.
    const agentTx = agentLog.filter((c) => c.tool === 'deposit' && !c.isError).map((c) => String((c.result as { txid: string }).txid));
    const shown = await page.locator(`${agentSec} .agent a.txlink`).evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
    expect(shown).toEqual(agentTx.map((t) => EXPLORER + t));
  });

  test('no overclaims: the corrected wording is shown and the old claims are gone', async ({ page }) => {
    await page.goto(URLS.landing + '/');
    const text = await page.locator('main').innerText();
    for (const gone of [/everyone proves against the same one/, /The cap held/, /carried an injected/, /about a block with auto-anchoring/, /transactions on-chain: the deposit and the anchor/, /no longer hand each client its own root/, /don't yet scan for competing anchors/, /reads the named anchor on-chain itself/, /nothing is mocked/, /learns that some note paid, not which/, /transactions per run/, /In the run there was one depositor/, /Seven tickets the gateway would not honour/]) expect(text, String(gone)).not.toMatch(gone);
    // copy cut on Oct 25: the lead is one line; the single-depositor caveat stays in the conditions (below)
    await expect(page.locator('.lead')).toHaveText('Pay once with a shielded Zcash deposit, then each call with a zero-knowledge proof that never says which note paid.');
    await expect(page.locator('#rail')).toContainText('(Oct 20, pre-anchored-root protocol)');
    await expect(page.locator('#terms')).toContainText('Anchors count paid calls.');
    await expect(page.locator('#terms')).toContainText('At low traffic that times single calls to within about 10 minutes.');
    await expect(page.locator('#terms')).toContainText('Both testnet runs had one depositor');
    await expect(page.locator('.print')).toContainText('Chain-touching tests read real Zcash testnet with real Groth16 proofs; tests that would send an anchor record the memo instead.');
    await expect(page.locator('.nums')).toContainText('transactions in the Oct 20 run: the deposit and its anchor (plus funding)');
    await expect(page.locator('#how')).toContainText('clients that see the same anchor prove against the same root');
    await expect(page.locator('#how')).toContainText('through its own lightwalletd');
    await expect(page.locator('#terms')).toContainText('Both testnet runs had one depositor, so every call came from that depositor');
    await expect(page.locator('#void')).toContainText('without putting it on-chain');
    await expect(page.locator('#void')).toContainText('ANCHOR_COMPETING');
    await expect(page.locator('#agent-h')).toHaveText('The per-deposit cap blocked the 50-unit note. The wallet still ran dry.');
    await expect(page.locator(`${agentSec} .agent`).locator('..')).toContainText("The operator's prompt relayed a provider's");
    await expect(page.locator('#terms')).toContainText('Lightwalletd is trusted for anchors.');
    await expect(page.locator('#terms')).toContainText('credited notes of that price inside the latest anchor');
    await expect(page.locator('#terms')).toContainText('must keep anchoring');
    // the latency is the measured one from the Oct 22 live run
    const ms = pass2.latency.depositSentToFirstPaidCallMs as number;
    const s = Math.round(ms / 1000);
    await expect(page.locator('#terms')).toContainText(`the first call paid ${Math.floor(s / 60)} min ${s % 60} s after the deposit was sent: the deposit was mined in ${Math.round(pass2.latency.depositSentToMinedMs / 1000)} s`);
  });

  test('pass 2: the current protocol live, every row from deployments/testnet-pass2.json', async ({ page }, info) => {
    await page.goto(URLS.landing + '/#live');
    const sec = page.locator('#live');
    await expect(sec.locator('h2')).toHaveText('Signed anchors, the default window, four paid calls.');
    expect(pass2.calls).toHaveLength(4);
    expect(pass2.protocol.clientWindowBlocks).toBe(2880);
    const rows = sec.locator('.agent ol > li');
    await expect(rows).toHaveCount(9);
    const hrefs = await sec.locator('a.txlink').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs).toEqual([pass2.txs.deposit1, pass2.anchors[0].txid, pass2.anchors[1].txid, pass2.txs.deposit2, pass2.anchors[2].txid, pass2.anchors[3].txid, pass2.competing.txid].map((t) => EXPLORER + t));
    const ms = pass2.calls.map((c: { proveMs: number }) => c.proveMs);
    await expect(rows.nth(2)).toContainText(`proofs ${ms[0]}, ${ms[1]} and ${ms[2]} ms`);
    await expect(rows.nth(2).locator('.tag')).toHaveText('3 × 200');
    await expect(rows.nth(5)).toContainText(`proof ${ms[3]} ms`);
    await expect(rows.nth(6)).toContainText(`named the older anchor ${pass2.probe.named.txid.slice(0, 8)}…: the client proved against the newest, ${pass2.probe.used.txid.slice(0, 8)}…`);
    await expect(rows.nth(8)).toContainText('ANCHOR_COMPETING');
    await expect(rows.nth(8).locator('.tag')).toHaveText('void');
    for (const a of pass2.anchors as { height: number }[]) await expect(sec).toContainText(`block ${a.height.toLocaleString('en-US')}`);
    await expect(sec.locator('.agent-side')).toContainText('4 + 1');
    // the hosted gateway is linked, and the page says it cannot be paid yet (no anchors)
    await expect(sec.locator('.agent-side')).not.toContainText('no live gateway of this protocol is running');
    await expect(sec.locator('.agent-side')).toContainText('has no wallet to anchor roots, so no client can pay it yet');
    await expect(sec.locator('.agent-side a')).toHaveAttribute('href', HOSTED_INFO);
    await expectNoHorizontalScroll(page);
    await sec.screenshot({ path: info.outputPath(`landing-pass2-${info.project.name}.png`) });
  });

  test('no button labelled "log" exists; the agent call log is in the run record', async ({ page }) => {
    await page.goto(URLS.landing + '/');
    expect(await logButtons(page)).toHaveLength(0);
    expect(await page.getByRole('link', { name: /\blog\b/i }).count()).toBe(0);
    await expect(page.locator(`${agentSec} .agent-side`)).toContainText('deployments/agent-run-2026-10-20.jsonl');
    expect(tracked.has('deployments/agent-run-2026-10-20.jsonl')).toBe(true);
  });

  test('every link: anchors resolve, explorer links name real run txids, repo links name tracked files', async ({ page }) => {
    await page.goto(URLS.landing + '/');
    const hrefs = await page.locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href')!));
    expect(hrefs.length).toBeGreaterThan(15);
    const runTx = new Set([run.txs.fund, run.txs.deposit, run.txs.anchor, ...pass2Tx, ...agentLog.filter((c) => c.tool === 'deposit' && !c.isError).map((c) => String((c.result as { txid: string }).txid))]);
    for (const h of hrefs) {
      if (h.startsWith('#')) {
        expect(await page.locator(h).count(), `anchor ${h}`).toBe(1);
      } else if (h.startsWith(EXPLORER)) {
        const id = h.slice(EXPLORER.length);
        expect(id, h).toMatch(/^[0-9a-f]{64}$/);
        expect(runTx.has(id), `${h} is a txid from the run record or the agent log`).toBe(true);
      } else if (h === REPO || h === HOSTED_INFO) {
        // the repo itself, the hosted gateway
      } else {
        const p = repoPathOf(h);
        expect(p, `unexpected link ${h}`).not.toBeNull();
        expect(tracked.has(p!), `${p} is tracked in the repo`).toBe(true);
      }
    }
    // The visible txid labels are the start of the txid they link to.
    for (const a of await page.locator('a.txlink').all()) {
      const id = (await a.getAttribute('href'))!.slice(EXPLORER.length);
      expect((await a.innerText()).trim().slice(0, 8)).toBe(id.slice(0, 8));
    }
  });
});
