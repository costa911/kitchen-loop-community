'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { LockError, PREFIX, SUFFIX } = require('../lib/lock');
const { ROOT, SEED, tempDir, startServer, request, runCli, JSON_CT } = require('./helpers');

const lockFiles = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith(PREFIX) && n.endsWith(SUFFIX));
// A refused command may leave part of its input unread, so the only acceptable stdin
// error is EPIPE (see runCli in helpers.js). Anything else is a real failure.
function assertOnlyEpipe(res) {
  assert.ok(res.stdinError === null || res.stdinError === 'EPIPE', `unexpected stdin error: ${res.stdinError}`);
}
const readData = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'kitchen-loop.json'), 'utf8'));

// Starts a long-running server as a separate OS process; resolves once it is listening.
function spawnServer(dataDir) {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: '0', DATA_DIR: dataDir } });
  return new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => { if (String(d).includes('running at')) resolve(p); });
    p.on('exit', (code) => reject(new Error(`server exited early with ${code}`)));
  });
}
const exited = (p) => new Promise((r) => { if (p.exitCode !== null || p.signalCode) r(); else p.on('exit', r); });

async function addRecipe(app, id, name) {
  const { json: d } = await request(app.port, { path: '/api/data' });
  return request(app.port, {
    method: 'PUT', path: '/api/data', headers: JSON_CT,
    body: { baseRevision: d.revision, recipes: [...d.recipes, { id, name, tags: 'Dinner', ingredients: 'x' }] },
  });
}

test('a second server process on the same data directory refuses to start', async () => {
  const app = await startServer();
  try {
    const second = await runCli([], { PORT: '0', DATA_DIR: app.dataDir });
    assert.equal(second.code, 1);
    assert.match(second.err, /Only one server may use a data directory/);
    assert.match(second.err, /server pid \d+/);
    assert.equal((await addRecipe(app, 'a-1', 'Still works')).status, 200);
  } finally {
    await app.stop();
  }
});

