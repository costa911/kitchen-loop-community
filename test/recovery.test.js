'use strict';

// Recovery and provenance regressions: restoring over damaged data must never destroy the
// last good backup, and backups cannot grant "The Kitchen Loop Original" to other recipes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Store, StoreError } = require('../lib/store');
const { ROOT, SEED, tempDir, startServer, request, runCli } = require('./helpers');

const seedFile = path.join(ROOT, 'seed', 'sample-recipes.json');
const CORRUPT = '{"schemaVersion": 1, "recipes": [ {"id": "tkl-lasag';
const OFFICIAL_IDS = SEED.filter((r) => r.origin === 'kitchen-loop').map((r) => r.id);

const newStore = (dir) => new Store({ dataDir: dir, seedFile });
const read = (f) => fs.readFileSync(f, 'utf8');
const mode = (f) => fs.statSync(f).mode & 0o777;
const listing = (dir) => fs.readdirSync(dir).sort();

// A data directory with a valid current file and a valid, *different* .bak (two saves),
// whose current file is then damaged — the state in which Codex reproduced the defect.
async function damagedWithGoodBackup() {
  const dir = tempDir();
  const s = newStore(dir);
  await s.load();
  await s.update((d) => { d.lastSeenChangelogVersion = 1; });
  await s.update((d) => { d.lastSeenChangelogVersion = 2; });
  const goodBackup = read(s.backupFile);
  assert.equal(JSON.parse(goodBackup).lastSeenChangelogVersion, 1);
  const backupToRestore = JSON.stringify(s.read());
  fs.writeFileSync(s.file, CORRUPT);
  return { dir, file: s.file, bak: s.backupFile, goodBackup, backupToRestore };
}

// ── Priority 1: backups during recovery ─────────────────────────────────────────────────

test('1. restoring over a corrupt data file never replaces the valid .bak (regression)', async () => {
  const { dir, file, bak, goodBackup, backupToRestore } = await damagedWithGoodBackup();
  const result = await newStore(dir).restore(backupToRestore);
  assert.equal(read(bak), goodBackup, '.bak must still be the last good backup, not the corrupt file');
  assert.ok(result.damagedCopy, 'the corrupt file is kept aside');
  assert.equal(read(result.damagedCopy), CORRUPT);
  assert.equal(JSON.parse(read(file)).lastSeenChangelogVersion, 2);
  for (const f of [file, bak, result.damagedCopy]) assert.equal(mode(f), 0o600, f);
  assert.deepEqual(listing(dir).filter((n) => n.endsWith('.tmp')), []);
});

test('2. after recovery the data loads, and the next save rotates a *valid* version into .bak', async () => {
  const { dir, file, bak, backupToRestore } = await damagedWithGoodBackup();
  const { damagedCopy } = await newStore(dir).restore(backupToRestore);
  const s = newStore(dir);
  await s.load();
  await s.update((d) => { d.lastSeenChangelogVersion = 9; });
  assert.equal(JSON.parse(read(bak)).lastSeenChangelogVersion, 2, '.bak is now the restored data, never the corrupt file');
  assert.equal(JSON.parse(read(file)).lastSeenChangelogVersion, 9);
  assert.equal(read(damagedCopy), CORRUPT, 'the damaged copy is kept for inspection');
});

test('3. invalid restore input is refused before anything on disk changes', async () => {
  const { dir, file, bak, goodBackup } = await damagedWithGoodBackup();
  const before = listing(dir);
  const bad = [
    '{"truncated": ',
    '[1, 2, 3]',
    JSON.stringify({ schemaVersion: 1, recipes: [{ id: 'x y', name: 'bad id', ingredients: 'a' }] }),
    JSON.stringify({ schemaVersion: 99, recipes: [] }),
  ];
  for (const raw of bad) {
    await assert.rejects(newStore(dir).restore(raw), (e) => e instanceof StoreError && /Nothing was changed/.test(e.message), raw);
  }
  assert.deepEqual(listing(dir), before, 'no damaged copy, temp file or anything else was created');
  assert.equal(read(file), CORRUPT);
  assert.equal(read(bak), goodBackup);
});

