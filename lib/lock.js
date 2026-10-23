'use strict';

const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// One process per data directory.
//
// The server caches the data file in memory, so two processes (or a server and a
// `restore`) sharing one data directory would overwrite each other's changes. This lock
// prevents that without any timeouts:
//
// - Each process listens on its own Unix socket inside the data directory for as long as
//   it runs. The operating system keeps that socket accepting connections while the
//   process exists — even if it is paused or suspended — and refuses connections the
//   moment the process dies, however it dies (crash, SIGKILL, power loss).
// - A process becomes the owner only if, after creating its own socket, it finds no
//   other socket in the directory that still accepts connections. If it finds one, it
//   removes its own socket and refuses to start.
// - Because ownership is decided by whether the holder is alive, not by how recently it
//   did something, a paused owner can never lose the lock, and a crashed owner's lock is
//   released immediately. A process that is no longer the owner is therefore always a
//   dead one, which cannot write.
//
// Two processes starting at the same instant cannot both succeed: each one checks for the
// other only after its own socket exists, so whichever checks last sees the other one.
// (In that rare case both may refuse; starting again resolves it.)
//
// Works across containers that share a volume on one host. Not for network filesystems.

const PREFIX = '.kitchen-loop-';
const SUFFIX = '.lock';
// Unix socket paths are limited to 104 bytes on macOS and 108 on Linux. Longer paths are
// handled by binding/connecting relative to the data directory (see inDir).
const MAX_SOCKET_PATH = 100;
const PROBE_TIMEOUT_MS = 1000;

class LockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockError';
  }
}

// Runs fn with the data directory as the working directory so a socket can be addressed
// by its short relative name. bind(), connect() and close() resolve the name synchronously
// inside the call, so the previous working directory is restored before any other code runs.
function inDir(dir, fn) {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

function socketCall(dir, name, fn) {
  const full = path.join(dir, name);
  return full.length <= MAX_SOCKET_PATH ? fn(full) : inDir(dir, () => fn(name));
}

const isLockName = (name) => name.startsWith(PREFIX) && name.endsWith(SUFFIX);

// Resolves to null if nothing is listening on the socket (its owner is gone), otherwise
// to whatever the owner reports about itself. A paused owner accepts the connection but
// cannot answer; it is still alive, so it counts as the owner.
function probe(dir, name) {
  return new Promise((resolve) => {
    let reply = '';
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); socket.destroy(); resolve(value); } };
    const socket = socketCall(dir, name, (p) => net.connect(p));
    const timer = setTimeout(() => done({ unresponsive: true }), PROBE_TIMEOUT_MS);
    socket.on('data', (d) => { reply += d; });
    socket.on('end', () => {
      try { done(JSON.parse(reply)); } catch { done({}); }
    });
    socket.on('error', (e) => {
      // Refused or missing: no live owner. Anything else (e.g. permissions): assume alive.
      done(e.code === 'ECONNREFUSED' || e.code === 'ENOENT' || e.code === 'ENOTSOCK' ? null : { error: e.code });
    });
  });
}

class DataDirLock {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.name = null;
    this._server = null;
    this._ino = null;
  }

  get file() {
    return this.name && path.join(this.dataDir, this.name);
  }

  async acquire(purpose) {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const info = JSON.stringify({ purpose, pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() });
    const name = `${PREFIX}${crypto.randomBytes(6).toString('hex')}${SUFFIX}`;

    // Answers probes with who holds the lock. The prober may already have hung up (e.g. it
    // timed out while this process was paused), so socket errors are ignored here.
    const server = net.createServer((socket) => { socket.on('error', () => {}); socket.end(info); });
    server.on('error', () => {});
    server.unref(); // never keeps the process alive on its own
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      socketCall(this.dataDir, name, (p) => server.listen(p, () => { server.off('error', reject); resolve(); }));
    });
    this._server = server;
    this.name = name;
    this._ino = (await fs.stat(this.file)).ino;

    const dead = [];
    for (const other of (await fs.readdir(this.dataDir)).filter((n) => isLockName(n) && n !== name)) {
      const owner = await probe(this.dataDir, other);
      if (owner) {
        await this.release();
        throw new LockError(this._inUseMessage(owner));
      }
      dead.push(other);
    }
    // Sockets left behind by processes that died. Nothing can be listening on them (that
    // was just checked, and a new process always creates a new name), so removing them is safe.
    for (const other of dead) await fs.rm(path.join(this.dataDir, other), { force: true });
  }

  // Secondary safeguard, called before every write: confirms this process's socket is
  // still in place (for example, that nobody deleted it by hand). Ownership itself never
  // changes while this process is alive, so this is not what prevents the race.
  async assertHeld() {
    let ino = null;
    try { ino = (await fs.stat(this.file)).ino; } catch { /* missing */ }
    if (!this._server || !this._server.listening || ino !== this._ino) {
      throw new LockError('The data directory lock file was removed while the app was running, so it will not save. Restart the app.');
    }
  }

  async release() {
    const server = this._server;
    if (!server) return;
    this._server = null;
    // close() also removes the socket file; for relative names it must run in the data dir.
    await new Promise((resolve) => socketCall(this.dataDir, this.name, () => server.close(() => resolve())));
    await fs.rm(this.file, { force: true });
    this.name = null;
    this._ino = null;
  }

  _inUseMessage(owner) {
    const who = owner.pid ? ` (${owner.purpose || 'process'} pid ${owner.pid} on ${owner.host}, since ${owner.startedAt})` : '';
    return `Another Kitchen Loop process is already using ${this.dataDir}${who}. ` +
      'Only one server may use a data directory at a time — stop the other one first.';
  }
}

module.exports = { DataDirLock, LockError, PREFIX, SUFFIX };
