'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SEED, startServer, request, JSON_CT } = require('./helpers');

let app;
before(async () => { app = await startServer(); });
after(async () => { await app.stop(); });

const get = (p, headers) => request(app.port, { path: p, headers });
const write = (method, p, body, headers = JSON_CT) => request(app.port, { method, path: p, body, headers });
const revision = async () => (await get('/api/data')).json.revision;
const recipe = (over = {}) => ({ id: 'test-1', name: 'Test Stew', tags: 'Dinner', ingredients: 'Carrot, Onion', ...over });

test('serves the app and its assets with security headers, and no external URLs', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  assert.match(res.headers['content-security-policy'], /connect-src 'self'/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.equal((await get('/fonts/dm-sans-latin-400-normal.woff2')).status, 200);
  assert.equal((await get('/thekitchenloop.png')).status, 200);
});

test('static serving never escapes the public folder', async () => {
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/server.js', '/lib/app.js', '/..%2fpackage.json', '/fonts/../../server.js']) {
    assert.equal((await get(p)).status, 404, p);
  }
});

test('GET /api/data returns the household with a revision', async () => {
  const res = await get('/api/data');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.json.recipes.length, SEED.length);
  assert.ok(Number.isInteger(res.json.revision));
});

test('create, modify and retrieve a recipe', async () => {
  const { json: d } = await get('/api/data');
  let res = await write('PUT', '/api/data', { baseRevision: d.revision, recipes: [...d.recipes, recipe()] });
  assert.equal(res.status, 200);
  assert.equal(res.json.revision, d.revision + 1);
  res = await write('PUT', '/api/data', { baseRevision: res.json.revision, recipes: [...d.recipes, recipe({ name: 'Test Stew v2', cookDates: ['2026-10-01T18:00:00.000Z'] })] });
  assert.equal(res.status, 200);
  const saved = (await get('/api/data')).json.recipes.find((r) => r.id === 'test-1');
  assert.equal(saved.name, 'Test Stew v2');
  assert.deepEqual(saved.cookDates, ['2026-10-01T18:00:00.000Z']);
  assert.equal(saved.instagramLink, '');
});

test('a write based on a stale revision is refused with 409 and changes nothing', async () => {
  const rev = await revision();
  assert.equal((await write('PUT', '/api/changelog-seen', { baseRevision: rev, version: 1 })).status, 200);
  const stale = await write('PUT', '/api/data', { baseRevision: rev, recipes: [] });
  assert.equal(stale.status, 409);
  assert.match(stale.json.error, /another tab/);
  assert.ok((await get('/api/data')).json.recipes.length > 0);
});

test('concurrent writes from the same base revision: exactly one wins', async () => {
  const { json: d } = await get('/api/data');
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => write('PUT', '/api/data', {
    baseRevision: d.revision,
    recipes: [...d.recipes, recipe({ id: `race-${i}`, name: `Race ${i}` })],
  })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 9);
  const after = (await get('/api/data')).json;
  assert.equal(after.recipes.filter((r) => String(r.id).startsWith('race-')).length, 1);
  assert.equal(after.revision, d.revision + 1);
});

test('custom list: save, archive into history, clear', async () => {
  let res = await write('PUT', '/api/custom-list', { baseRevision: await revision(), recipeIds: ['sample-01', 'sample-02', 'sample-01'], shoppingChecked: { Lemon: true } });
  assert.equal(res.status, 200);
  let d = (await get('/api/data')).json;
  assert.deepEqual(d.customList.recipeIds, ['sample-01', 'sample-02']);
  assert.ok(d.customList.createdAt);
  res = await write('POST', '/api/custom-list/archive', { baseRevision: d.revision });
  assert.equal(res.status, 200);
  assert.equal(res.json.entry.type, 'custom');
  assert.equal(res.json.entry.entries[0].recipeName, 'Lemon Herb Roast Chicken Traybake');
  d = (await get('/api/data')).json;
  assert.deepEqual(d.customList.recipeIds, []);
  assert.equal(d.planHistory[0].type, 'custom');
  assert.equal((await write('POST', '/api/custom-list/archive', { baseRevision: d.revision })).status, 400);
  assert.equal((await write('POST', '/api/custom-list/clear', { baseRevision: d.revision })).status, 200);
});

test('meal plan and shopping ticks round-trip', async () => {
  const plan = Array.from({ length: 14 }, (_, i) => ({ type: 'dinner', week: i < 7 ? 1 : 2, day: 'Monday', recipeId: `sample-0${(i % 9) + 1}`, recipeName: 'x', sideId: null, sideName: null, cooked: false, cookedDate: null }));
  const res = await write('PUT', '/api/data', { baseRevision: await revision(), plan, shoppingChecked: { 'Olive Oil': true, Garlic: false } });
  assert.equal(res.status, 200);
  const d = (await get('/api/data')).json;
  assert.equal(d.plan.length, 14);
  assert.deepEqual(d.shoppingChecked, { 'Olive Oil': true });
});

test('changelog-seen never moves backwards', async () => {
  await write('PUT', '/api/changelog-seen', { baseRevision: await revision(), version: 5 });
  await write('PUT', '/api/changelog-seen', { baseRevision: await revision(), version: 2 });
  assert.equal((await get('/api/data')).json.lastSeenChangelogVersion, 5);
});

