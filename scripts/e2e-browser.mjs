// Browser end-to-end test: drives the real UI in headless Chromium.
//
// Optional — needs Playwright, which is deliberately not a dependency of the app:
//   npm install --no-save playwright-core
//   CHROMIUM_PATH=/path/to/chrome node scripts/e2e-browser.mjs            # own server, fresh data, restart test
//   CHROMIUM_PATH=/path/to/chrome node scripts/e2e-browser.mjs http://localhost:8080   # an already running, empty install
//
// The second form skips the restart step; use it against a container you can restart yourself.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const external = process.argv[2];
const PORT = 18081;
const BASE = external || `http://localhost:${PORT}`;
// Chromium's profile socket path must be short, so always use /tmp-style dirs.
const dataDir = mkdtempSync(path.join(tmpdir(), 'tkl-e2e-'));

function startServer() {
  const p = spawn(process.execPath, ['server.js'], { cwd: repo, env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir }, stdio: 'pipe' });
  return new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => { if (String(d).includes('running at')) resolve(p); });
    p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
}
const stopServer = (p) => new Promise((r) => { p.on('exit', r); p.kill('SIGTERM'); });
const step = (m) => console.log(`✓ ${m}`);

let server = external ? null : await startServer();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const problems = [];
function watch(page) {
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('409')) problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('request', (r) => { if (!r.url().startsWith(BASE) && !r.url().startsWith('data:')) problems.push(`external request: ${r.url()}`); });
  page.on('dialog', (d) => d.accept());
  return page;
}
const toastHas = (page, text) => page.waitForFunction((t) => document.getElementById('toast').textContent.includes(t), text);

