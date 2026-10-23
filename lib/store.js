'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  validateRecipes, validatePlan, validatePlanHistory, validateChecked, validateCustomListUpdate,
} = require('./validate');

const SCHEMA_VERSION = 1;

class StoreError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'StoreError';
  }
}

function emptyCustomList() {
  return { recipeIds: [], shoppingChecked: {}, createdAt: null };
}

function newDocument(recipes) {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    createdAt: new Date().toISOString(),
    recipes,
    plan: [],
    planHistory: [],
    shoppingChecked: {},
    customList: emptyCustomList(),
    lastSeenChangelogVersion: 0,
  };
}

// Upgrades an older document in place to SCHEMA_VERSION. Each future schema change adds a
// step here (`if (doc.schemaVersion === 1) { ...; doc.schemaVersion = 2; }`) and the
// pre-migration file is kept as a timestamped backup by load().
function migrate(doc) {
  if (!Number.isInteger(doc.schemaVersion) || doc.schemaVersion < 1) {
    throw new StoreError(`Unrecognised schemaVersion: ${JSON.stringify(doc.schemaVersion)}`);
  }
  if (doc.schemaVersion > SCHEMA_VERSION) {
    throw new StoreError(
      `Data file has schemaVersion ${doc.schemaVersion}, but this version of The Kitchen Loop only ` +
      `understands up to ${SCHEMA_VERSION}. Upgrade the application instead of downgrading it.`,
    );
  }
  return doc;
}

// Re-validates a whole document read from disk or from a backup, so a hand-edited or
// partially corrupt file is caught rather than surfacing later as a broken page.
//
// Provenance: the "kitchen-loop" origin marker is only honoured on the canonical ids of the
// recipes that ship marked in the seed file (`officialIds`). Anywhere else it is dropped, so
// a crafted backup or hand-edited file cannot give an arbitrary recipe the Original badge.
// `removedOrigins` reports how many markers were dropped.
function normaliseDocument(doc, officialIds = new Set()) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new StoreError('Data file is not a JSON object');
  migrate(doc);
  const customList = doc.customList ? validateCustomListUpdate(doc.customList) : emptyCustomList();
  let removedOrigins = 0;
  const recipes = validateRecipes(doc.recipes ?? []).map((r) => {
    if (r.origin === undefined || (typeof r.id === 'string' && officialIds.has(r.id))) return r;
    removedOrigins++;
    const { origin, ...rest } = r;
    return rest;
  });
  return { removedOrigins, doc: {
    schemaVersion: SCHEMA_VERSION,
    revision: Number.isSafeInteger(doc.revision) && doc.revision > 0 ? doc.revision : 1,
    createdAt: typeof doc.createdAt === 'string' ? doc.createdAt : new Date().toISOString(),
    recipes,
    plan: validatePlan(doc.plan ?? []),
    planHistory: validatePlanHistory(doc.planHistory ?? []),
    shoppingChecked: validateChecked(doc.shoppingChecked ?? {}),
    customList: {
      recipeIds: customList.recipeIds,
      shoppingChecked: customList.shoppingChecked ?? {},
      createdAt: typeof doc.customList?.createdAt === 'string' ? doc.customList.createdAt : null,
    },
    lastSeenChangelogVersion: Number.isSafeInteger(doc.lastSeenChangelogVersion) ? doc.lastSeenChangelogVersion : 0,
  } };
}

// Single-household JSON document store.
//
// - The in-memory document is the source of truth for reads.
// - Every mutation goes through update(), which runs mutations strictly one at a time on a
//   promise queue, so two overlapping requests can never read-modify-write the same state.
// - Every successful update increments `revision`, which clients quote back on their next
//   write so that a save based on stale data is refused instead of silently overwriting.
// - Each write goes to a temp file, is fsynced, then renamed over the real file, so a crash
//   or power cut leaves either the old or the new file — never a half-written one.
// - The previous version is kept alongside as `<file>.bak`, but only ever replaced by a
//   version that is itself valid: damaged data can never overwrite the last good backup.
class Store {
  constructor({ dataDir, seedFile, lock = null }) {
    this.dataDir = dataDir;
    this.seedFile = seedFile;
    // DataDirLock held by this process (see lib/lock.js). Ownership cannot change while
    // this process is alive; before each write the store also confirms the lock file has
    // not been deleted by hand, as a secondary safeguard.
    this.lock = lock;
    this.file = path.join(dataDir, 'kitchen-loop.json');
    this.backupFile = `${this.file}.bak`;
    this._doc = null;
    this._queue = Promise.resolve();
    this._officialIdsCache = null;
  }