test('4. a failure while installing the restored data leaves live data and .bak untouched', async () => {
  const { dir, file, bak, goodBackup, backupToRestore } = await damagedWithGoodBackup();
  const realRename = fsp.rename;
  fsp.rename = async (from, to) => {
    if (to === file) throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' });
    return realRename(from, to);
  };
  try {
    await assert.rejects(newStore(dir).restore(backupToRestore), /simulated disk failure/);
  } finally {
    fsp.rename = realRename;
  }
  assert.equal(read(file), CORRUPT, 'live file unchanged');
  assert.equal(read(bak), goodBackup, 'last good backup unchanged');
  assert.deepEqual(listing(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp files left behind');
  // Retrying once the problem is fixed succeeds and still preserves the good backup.
  await newStore(dir).restore(backupToRestore);
  assert.equal(JSON.parse(read(file)).lastSeenChangelogVersion, 2);
  assert.equal(read(bak), goodBackup);
});

test('5. restored data is intact after a full server restart', async () => {
  const { dir, backupToRestore } = await damagedWithGoodBackup();
  await newStore(dir).restore(backupToRestore);
  const expected = JSON.parse(backupToRestore);
  for (let i = 0; i < 2; i++) {
    const app = await startServer(dir);
    try {
      const d = (await request(app.port, { path: '/api/data' })).json;
      assert.deepEqual(d.recipes, expected.recipes);
      assert.equal(d.lastSeenChangelogVersion, 2);
      assert.ok(d.revision > expected.revision);
    } finally {
      await app.stop();
    }
  }
});

test('a damaged file appearing while the app runs is never rotated into .bak', async () => {
  const dir = tempDir();
  const s = newStore(dir);
  await s.load();
  await s.update((d) => { d.lastSeenChangelogVersion = 1; });
  const good = read(s.backupFile);
  fs.writeFileSync(s.file, CORRUPT); // e.g. damaged by another program
  await s.update((d) => { d.lastSeenChangelogVersion = 2; });
  assert.equal(read(s.backupFile), good);
  assert.equal(JSON.parse(read(s.file)).lastSeenChangelogVersion, 2);
});

test('a missing data file next to a backup is not silently re-initialised with sample recipes', async () => {
  const { dir, file, bak, goodBackup } = await damagedWithGoodBackup();
  fs.rmSync(file);
  const before = listing(dir);
  await assert.rejects(newStore(dir).load(), /is missing, but a backup exists/);
  assert.deepEqual(listing(dir), before, 'nothing created');
  assert.equal(read(bak), goodBackup);
  const cli = await runCli([], { PORT: '0', DATA_DIR: dir });
  assert.equal(cli.code, 1);
  assert.match(cli.err, /is missing, but a backup exists/);
  assert.ok(!fs.existsSync(file), 'server did not create sample data');
});

test('the restore command reports a kept damaged file and leaves .bak alone', async () => {
  const { dir, bak, goodBackup, backupToRestore } = await damagedWithGoodBackup();
  const res = await runCli(['restore'], { DATA_DIR: dir }, backupToRestore);
  assert.equal(res.code, 0, res.err);
  assert.equal(res.stdinError, null);
  assert.match(res.err, /damaged data file was kept as .*\.damaged-/);
  assert.equal(read(bak), goodBackup);
});

// ── Priority 2: provenance ──────────────────────────────────────────────────────────────

test('a forged backup cannot grant the Original marker to other recipes', async () => {
  const dir = tempDir();
  const forged = {
    schemaVersion: 1,
    revision: 3,
    recipes: [
      { id: 1700000000000, name: 'My Pizza', tags: 'Dinner', ingredients: 'Dough', origin: 'kitchen-loop' },
      { id: 'tkl-my-fake-original', name: 'Fake Original', tags: 'Dinner', ingredients: 'x', origin: 'kitchen-loop' },
      { ...SEED.find((r) => r.id === OFFICIAL_IDS[0]) },
    ],
  };
  const result = await newStore(dir).restore(JSON.stringify(forged));
  assert.equal(result.removedOrigins, 2);
  const stored = JSON.parse(read(path.join(dir, 'kitchen-loop.json'))).recipes;
  assert.deepEqual(stored.filter((r) => r.origin).map((r) => r.id), [OFFICIAL_IDS[0]]);
  const cli = await runCli(['restore'], { DATA_DIR: tempDir() }, JSON.stringify(forged));
  assert.equal(cli.code, 0, cli.err);
  assert.equal(cli.stdinError, null);
  assert.match(cli.err, /2 "The Kitchen Loop Original" marker\(s\) .* removed/);
});

test('a hand-edited data file cannot grant the marker either', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'kitchen-loop.json'), JSON.stringify({
    schemaVersion: 1, revision: 1,
    recipes: [{ id: 'sample-01', name: 'Lemon Herb Roast Chicken Traybake', tags: 'Dinner', ingredients: 'Chicken', origin: 'kitchen-loop' }],
  }));
  const app = await startServer(dir);
  try {
    const d = (await request(app.port, { path: '/api/data' })).json;
    assert.equal(d.recipes[0].origin, undefined);
  } finally {
    await app.stop();
  }
});