try {
  const page = watch(await browser.newPage());
  await page.goto(BASE);
  await page.waitForSelector('#changelog-modal.open');
  await page.click('#changelog-modal >> text=Got it');
  await page.waitForFunction(() => document.querySelectorAll('#recipe-grid .recipe-card').length === 18);
  // Invented samples are not Kitchen Loop originals, so a fresh install shows no origin icons.
  assert.equal(await page.locator('#recipe-grid img.origin-icon').count(), await page.evaluate(async () => (await (await fetch('/api/data')).json()).recipes.filter((r) => r.origin).length));
  assert.equal(await page.locator('#recipe-grid img.origin-icon').count(), 15);
  step('first run: 18 recipes shown (15 Kitchen Loop originals with the icon, 3 invented), welcome popup dismissed');

  // An original: method button leads to the TikTok post in a new tab; all three platform buttons present.
  await page.locator('#recipe-grid .recipe-card', { hasText: 'Chicken Laksa' }).click();
  assert.ok(await page.locator('#mv-origin.show').isVisible());
  const method = page.locator('#mv-method-link');
  assert.ok(await method.isVisible());
  assert.match(await method.textContent(), /View cooking method on TikTok/);
  assert.match(await method.getAttribute('href'), /^https:\/\/www\.tiktok\.com\/@the_kitchen_loop\/photo\/\d+$/);
  assert.equal(await method.getAttribute('target'), '_blank');
  assert.match(await method.getAttribute('rel'), /noopener/);
  assert.match(await page.locator('#mv-method-note').textContent(), /internet connection/);
  for (const id of ['#mv-link-tiktok', '#mv-link-instagram', '#mv-link-threads']) assert.ok(await page.locator(id).isVisible(), id);
  assert.ok(!(await page.locator('#mv-notes-wrap').isVisible()), 'no method text for an original');
  await page.click('#recipe-modal .modal-close');
  // An invented sample: written method shown, no method button, no social buttons.
  await page.locator('#recipe-grid .recipe-card', { hasText: 'Mediterranean Lamb Meatballs' }).click();
  assert.match(await page.locator('#mv-notes').textContent(), /^Method[\s\S]*1\. /);
  assert.ok(!(await page.locator('#mv-method').isVisible()));
  for (const id of ['#mv-link-tiktok', '#mv-link-instagram', '#mv-link-threads']) assert.ok(!(await page.locator(id).isVisible()), id);
  await page.click('#recipe-modal .modal-close');
  step('original: “View cooking method on TikTok” opens the post in a new tab, with all 3 platform buttons; invented: written method, no social buttons');

  await page.fill('#search-input', 'salmon');
  assert.equal(await page.locator('#recipe-grid .recipe-card').count(), 1);
  await page.fill('#search-input', '');
  step('search filters recipes');

  // A recipe whose text is hostile HTML must render as text and never execute.
  const evil = '<img src=x onerror="window.__xss=1">Evil "Pie" \'quoted\'';
  await page.click('nav >> text=Add');
  await page.fill('#new-name', evil);
  await page.fill('#new-ingredients', 'Flour, <b>Butter</b>, Sugar\'s');
  await page.fill('#new-instagram-link', 'javascript:alert(1)');
  await page.click('text=Save recipe');
  await toastHas(page, 'http');
  step('javascript: link rejected in the Add form');
  await page.fill('#new-instagram-link', 'https://example.com/pie');
  await page.click('text=Save recipe');
  await page.waitForFunction(() => document.querySelectorAll('#recipe-grid .recipe-card').length === 19);
  await page.locator('#recipe-grid .recipe-card', { hasText: 'Evil' }).click();
  assert.equal(await page.getAttribute('#mv-link-instagram', 'href'), 'https://example.com/pie');
  await page.click('#recipe-modal .modal-close');
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.ok(await page.locator('#recipe-grid h3', { hasText: 'Evil "Pie"' }).count());
  step('hostile recipe text displayed literally, no script ran; https link kept');

  await page.locator('#recipe-grid .recipe-card', { hasText: 'Lasagna' }).click();
  await page.click('text=✎ Edit');
  await page.fill('#edit-name', 'Lasagna (family size)');
  await page.click('text=Save changes');
  await page.waitForFunction(() => document.getElementById('mv-title').textContent.includes('family size'));
  await page.click('#btn-cooked-it');
  await page.click('#cook-confirm-prompt >> text=Yes');
  await toastHas(page, 'Logged');
  await page.click('#recipe-modal .modal-close');
  assert.equal(await page.locator('#recipe-grid .recipe-card', { hasText: 'Lasagna (family size)' }).locator('img.origin-icon').count(), 1);
  step('edited an original (it keeps its icon) and logged a cook');

  await page.click('nav >> text=Plan');
  await page.click('text=Auto-generate');
  await page.waitForFunction(() => document.querySelectorAll('#plan-container .plan-card').length === 14);
  const dinnerNames = await page.locator('#plan-container .plan-card .plan-recipe').allTextContents();
  assert.equal(new Set(dinnerNames).size, 14, 'expected 14 different dinners');
  if (await page.locator('#sides-modal.open').count()) await page.click('#sides-modal >> text=Add all');
  await page.click('#plan-active-content >> text=Build shopping list');
  await page.waitForSelector('#shopping-container .shopping-item');
  const firstItem = page.locator('#shopping-container .shopping-item').first();
  const tickedName = (await firstItem.textContent()).trim();
  await firstItem.locator('input').check();
  step(`generated a plan of 14 different dinners and a shopping list; ticked "${tickedName}"`);

  await page.click('nav >> text=Plan');
  await page.click('#plan-tab-custom');
  await page.fill('#custom-list-search', 'Evil');
  await page.locator('.custom-list-search-result').first().click();
  await page.waitForSelector('.custom-list-chip');
  await page.click('text=Archive list');
  await page.waitForSelector('#plan-history-container .plan-history-entry');
  await page.waitForTimeout(1000); // let the debounced shopping-tick save land
  step('custom list built and archived to history');

  if (server) {
    await stopServer(server);
    server = await startServer();
    step('server restarted');
  }
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#recipe-grid .recipe-card').length === 19);
  assert.equal(await page.locator('#changelog-modal.open').count(), 0, 'welcome popup should not reappear');
  const data = await page.evaluate(async () => (await fetch('/api/data')).json());
  assert.ok(data.recipes.some((r) => r.name.includes('family size')));
  assert.equal(data.recipes.find((r) => r.name.includes('family size')).cookDates.length, 1);
  assert.equal(data.plan.length, 18);
  assert.equal(data.shoppingChecked[tickedName], true);
  assert.equal(data.planHistory[0].type, 'custom');
  step('after reload/restart: recipes, edit, cook log, plan, ticks and history all persisted');

  // Two tabs: the second saves first, so the first one's next save is stale and refused.
  const other = watch(await browser.newPage());
  await other.goto(BASE);
  await other.waitForFunction(() => document.querySelectorAll('#recipe-grid .recipe-card').length === 19);
  await other.locator('#recipe-grid .recipe-card', { hasText: 'Coconut Daal' }).click();
  await other.click('#btn-cooked-it');
  await other.click('#cook-confirm-prompt >> text=Yes');
  await toastHas(other, 'Logged');
  await other.waitForTimeout(1000);
  await page.locator('#recipe-grid .recipe-card', { hasText: 'Evil' }).click();
  await page.click('#btn-delete-recipe');
  await page.waitForSelector('#stale-banner.show');
  const after = await page.evaluate(async () => (await fetch('/api/data')).json());
  assert.ok(after.recipes.some((r) => r.name.includes('Evil')), 'stale delete must not be applied');
  assert.equal(after.recipes.find((r) => r.name === 'Coconut Daal').cookDates.length, 1, 'newer save must survive');
  step('stale tab blocked with reload banner; the other tab’s newer save survived');

  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#recipe-grid .recipe-card').length === 19);
  await page.locator('#recipe-grid .recipe-card', { hasText: 'Evil' }).click();
  await page.click('#btn-delete-recipe');
  await page.waitForFunction(() => document.querySelectorAll('#recipe-grid .recipe-card').length === 18);
  step('after reload the delete succeeds');

  await page.click('nav >> text=Stats');
  await page.waitForSelector('#sd-headline-wrap .sd-headline');
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'stats.png'), fullPage: true });
    await page.click('nav >> text=Recipes');
    await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'recipes.png') });
  }

  assert.deepEqual(problems, []);
  step('no console errors, and no requests to anything other than the local server');
} finally {
  await browser.close();
  if (server) await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
}
