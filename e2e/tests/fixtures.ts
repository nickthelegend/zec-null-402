import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';

export { URLS } from '../global-setup.ts';
export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
/** The published run record and the agent's MCP log, the same files the dashboard imports. */
export const run = JSON.parse(readFileSync(resolve(REPO_ROOT, 'deployments/testnet.json'), 'utf8'));
export const agentLog: { at: string; tool: string; args: Record<string, unknown>; isError: boolean; result: unknown }[] = readFileSync(resolve(REPO_ROOT, 'deployments/agent-run-2026-10-20.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
export const REPO = 'https://github.com/nickthelegend/zec-null-402';
export const EXPLORER = 'https://testnet.zcashexplorer.app/transactions/';

type Allowed = { url: RegExp; status: number };

/**
 * Every test gets a `watch` that records console errors, page errors, failed same-origin requests and
 * same-origin HTTP errors, and asserts at the end that there were none. A test may `allow()` a status
 * on a URL when that status is the product's honest answer (a 402 challenge). Nothing else is excused.
 */
export const test = base.extend<{ watch: { allow: (url: RegExp, status: number) => void } }>({
  watch: [
    async ({ page }, use, testInfo) => {
      const allowed: Allowed[] = [];
      const problems: string[] = [];
      const isAllowed = (url: string, status: number) => allowed.some((a) => a.status === status && a.url.test(url));
      const sameOrigin = (url: string) => {
        try {
          return new URL(url).origin === new URL(page.url()).origin;
        } catch {
          return false;
        }
      };
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const loc = m.location().url || '';
        const st = /status of (\d{3})/.exec(m.text());
        if (st && isAllowed(loc, Number(st[1]))) return;
        problems.push(`console.error: ${m.text()} @ ${loc}`);
      });
      page.on('requestfailed', (r) => {
        if (!sameOrigin(r.url())) return;
        const why = r.failure()?.errorText || '';
        if (why === 'net::ERR_ABORTED') return;
        problems.push(`requestfailed: ${r.method()} ${r.url()} ${why}`);
      });
      page.on('response', (r) => {
        if (!sameOrigin(r.url()) || r.status() < 400) return;
        if (isAllowed(r.url(), r.status())) return;
        problems.push(`HTTP ${r.status()}: ${r.request().method()} ${r.url()}`);
      });
      await use({ allow: (url, status) => allowed.push({ url, status }) });
      if (problems.length) await testInfo.attach('problems', { body: problems.join('\n') });
      expect(problems, 'console errors / failed same-origin requests').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** No horizontal page scroll (the 375 px check). */
export async function expectNoHorizontalScroll(page: Page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, `page scrollWidth ${sw} > clientWidth ${cw}`).toBeLessThanOrEqual(cw);
}

/** The element's top is near the top of the viewport (an anchor jump landed). */
export async function expectInViewport(page: Page, selector: string) {
  await expect
    .poll(
      async () =>
        page.evaluate((sel) => {
          const r = document.querySelector(sel)!.getBoundingClientRect();
          return r.top >= -2 && r.top < innerHeight * 0.6;
        }, selector),
      { message: `${selector} scrolled into view` },
    )
    .toBe(true);
}

/** Every element with role=button whose accessible name contains "log" (Nick: "Can't use the log button"). */
export async function logButtons(page: Page) {
  return page.getByRole('button', { name: /log/i }).all();
}

/** A GitHub link into this repo's main branch names a file that is tracked in this checkout. */
export function repoPathOf(href: string): string | null {
  const m = new RegExp(`^${REPO.replace(/[.]/g, '\\.')}/blob/main/(.+)$`).exec(href);
  return m ? m[1] : null;
}

export const isMobile = (name: string) => name === 'mobile';