  // Canonical ids of The Kitchen Loop Originals: the recipes marked in the shipped seed file.
  // The seed is part of the application, not user data, so it is the trusted source.
  async _officialIds() {
    if (!this._officialIdsCache) {
      const ids = new Set();
      if (this.seedFile) {
        const seed = JSON.parse(await fs.readFile(this.seedFile, 'utf8'));
        for (const r of seed.recipes || []) if (r.origin === 'kitchen-loop' && typeof r.id === 'string') ids.add(r.id);
      }
      this._officialIdsCache = ids;
    }
    return this._officialIdsCache;
  }

  async _normalise(parsed) {
    return normaliseDocument(parsed, await this._officialIds());
  }

  async _exists(file) {
    try { await fs.access(file); return true; } catch { return false; }
  }

  async load() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await this._removeStaleTempFiles();
    let raw;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      // A missing data file next to a backup means data was lost or moved, not a new
      // installation. Starting with sample recipes here would hide that, and the next save
      // would put the sample data where the backup is — so refuse and explain instead.
      if (await this._exists(this.backupFile)) {
        throw new StoreError(
          `${this.file} is missing, but a backup exists at ${this.backupFile}. Nothing was changed. ` +
          'Restore it (see README, "Backup and restore"), or move the backup aside to start again with the sample recipes.',
        );
      }
      this._doc = newDocument(await this._readSeed());
      await this._writeAtomic(this._doc);
      return { created: true };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new StoreError(
        `${this.file} is not valid JSON (${e.message}). It has not been modified. ` +
        `Restore it from ${path.basename(this.backupFile)} or move it aside to start fresh.`,
        { cause: e },
      );
    }
    const fromVersion = parsed && parsed.schemaVersion;
    try {
      this._doc = (await this._normalise(parsed)).doc;
    } catch (e) {
      if (e instanceof StoreError) throw e;
      throw new StoreError(`${this.file} failed validation: ${e.message}. It has not been modified.`, { cause: e });
    }
    if (fromVersion !== SCHEMA_VERSION) {
      await fs.copyFile(this.file, `${this.file}.v${fromVersion}-${Date.now()}.bak`);
      await this._writeAtomic(this._doc);
    }
    return { created: false };
  }

  // Replaces the whole document with a backup (as produced by `node server.js backup`).
  //
  // - The backup is parsed and fully validated before anything on disk is touched; a damaged
  //   or wrong file is refused and nothing changes.
  // - Works when the current data file is unreadable — that is the recovery case. A damaged
  //   current file is first kept aside as `<file>.damaged-<time>` (never overwriting
  //   anything), and it is never rotated into `.bak`, so the last good backup survives.
  // - The new data is installed with the same atomic write as every save; if any step fails,
  //   the live file is left exactly as it was.
  // - Origin markers on non-canonical ids are dropped (see normaliseDocument).
  // - The revision moves past both versions so any open browser tab is told to reload.
  async restore(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new StoreError(`Backup is not valid JSON (${e.message}). Nothing was changed.`, { cause: e });
    }
    let doc;
    let removedOrigins;
    try {
      ({ doc, removedOrigins } = await this._normalise(parsed));
    } catch (e) {
      if (e instanceof StoreError) throw new StoreError(`${e.message} Nothing was changed.`, { cause: e });
      throw new StoreError(`Backup failed validation: ${e.message}. Nothing was changed.`, { cause: e });
    }
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    let currentRevision = 0;
    let damagedCopy = null;
    let currentRaw = null;
    try {
      currentRaw = await fs.readFile(this.file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (this.lock) await this.lock.assertHeld();
    if (currentRaw !== null) {
      const current = await this._validDocument(currentRaw);
      if (current) {
        currentRevision = current.revision;
      } else {
        damagedCopy = `${this.file}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        await this._installFile(damagedCopy, currentRaw, { exclusive: true });
      }
    }
    doc.revision = Math.max(doc.revision, currentRevision) + 1;
    await this._writeAtomic(doc);
    this._doc = doc;
    return { recipes: doc.recipes.length, removedOrigins, damagedCopy };
  }

  // A crash between writing and renaming leaves a *.tmp file behind; the real file is
  // still intact, so the leftover is simply discarded.
  async _removeStaleTempFiles() {
    const prefix = `${path.basename(this.file)}.`;
    for (const name of await fs.readdir(this.dataDir)) {
      if (name.startsWith(prefix) && name.endsWith('.tmp')) await fs.rm(path.join(this.dataDir, name), { force: true });
    }
  }

  async _readSeed() {
    if (!this.seedFile) return [];
    const seed = JSON.parse(await fs.readFile(this.seedFile, 'utf8'));
    return validateRecipes(seed.recipes, 'seed.recipes');
  }

  // Reads and validates the data file without creating, migrating or writing anything, so
  // it is safe to use while a server is running (used by `node server.js backup`).
  async readFromDisk() {
    let raw;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') throw new StoreError(`No data file at ${this.file} yet — start the app once first.`, { cause: e });
      throw e;
    }
    try {
      return (await this._normalise(JSON.parse(raw))).doc;
    } catch (e) {
      if (e instanceof StoreError) throw e;
      throw new StoreError(`${this.file} could not be read: ${e.message}`, { cause: e });
    }
  }

  // Returns a deep copy so callers can never mutate the stored document by accident.
  read() {
    if (!this._doc) throw new StoreError('Store not loaded');
    return structuredClone(this._doc);
  }

  // Applies `mutator(draft)` to a copy of the document and persists it. The in-memory
  // document is only replaced after the write succeeds, so a failed write changes nothing.
  update(mutator) {
    const run = this._queue.then(async () => {
      const draft = structuredClone(this._doc);
      const result = await mutator(draft);
      draft.revision = this._doc.revision + 1;
      if (this.lock) await this.lock.assertHeld();
      await this._writeAtomic(draft);
      this._doc = draft;
      return result;
    });
    // Keep the queue alive after a failed mutation; the failure is still reported to the caller.
    this._queue = run.catch(() => {});
    return run;
  }

  // Resolves once every queued write has finished — used for graceful shutdown.
  drain() {
    return this._queue;
  }

  // Returns the normalised document if `raw` is a complete, valid data file, else null.
  async _validDocument(raw) {
    try {
      return (await this._normalise(JSON.parse(raw))).doc;
    } catch {
      return null;
    }
  }

  // Writes `text` to a new, fsynced temp file (mode 0600) next to `target`; returns its path.
  async _writeTemp(target, text) {
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const handle = await fs.open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return tmp;
  }

  // Puts `text` at `target` via a temp file and rename, so `target` is always either its old
  // or its new complete content. With `exclusive`, refuses to replace an existing `target`.
  async _installFile(target, text, { exclusive = false } = {}) {
    const tmp = await this._writeTemp(target, text);
    try {
      if (exclusive) {
        await fs.link(tmp, target); // fails with EEXIST instead of overwriting
        await fs.rm(tmp, { force: true });
      } else {
        await fs.rename(tmp, target);
      }
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    await fsyncDir(this.dataDir);
  }

  // Keeps the current data file as `.bak` before it is replaced — but only if it is a
  // complete, valid document. Damaged data never replaces the last good backup.
  async _rotateBackup() {
    let raw;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    if (await this._validDocument(raw)) await this._installFile(this.backupFile, raw);
  }

  async _writeAtomic(doc) {
    const tmp = await this._writeTemp(this.file, JSON.stringify(doc, null, 2) + '\n');
    try {
      await this._rotateBackup();
      await fs.rename(tmp, this.file);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    await fsyncDir(this.dataDir);
  }
}

// Persists the rename itself. Not supported on every platform/filesystem, so best effort.
async function fsyncDir(dir) {
  let handle;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    // ignore
  } finally {
    await handle?.close();
  }
}

module.exports = { Store, StoreError, SCHEMA_VERSION, emptyCustomList };
