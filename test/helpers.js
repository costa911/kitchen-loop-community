'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { start } = require('../server');

const ROOT = path.resolve(__dirname, '..');
const silent = { log() {}, error() {} };
const SEED = JSON.parse(fs.readFileSync(path.join(ROOT, 'seed', 'sample-recipes.json'), 'utf8')).recipes;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tkl-test-'));
}

// Starts a real server on a random loopback port with its own data directory.
async function startServer(dataDir = tempDir()) {
  const app = await start({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    publicDir: path.join(ROOT, 'public'),
    seedFile: path.join(ROOT, 'seed', 'sample-recipes.json'),
  }, silent);
  return { ...app, dataDir, base: `http://localhost:${app.port}` };
}

// Raw HTTP request, so tests can set headers (Host, Origin) that fetch() would override.
function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const JSON_CT = { 'Content-Type': 'application/json' };

// Runs `node server.js [args]` as a separate OS process, as a user would, writes `stdin` to
// it and resolves once it has exited and its output streams are closed.
//
// A child that refuses to start — e.g. `restore` while another process holds the data
// lock — exits without reading its input. Whatever part of the input did not fit in the
// OS buffer between the processes (8 KiB on macOS, about 200 KiB on Linux) then fails to
// write with EPIPE. That is expected, not a crash: it is reported as `stdinError` so tests
// can assert on it (a refusal may see EPIPE; a successful run must see none).
function runCli(args, env, stdin) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['server.js', ...args], { cwd: ROOT, env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    let stdinError = null;
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.stdin.on('error', (e) => { stdinError = e.code || String(e); });
    const timer = setTimeout(() => p.kill('SIGKILL'), 15_000);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err, stdinError }); });
    p.stdin.end(stdin ?? '');
  });
}

module.exports = { ROOT, SEED, tempDir, startServer, request, runCli, JSON_CT };
