'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { start, config } = require('../server');
const { ROOT, tempDir } = require('./helpers');

const silent = { log() {}, error() {} };

function nonLoopbackIPv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 2000 });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.once('timeout', () => { s.destroy(); resolve(false); });
  });
}

test('defaults: loopback address, port 8080', () => {
  const cfg = config({});
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.dataDir, path.join(ROOT, 'data'));
});

test('with default settings the server listens on loopback only', async () => {
  const app = await start({ ...config({ PORT: '0', DATA_DIR: tempDir() }) }, silent);
  try {
    assert.equal(app.server.address().address, '127.0.0.1');
    assert.equal(await canConnect('127.0.0.1', app.port), true);
    const lan = nonLoopbackIPv4();
    if (lan) assert.equal(await canConnect(lan, app.port), false, `reachable on ${lan}`);
  } finally {
    await app.stop();
  }
});

test('compose publishes the port on the host loopback interface only', () => {
  const compose = fs.readFileSync(path.join(ROOT, 'compose.yaml'), 'utf8');
  const ports = compose.match(/^\s*-\s*"([^"]*:8080)"\s*$/gm) || [];
  assert.equal(ports.length, 1);
  assert.match(ports[0], /"127\.0\.0\.1:\$\{KITCHEN_LOOP_PORT:-8080\}:8080"/);
});

test('container runs as an unprivileged user with a hardened compose service', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^FROM \S+@sha256:[0-9a-f]{64}$/m);
  const compose = fs.readFileSync(path.join(ROOT, 'compose.yaml'), 'utf8');
  for (const line of ['read_only: true', '- ALL', 'no-new-privileges:true', 'kitchen-loop-community-data:/data']) {
    assert.ok(compose.includes(line), line);
  }
});