test('malformed and invalid requests are rejected with 4xx and change nothing', async () => {
  const beforeRev = await revision();
  const cases = [
    ['malformed JSON', 'PUT', '/api/data', '{"recipes": [', 400],
    ['array body', 'PUT', '/api/data', '[]', 400],
    ['missing baseRevision', 'PUT', '/api/data', { recipes: [] }, 400],
    ['unknown field', 'PUT', '/api/data', { baseRevision: beforeRev, schemaVersion: 99 }, 400],
    ['javascript: link', 'PUT', '/api/data', { baseRevision: beforeRev, recipes: [recipe({ instagramLink: 'javascript:alert(1)' })] }, 400],
    ['data: link', 'PUT', '/api/data', { baseRevision: beforeRev, recipes: [recipe({ tiktokLink: 'data:text/html,<script>1</script>' })] }, 400],
    ['id that could break out of an attribute', 'PUT', '/api/data', { baseRevision: beforeRev, recipes: [recipe({ id: "x');alert(1);('" })] }, 400],
    ['duplicate ids', 'PUT', '/api/data', { baseRevision: beforeRev, recipes: [recipe(), recipe()] }, 400],
    ['empty name', 'PUT', '/api/data', { baseRevision: beforeRev, recipes: [recipe({ name: '  ' })] }, 400],
    ['oversized name', 'PUT', '/api/data', { baseRevision: beforeRev, recipes: [recipe({ name: 'x'.repeat(201) })] }, 400],
    ['bad cook date', 'PUT', '/api/data', { baseRevision: beforeRev, recipes: [recipe({ cookDates: ['yesterday-ish'] })] }, 400],
    ['wrong type', 'PUT', '/api/data', { baseRevision: beforeRev, recipes: 'all of them' }, 400],
    ['bad plan item', 'PUT', '/api/data', { baseRevision: beforeRev, plan: [{ type: 'brunch', week: 3 }] }, 400],
    ['__proto__ in ticks', 'PUT', '/api/data', `{"baseRevision":${beforeRev},"shoppingChecked":{"__proto__":true}}`, 400],
    ['non-boolean tick', 'PUT', '/api/data', { baseRevision: beforeRev, shoppingChecked: { Milk: 'yes' } }, 400],
    ['custom list without ids', 'PUT', '/api/custom-list', { baseRevision: beforeRev }, 400],
    ['non-integer changelog version', 'PUT', '/api/changelog-seen', { baseRevision: beforeRev, version: '2' }, 400],
  ];
  for (const [name, method, p, body, status] of cases) {
    const res = await write(method, p, body);
    assert.equal(res.status, status, `${name}: ${res.text}`);
    assert.ok(res.json && typeof res.json.error === 'string', name);
  }
  assert.equal(({}).polluted, undefined);
  assert.equal(await revision(), beforeRev);
});

test('oversized bodies are refused with 413', async () => {
  const res = await write('PUT', '/api/data', `{"baseRevision":1,"recipes":"${'x'.repeat(5 * 1024 * 1024 + 10)}"}`);
  assert.equal(res.status, 413);
});

test('unknown routes and methods', async () => {
  assert.equal((await get('/api/nope')).status, 404);
  assert.equal((await write('DELETE', '/api/data', {})).status, 405);
  assert.equal((await write('POST', '/', {})).status, 405);
  // Production-only endpoints do not exist here.
  for (const p of ['/auth', '/heartbeat', '/link-click', '/stock', '/admin/analytics', '/api/heartbeat']) {
    assert.equal((await write('PUT', p, {})).status, p.startsWith('/api') ? 404 : 405, p);
  }
});

test('requests not addressed to localhost are refused (DNS rebinding / exposed port)', async () => {
  for (const host of ['attacker.example', 'attacker.example:80', '192.168.1.20:8080', 'localhost.attacker.example', 'localhost:8080@attacker.example']) {
    const res = await get('/api/data', { Host: host });
    assert.equal(res.status, 421, host);
  }
  for (const host of [`localhost:${app.port}`, `127.0.0.1:${app.port}`, 'localhost']) {
    assert.equal((await get('/api/health', { Host: host })).status, 200, host);
  }
});

test('state-changing requests require JSON and same origin (CSRF)', async () => {
  const rev = await revision();
  const body = { baseRevision: rev, version: 9 };
  // A plain HTML form post or "simple" cross-site fetch cannot set a JSON content type.
  assert.equal((await write('PUT', '/api/changelog-seen', body, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await write('PUT', '/api/changelog-seen', body, { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await write('PUT', '/api/changelog-seen', body, {})).status, 415);
  assert.equal((await write('PUT', '/api/changelog-seen', body, { ...JSON_CT, Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await write('PUT', '/api/changelog-seen', body, { ...JSON_CT, Origin: 'null' })).status, 403);
  assert.equal((await write('PUT', '/api/changelog-seen', body, { ...JSON_CT, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(await revision(), rev);
  const ok = await write('PUT', '/api/changelog-seen', body, { ...JSON_CT, Origin: `http://localhost:${app.port}`, 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(ok.status, 200);
});

test('data survives a full server restart', async () => {
  const { json: d } = await get('/api/data');
  await write('PUT', '/api/data', { baseRevision: d.revision, recipes: [...d.recipes, recipe({ id: 'restart-1', name: 'After Restart' })] });
  const dataDir = app.dataDir;
  await app.stop();
  app = await startServer(dataDir);
  const after = (await get('/api/data')).json;
  assert.ok(after.recipes.some((r) => r.name === 'After Restart'));
  assert.equal(after.revision, d.revision + 1);
});