// Accepted v0.1 limitation, documented in README.md and TESTING.md: the marker is tied to the
// canonical id, not to the recipe's contents. Someone who edits the local data file (or a
// backup) can put any content under a genuine canonical id and it keeps the badge — just as
// editing that original in the app does. This test pins that behaviour down so it stays a
// deliberate, visible trade-off rather than an accident.
test('known limitation: a hand-edited recipe reusing a genuine canonical id keeps the marker', async () => {
  const canonicalId = OFFICIAL_IDS[0];
  const tampered = { id: canonicalId, name: 'Not The Original At All', tags: 'Dessert', ingredients: 'Anything', origin: 'kitchen-loop' };
  const userOwn = { id: 1700000000002, name: 'My Own Dish', tags: 'Dinner', ingredients: 'x', origin: 'kitchen-loop' };

  // Via the data file itself…
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'kitchen-loop.json'), JSON.stringify({ schemaVersion: 1, revision: 1, recipes: [tampered, userOwn] }));
  const app = await startServer(dir);
  try {
    const d = (await request(app.port, { path: '/api/data' })).json;
    assert.equal(d.recipes.find((r) => r.id === canonicalId).origin, 'kitchen-loop', 'canonical id keeps the badge');
    assert.equal(d.recipes.find((r) => r.id === canonicalId).name, 'Not The Original At All');
    assert.equal(d.recipes.find((r) => r.id === userOwn.id).origin, undefined, 'non-canonical ids are still protected');
  } finally {
    await app.stop();
  }

  // …and via a restored backup.
  const result = await newStore(tempDir()).restore(JSON.stringify({ schemaVersion: 1, revision: 1, recipes: [tampered, userOwn] }));
  assert.equal(result.removedOrigins, 1);
});

test('legitimate restore: all 15 Originals keep the marker, including edited ones', async () => {
  const dir = tempDir();
  const s = newStore(dir);
  await s.load();
  await s.update((d) => {
    const r = d.recipes.find((x) => x.id === OFFICIAL_IDS[0]);
    r.name = `${r.name} (my version)`;
    r.ingredients += ', Extra Cheese';
    r.notes = 'Use the big dish.';
  });
  const backup = JSON.stringify(s.read());
  const target = tempDir();
  const result = await newStore(target).restore(backup);
  assert.equal(result.removedOrigins, 0);
  const restored = JSON.parse(read(path.join(target, 'kitchen-loop.json'))).recipes;
  assert.deepEqual(restored.filter((r) => r.origin === 'kitchen-loop').map((r) => r.id).sort(), [...OFFICIAL_IDS].sort());
  const edited = restored.find((r) => r.id === OFFICIAL_IDS[0]);
  assert.match(edited.name, /\(my version\)$/);
  assert.equal(edited.notes, 'Use the big dish.');
  assert.deepEqual(restored, JSON.parse(backup).recipes, 'no other recipe metadata changed');
});