// Codex's interleaving: A validates ownership, pauses, the lock "expires", B takes over and
// writes, A resumes and overwrites B. With a liveness-based lock there is no expiry: while A
// exists, nobody else can become the owner, however long A is paused.
test('regression: owner paused between its ownership check and its write cannot be overtaken', async () => {
  const a = await startServer();
  try {
    let validated;
    const reachedCheck = new Promise((r) => { validated = r; });
    let resume;
    const gate = new Promise((r) => { resume = r; });
    const realAssert = a.store.lock.assertHeld.bind(a.store.lock);
    a.store.lock.assertHeld = async () => { await realAssert(); validated(); await gate; };

    const write = addRecipe(a, 'from-a', 'Written by A');
    await reachedCheck; // A has validated ownership and is now paused before writing

    // Longer than the 15-second expiry of the previous lock design.
    const pauseUntil = Date.now() + 16_000;
    let attempts = 0;
    while (Date.now() < pauseUntil) {
      const b = await runCli([], { PORT: '0', DATA_DIR: a.dataDir });
      assert.equal(b.code, 1, 'B must not become the owner while A is paused');
      assert.match(b.err, /Only one server may use a data directory/);
      const backup = JSON.stringify({ ...readData(a.dataDir), recipes: [{ id: 'from-b', name: 'Written by B', ingredients: 'x' }] });
      const bRestore = await runCli(['restore'], { DATA_DIR: a.dataDir }, backup);
      assert.equal(bRestore.code, 1, 'B must not be able to write while A is paused');
      assertOnlyEpipe(bRestore);
      attempts++;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(attempts >= 3);
    assert.equal(lockFiles(a.dataDir).length, 1);

    resume();
    assert.equal((await write).status, 200);
    const names = readData(a.dataDir).recipes.map((r) => r.name);
    assert.ok(names.includes('Written by A'));
    assert.ok(!names.includes('Written by B'));
  } finally {
    await a.stop();
  }
});

test('a frozen (SIGSTOP) server process keeps the lock; nobody can take over', async () => {
  const dir = tempDir();
  const a = await spawnServer(dir);
  try {
    a.kill('SIGSTOP');
    const b = await runCli([], { PORT: '0', DATA_DIR: dir });
    assert.equal(b.code, 1);
    assert.match(b.err, /Only one server may use a data directory/);
  } finally {
    a.kill('SIGCONT');
    a.kill('SIGTERM');
    await exited(a);
  }
  assert.deepEqual(lockFiles(dir), []);
});

test('a crashed (SIGKILL) server releases the lock immediately; the next start cleans up', async () => {
  const dir = tempDir();
  const a = await spawnServer(dir);
  a.kill('SIGKILL');
  await exited(a);
  assert.equal(lockFiles(dir).length, 1, 'the crashed process leaves its socket file behind');
  const b = await startServer(dir); // no waiting period
  try {
    assert.equal(lockFiles(dir).length, 1);
    assert.equal((await addRecipe(b, 'after-crash', 'After crash')).status, 200);
  } finally {
    await b.stop();
  }
  assert.deepEqual(lockFiles(dir), []);
});

test('the same applies in-process, and separate data directories are independent', async () => {
  const a = await startServer();
  const b = await startServer();
  try {
    await assert.rejects(startServer(a.dataDir), (e) => e instanceof LockError);
    assert.equal(lockFiles(a.dataDir).length, 1, 'the refused attempt removes its own socket');
  } finally {
    await a.stop();
    await b.stop();
  }
});

test('the lock is released on shutdown, so the next server can start', async () => {
  const a = await startServer();
  const dir = a.dataDir;
  await a.stop();
  assert.deepEqual(lockFiles(dir), []);
  const b = await startServer(dir);
  await b.stop();
});

test('works with data directory paths longer than the Unix socket path limit', async () => {
  const dir = path.join(tempDir(), 'a-rather-long-directory-name-for-testing'.repeat(3), 'data');
  assert.ok(dir.length > 110);
  const cwd = process.cwd();
  const a = await startServer(dir);
  try {
    assert.equal(process.cwd(), cwd);
    assert.equal(lockFiles(dir).length, 1);
    const b = await runCli([], { PORT: '0', DATA_DIR: dir });
    assert.equal(b.code, 1);
    assert.match(b.err, /Only one server may use a data directory/);
  } finally {
    await a.stop();
  }
  assert.deepEqual(lockFiles(dir), []);
  assert.equal(process.cwd(), cwd);
});

test('secondary safeguard: if the lock file is deleted by hand, the server stops saving', async () => {
  const app = await startServer();
  try {
    const before = fs.readFileSync(path.join(app.dataDir, 'kitchen-loop.json'), 'utf8');
    for (const f of lockFiles(app.dataDir)) fs.rmSync(path.join(app.dataDir, f));
    const res = await addRecipe(app, 'x-1', 'Should not save');
    assert.equal(res.status, 503);
    assert.match(res.json.error, /lock file was removed/);
    assert.equal(fs.readFileSync(path.join(app.dataDir, 'kitchen-loop.json'), 'utf8'), before);
  } finally {
    await app.stop();
  }
});

test('restore refuses to run while a server uses the data; backup works while it runs', async () => {
  const app = await startServer();
  const dir = app.dataDir;
  let backup;
  try {
    backup = await runCli(['backup'], { DATA_DIR: dir });
    assert.equal(backup.code, 0, backup.err);
    assert.equal(JSON.parse(backup.out).recipes.length, SEED.length);
    const refused = await runCli(['restore'], { DATA_DIR: dir }, backup.out);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /Only one server may use a data directory/);
    assertOnlyEpipe(refused);
  } finally {
    await app.stop();
  }
  const restored = await runCli(['restore'], { DATA_DIR: dir }, backup.out);
  assert.equal(restored.code, 0, restored.err);
  assert.equal(restored.stdinError, null, 'a successful restore reads its whole input');
  assert.match(restored.err, new RegExp(`Restored ${SEED.length} recipes`));
  assert.deepEqual(lockFiles(dir), []);
});

// Regression (macOS): a refused restore exits without reading its input. With a backup
// larger than the OS buffer between the processes, the test harness used to crash with an
// unhandled `write EPIPE`. 1 MiB exceeds that buffer on macOS and Linux alike.
test('a refused restore with a large backup is reported cleanly; the same backup restores once unlocked', async () => {
  const app = await startServer();
  const dir = app.dataDir;
  let large;
  try {
    const backup = await runCli(['backup'], { DATA_DIR: dir });
    assert.equal(backup.code, 0, backup.err);
    large = backup.out + ' '.repeat(1024 * 1024); // still a valid JSON document
    const refused = await runCli(['restore'], { DATA_DIR: dir }, large);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /Only one server may use a data directory/);
    assertOnlyEpipe(refused);
  } finally {
    await app.stop();
  }
  const restored = await runCli(['restore'], { DATA_DIR: dir }, large);
  assert.equal(restored.code, 0, restored.err);
  assert.equal(restored.stdinError, null, 'the whole 1 MiB backup was read');
  assert.deepEqual(lockFiles(dir), []);
});

test('backup of a directory with no data yet fails clearly and creates nothing', async () => {
  const dir = tempDir();
  const res = await runCli(['backup'], { DATA_DIR: dir });
  assert.equal(res.code, 1);
  assert.match(res.err, /No data file/);
  assert.deepEqual(fs.readdirSync(dir), []);
});
