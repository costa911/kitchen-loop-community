'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ValidationError, validateDataUpdate, validateCustomListUpdate, validateChangelogSeen } = require('./validate');
const { SCHEMA_VERSION, emptyCustomList } = require('./store');

const MAX_BODY_BYTES = 5 * 1024 * 1024;

// Hostnames the app answers to. Because there is no login, a request whose Host header is
// anything else is refused: this blocks DNS-rebinding attacks from web pages and keeps the
// app unusable from other machines even if the port is accidentally exposed.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    // The reused frontend relies on inline <script> and inline event handlers.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' https://kitchen-loop-telemetry.costa911.workers.dev",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Loads every file under publicDir into memory once at startup. Requests are then served
// by exact-path lookup only, which rules out path traversal entirely.
function loadStaticFiles(publicDir) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const type = CONTENT_TYPES[path.extname(entry.name).toLowerCase()];
      if (!type) continue;
      const urlPath = '/' + path.relative(publicDir, full).split(path.sep).join('/');
      files.set(urlPath, { body: fs.readFileSync(full), type });
    }
  };
  walk(publicDir);
  if (files.has('/index.html')) files.set('/', files.get('/index.html'));
  return files;
}

function hostnameOf(hostHeader) {
  if (!hostHeader) return null;
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:]+)(?::\d{1,5})?$/.exec(hostHeader);
  return m ? m[1].toLowerCase() : null;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_BODY_BYTES) {
      reject(new HttpError(413, 'Request body too large'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Malformed JSON');
  }
}

// Cross-site request forgery guard for state-changing requests. Browsers always send Origin
// on cross-origin POST/PUT, and a JSON Content-Type forces a CORS preflight that this server
// never approves — so a malicious page cannot write to the household's data.
function assertSameOriginWrite(req, hostHeader) {
  const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${hostHeader}`) throw new HttpError(403, 'Cross-origin request refused');
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-site request refused');
}

function householdView(doc) {
  return {
    schemaVersion: doc.schemaVersion,
    revision: doc.revision,
    recipes: doc.recipes,
    plan: doc.plan,
    planHistory: doc.planHistory,
    shoppingChecked: doc.shoppingChecked,
    customList: doc.customList,
    lastSeenChangelogVersion: doc.lastSeenChangelogVersion,
  };
}

// The origin marker is never taken from the client. Each saved recipe gets exactly the
// marker its stored counterpart (same id) already has, so editing an official recipe keeps
// it, and a new or user-created recipe can never acquire it.
function withStoredOrigins(doc, recipes) {
  const stored = new Map(doc.recipes.filter((r) => r.origin).map((r) => [`${typeof r.id}:${r.id}`, r.origin]));
  return recipes.map(({ origin, ...r }) => {
    const kept = stored.get(`${typeof r.id}:${r.id}`);
    return kept ? { ...r, origin: kept } : r;
  });
}

function resolveRecipeName(doc, id) {
  const r = doc.recipes.find((x) => x.id === id);
  return r ? r.name : 'Unknown recipe';
}

function createApp({ store, publicDir, logger = console }) {
  const staticFiles = loadStaticFiles(publicDir);

  // Every write quotes the revision it was based on. If anything else has been saved since
  // (another tab, another window), the write is refused with 409 rather than overwriting
  // newer data; the client then reloads. Mutations run inside store.update(), so the check
  // and the write happen atomically with respect to other requests.
  async function write(req, apply) {
    const body = await readJson(req);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('body: expected an object');
    const { baseRevision, ...rest } = body;
    if (!Number.isSafeInteger(baseRevision)) throw new ValidationError('baseRevision: expected an integer');
    const prepare = apply(rest);
    let result;
    let saved;
    await store.update(async (doc) => {
      if (doc.revision !== baseRevision) {
        throw new HttpError(409, 'Your data was changed in another tab or window. Reload to get the latest version.');
      }
      result = await prepare(doc);
      saved = doc;
    });
    // store.update() stamps the new revision onto the draft before writing it.
    return { ok: true, revision: saved.revision, ...result };
  }

  const routes = {
    'GET /api/health': async () => ({ ok: true, schemaVersion: SCHEMA_VERSION }),

    'GET /api/data': async () => householdView(store.read()),

    'PUT /api/data': (req) => write(req, (body) => {
      const update = validateDataUpdate(body);
      return (doc) => {
        if (update.recipes) update.recipes = withStoredOrigins(doc, update.recipes);
        Object.assign(doc, update);
      };
    }),

    'PUT /api/custom-list': (req) => write(req, (body) => {
      const update = validateCustomListUpdate(body);
      return (doc) => {
        const cl = doc.customList;
        cl.recipeIds = update.recipeIds;
        if (update.shoppingChecked) cl.shoppingChecked = update.shoppingChecked;
        cl.createdAt = cl.recipeIds.length ? (cl.createdAt || new Date().toISOString()) : null;
      };
    }),

    // Freezes the custom list into named history entries (so History still reads correctly
    // after a recipe is later renamed or deleted) and resets the list.
    'POST /api/custom-list/archive': (req) => write(req, () => (doc) => {
      if (!doc.customList.recipeIds.length) throw new HttpError(400, 'No active custom list to archive');
      const entry = {
        type: 'custom',
        savedAt: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
        entries: doc.customList.recipeIds.map((id) => ({ recipeId: id, recipeName: resolveRecipeName(doc, id) })),
      };
      doc.planHistory.unshift(entry);
      doc.customList = emptyCustomList();
      return { entry };
    }),

    'POST /api/custom-list/clear': (req) => write(req, () => (doc) => { doc.customList = emptyCustomList(); }),

    'PUT /api/changelog-seen': (req) => write(req, (body) => {
      const version = validateChangelogSeen(body);
      // Max, not overwrite: a stale tab must never resurrect an already-dismissed popup.
      return (doc) => { doc.lastSeenChangelogVersion = Math.max(doc.lastSeenChangelogVersion, version); };
    }),
  };

  return async function handle(req, res) {
    try {
      const hostHeader = req.headers.host;
      if (!LOOPBACK_HOSTS.has(hostnameOf(hostHeader))) {
        throw new HttpError(421, 'This app only accepts requests addressed to localhost');
      }

      const { pathname } = new URL(req.url, 'http://localhost');

      if (pathname.startsWith('/api/')) {
        const handler = routes[`${req.method} ${pathname}`];
        if (!handler) {
          const known = Object.keys(routes).some((k) => k.endsWith(` ${pathname}`));
          throw new HttpError(known ? 405 : 404, known ? 'Method not allowed' : 'Not found');
        }
        if (req.method !== 'GET') assertSameOriginWrite(req, hostHeader);
        sendJson(res, 200, await handler(req));
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      const file = staticFiles.get(pathname);
      if (!file) throw new HttpError(404, 'Not found');
      send(res, 200, req.method === 'HEAD' ? undefined : file.body, {
        'Content-Type': file.type,
        'Content-Length': file.body.length,
        'Cache-Control': 'no-cache',
      });
    } catch (e) {
      // If the request was refused before its body was read, Node will close the socket
      // after responding; say so explicitly so keep-alive clients don't reuse it.
      const extra = req.complete ? {} : { Connection: 'close' };
      req.resume();
      if (e instanceof ValidationError) return sendJson(res, 400, { error: e.message }, extra);
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message }, extra);
      if (e && e.name === 'LockError') {
        logger.error(e.message);
        return sendJson(res, 503, { error: e.message }, extra);
      }
      logger.error('Unhandled error:', e);
      sendJson(res, 500, { error: 'Internal server error' }, extra);
    }
  };
}

module.exports = { createApp, MAX_BODY_BYTES, hostnameOf };
