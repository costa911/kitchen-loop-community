#!/usr/bin/env node
'use strict';

// The Kitchen Loop — Community Edition server.
// Serves the single-page frontend and a small JSON API backed by one local data file.
// Built only on Node.js core modules: there is nothing to `npm install`.

const http = require('node:http');
const path = require('node:path');
const { Store } = require('./lib/store');
const { DataDirLock } = require('./lib/lock');
const { createApp } = require('./lib/app');

const MIN_NODE_MAJOR = 22;

function config(env = process.env) {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);
  return {
    port,
    // Loopback by default. The container image sets HOST=0.0.0.0 because Docker can only
    // forward to a container that listens on all of its interfaces; compose.yaml then
    // publishes the port on the host's 127.0.0.1 only.
    host: env.HOST || '127.0.0.1',
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, 'data')),
    publicDir: path.join(__dirname, 'public'),
    seedFile: path.join(__dirname, 'seed', 'sample-recipes.json'),
  };
}

async function start(cfg = config(), logger = console) {
  // Only one server per data directory: a second one would overwrite this one's changes.
  const lock = new DataDirLock(cfg.dataDir);
  await lock.acquire('server');

  const store = new Store({ dataDir: cfg.dataDir, seedFile: cfg.seedFile, lock });
  const server = http.createServer(createApp({ store, publicDir: cfg.publicDir, logger }));
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  try {
    const { created } = await store.load();
    logger.log(created
      ? `Created a new data file with sample recipes at ${store.file}`
      : `Loaded data from ${store.file}`);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, () => { server.off('error', reject); resolve(); });
    });
  } catch (e) {
    await lock.release();
    throw e;
  }

  const { port } = server.address();
  return {
    server,
    store,
    port,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await store.drain();
      await lock.release();
    },
  };
}

// `node server.js backup`  — prints the current data as JSON on stdout. Read-only, so it
//                             is safe while the server is running.
// `node server.js restore` — replaces the data with a backup read from stdin. It takes the
//                             data directory lock, so it refuses to run while a server is
//                             using the same data (that server would overwrite the restore).
async function runCommand(command) {
  const cfg = config();
  if (command === 'backup') {
    const store = new Store({ dataDir: cfg.dataDir, seedFile: cfg.seedFile });
    process.stdout.write(JSON.stringify(await store.readFromDisk(), null, 2) + '\n');
    return;
  }
  const lock = new DataDirLock(cfg.dataDir);
  await lock.acquire('restore');
  try {
    const store = new Store({ dataDir: cfg.dataDir, seedFile: cfg.seedFile, lock });
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const { recipes, removedOrigins, damagedCopy } = await store.restore(Buffer.concat(chunks).toString('utf8'));
    console.error(`Restored ${recipes} recipes into ${store.file}.`);
    if (damagedCopy) console.error(`The damaged data file was kept as ${damagedCopy}; ${store.backupFile} was left untouched.`);
    else console.error(`The previous data was kept as ${store.backupFile}.`);
    if (removedOrigins) console.error(`${removedOrigins} "The Kitchen Loop Original" marker(s) on recipes that are not Kitchen Loop originals were removed.`);
  } finally {
    await lock.release();
  }
}

async function main() {
  const command = process.argv[2];
  if (command === 'backup' || command === 'restore') {
    try {
      await runCommand(command);
    } catch (e) {
      console.error(`${command} failed: ${e.message}`);
      process.exit(1);
    }
    return;
  }
  if (command !== undefined) {
    console.error('Usage: node server.js [backup | restore]');
    process.exit(2);
  }

  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) {
    console.error(`The Kitchen Loop needs Node.js ${MIN_NODE_MAJOR} or newer (found ${process.version}).`);
    process.exit(1);
  }

  let app;
  try {
    app = await start();
  } catch (e) {
    console.error(`Failed to start: ${e.message}`);
    process.exit(1);
  }
  console.log(`The Kitchen Loop is running at http://localhost:${app.port}`);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, finishing pending saves…`);
    const force = setTimeout(() => process.exit(1), 10_000).unref();
    await app.stop();
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) main();

module.exports = { start, config };
