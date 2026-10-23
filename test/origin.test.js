'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, SEED, tempDir, startServer, request, JSON_CT } = require('./helpers');

// A household with one official Kitchen Loop recipe (a real canonical id from the seed) and
// one of the user's own.
const official = { ...SEED.find((r) => r.origin === 'kitchen-loop'), name: 'Official Test Pasta' };
const own = { id: 1700000000000, name: 'My Own Soup', tags: 'Dinner', ingredients: 'Water, Salt' };

let app;
before(async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'kitchen-loop.json'), JSON.stringify({ schemaVersion: 1, revision: 1, recipes: [official, own] }));
  app = await startServer(dir);
});
after(async () => { await app.stop(); });

const getData = async () => (await request(app.port, { path: '/api/data' })).json;
const putRecipes = async (recipes) => {
  const { revision } = await getData();
  return request(app.port, { method: 'PUT', path: '/api/data', headers: JSON_CT, body: { baseRevision: revision, recipes } });
};
const byId = (d, id) => d.recipes.find((r) => r.id === id);

test('only the official recipe carries the origin marker', async () => {
  const d = await getData();
  assert.equal(byId(d, official.id).origin, 'kitchen-loop');
  assert.equal(byId(d, own.id).origin, undefined);
});

test('editing an official recipe keeps the marker, even if the client omits it', async () => {
  const d = await getData();
  const edited = d.recipes.map((r) => (r.id === official.id ? { ...r, name: 'Official Test Pasta (extra garlic)', origin: undefined } : r));
  assert.equal((await putRecipes(edited)).status, 200);
  const after = byId(await getData(), official.id);
  assert.equal(after.name, 'Official Test Pasta (extra garlic)');
  assert.equal(after.origin, 'kitchen-loop');
});

test('user-created recipes can never acquire the marker', async () => {
  const d = await getData();
  const tampered = [
    ...d.recipes.map((r) => (r.id === own.id ? { ...r, origin: 'kitchen-loop' } : r)),
    { id: 1700000000001, name: 'Brand New', tags: 'Dinner', ingredients: 'x', origin: 'kitchen-loop' },
    { id: '1', name: 'String id lookalike', tags: 'Dinner', ingredients: 'x', origin: 'kitchen-loop' },
  ];
  assert.equal((await putRecipes(tampered)).status, 200);
  const after = await getData();
  assert.equal(byId(after, own.id).origin, undefined);
  assert.equal(byId(after, 1700000000001).origin, undefined);
  assert.equal(byId(after, '1').origin, undefined);
  assert.equal(after.recipes.filter((r) => r.origin).length, 1);
});

test('deleting an official recipe removes the marker for good; re-adding its id does not restore it', async () => {
  const d = await getData();
  assert.equal((await putRecipes(d.recipes.filter((r) => r.id !== official.id))).status, 200);
  const readded = [...(await getData()).recipes, { ...official, name: 'Re-added' }];
  assert.equal((await putRecipes(readded)).status, 200);
  const after = byId(await getData(), official.id);
  assert.equal(after.name, 'Re-added');
  assert.equal(after.origin, undefined);
});

test('unknown origin values are rejected', async () => {
  const d = await getData();
  const res = await putRecipes([...d.recipes, { id: 'x-1', name: 'X', ingredients: 'y', origin: 'somebody-else' }]);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /origin/);
});

test('the icon asset is served and only rendered for marked recipes', async () => {
  const icon = await request(app.port, { path: '/kitchen-loop-original.png' });
  assert.equal(icon.status, 200);
  assert.equal(icon.headers['content-type'], 'image/png');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(html, /function isOfficial\(r\)\{ return r\.origin===ORIGIN_KITCHEN_LOOP; \}/);
  assert.match(html, /alt="The Kitchen Loop Original" title="The Kitchen Loop Original"/);
});
