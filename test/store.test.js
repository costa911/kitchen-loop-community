'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store, StoreError, SCHEMA_VERSION } = require('../lib/store');
const { ROOT, SEED, tempDir } = require('./helpers');

const seedFile = path.join(ROOT, 'seed', 'sample-recipes.json');
const newStore = (dataDir) => new Store({ dataDir, seedFile });
const readFile = (store) => JSON.parse(fs.readFileSync(store.file, 'utf8'));

test('first start creates the data file from the seed, with schema version and revision', async () => {
  const dir = path.join(tempDir(), 'nested', 'data');
  const store = newStore(dir);
  assert.deepEqual(await store.load(), { created: true });
  const doc = readFile(store);
  assert.equal(doc.schemaVersion, SCHEMA_VERSION);
  assert.equal(doc.revision, 1);
  assert.equal(doc.recipes.length, SEED.length);
  assert.deepEqual(doc.plan, []);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
});

test('first-run data supports a full fortnight of 14 different dinners', () => {
  const tags = (r) => r.tags.split(',').map((t) => t.trim());
  const mains = SEED.filter((r) => !tags(r).some((t) => ['Dessert', 'Side', 'Dressing'].includes(t)));
  assert.ok(mains.length >= 14);
  assert.equal(new Set(mains.map((r) => r.name)).size, mains.length);
});

test('updates persist and are visible to a new Store instance (restart)', async () => {
  const dir = tempDir();
  const a = newStore(dir);
  await a.load();
  await a.update((doc) => { doc.recipes.push({ id: 'r1', name: 'Persisted', tags: 'Dinner', ingredients: 'x', notes: '', instagramLink: '', tiktokLink: '', threadsLink: '', pairsWith: '', cookDates: [] }); });
  const b = newStore(dir);
  assert.deepEqual(await b.load(), { created: false });
  assert.ok(b.read().recipes.some((r) => r.name === 'Persisted'));
  assert.equal(b.read().revision, 2);
});

test('concurrent updates are serialised: none are lost', async () => {
  const store = newStore(tempDir());
  await store.load();
  await Promise.all(Array.from({ length: 50 }, (_, i) => store.update(async (doc) => {
    const n = doc.plan.length;
    await new Promise((r) => setTimeout(r, Math.random() * 3)); // widen any race window
    doc.plan = [...doc.plan.slice(0, n), { type: 'dinner', week: 1, day: `d${i}`, recipeId: null, recipeName: 'x', sideId: null, sideName: null, cooked: false, cookedDate: null }];
  })));
  assert.equal(store.read().plan.length, 50);
  assert.equal(readFile(store).plan.length, 50);
  assert.equal(store.read().revision, 51);
});

test('a failed mutation changes nothing and does not block later updates', async () => {
  const store = newStore(tempDir());
  await store.load();
  const before = fs.readFileSync(store.file, 'utf8');
  await assert.rejects(store.update((doc) => { doc.recipes = []; throw new Error('boom'); }), /boom/);
  assert.equal(store.read().recipes.length, SEED.length);
  assert.equal(fs.readFileSync(store.file, 'utf8'), before);
  await store.update((doc) => { doc.lastSeenChangelogVersion = 3; });
  assert.equal(readFile(store).lastSeenChangelogVersion, 3);
});

test('each write keeps the previous valid version as .bak and leaves no temp files', async () => {
  const store = newStore(tempDir());
  await store.load();
  await store.update((doc) => { doc.lastSeenChangelogVersion = 1; });
  await store.update((doc) => { doc.lastSeenChangelogVersion = 2; });
  const bak = JSON.parse(fs.readFileSync(store.backupFile, 'utf8'));
  assert.equal(bak.lastSeenChangelogVersion, 1);
  assert.equal(readFile(store).lastSeenChangelogVersion, 2);
  assert.deepEqual(fs.readdirSync(store.dataDir).filter((f) => f.endsWith('.tmp')), []);
});

test('leftover temp files from an interrupted write are removed at startup', async () => {
  const store = newStore(tempDir());
  await store.load();
  const leftover = `${store.file}.999.abcdef.tmp`;
  fs.writeFileSync(leftover, '{"half": ');
  await newStore(store.dataDir).load();
  assert.equal(fs.existsSync(leftover), false);
});

test('a corrupt data file stops startup with a clear message and is left untouched', async () => {
  const store = newStore(tempDir());
  await store.load();
  fs.writeFileSync(store.file, '{"schemaVersion": 1, "recipes": [');
  await assert.rejects(newStore(store.dataDir).load(), (e) => e instanceof StoreError && /not valid JSON/.test(e.message) && /\.bak/.test(e.message));
  assert.equal(fs.readFileSync(store.file, 'utf8'), '{"schemaVersion": 1, "recipes": [');
});

test('a structurally invalid data file is refused at startup', async () => {
  const store = newStore(tempDir());
  await store.load();
  fs.writeFileSync(store.file, JSON.stringify({ schemaVersion: 1, recipes: [{ id: 'bad id!', name: 'x', ingredients: 'y' }] }));
  await assert.rejects(newStore(store.dataDir).load(), /failed validation/);
});

test('a data file from a newer version is refused rather than downgraded', async () => {
  const store = newStore(tempDir());
  await store.load();
  fs.writeFileSync(store.file, JSON.stringify({ ...readFile(store), schemaVersion: SCHEMA_VERSION + 1 }));
  await assert.rejects(newStore(store.dataDir).load(), /Upgrade the application/);
});

test('restore: valid backup replaces data, bumps revision past both, keeps previous as .bak', async () => {
  const store = newStore(tempDir());
  await store.load();
  const backup = JSON.stringify(store.read());
  await store.update((doc) => { doc.recipes = []; });
  await store.update((doc) => { doc.plan = []; });
  const fresh = newStore(store.dataDir);
  await fresh.restore(backup);
  assert.equal(readFile(fresh).recipes.length, SEED.length);
  assert.equal(readFile(fresh).revision, 4);
  assert.equal(JSON.parse(fs.readFileSync(fresh.backupFile, 'utf8')).recipes.length, 0);
});

test('restore recovers from a corrupt data file', async () => {
  const store = newStore(tempDir());
  await store.load();
  const backup = JSON.stringify(store.read());
  fs.writeFileSync(store.file, 'garbage');
  await newStore(store.dataDir).restore(backup);
  assert.equal((await (async () => { const s = newStore(store.dataDir); await s.load(); return s.read(); })()).recipes.length, SEED.length);
});

test('restore refuses damaged or invalid backups and changes nothing', async () => {
  const store = newStore(tempDir());
  await store.load();
  const before = fs.readFileSync(store.file, 'utf8');
  await assert.rejects(newStore(store.dataDir).restore('{"truncated": '), /not valid JSON.*Nothing was changed/);
  await assert.rejects(newStore(store.dataDir).restore(JSON.stringify({ schemaVersion: 1, recipes: [{ id: 1, name: '', ingredients: 'x' }] })), /failed validation/);
  await assert.rejects(newStore(store.dataDir).restore('[1,2,3]'), /not a JSON object/);
  assert.equal(fs.readFileSync(store.file, 'utf8'), before);
});
