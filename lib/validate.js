'use strict';

// Request-body validation. Every value that reaches the data file passes through here and
// comes out as a freshly built object containing only known fields, so unknown keys,
// prototype-polluting keys and oversized values never get persisted.

const LIMITS = Object.freeze({
  recipes: 5000,
  name: 200,
  tags: 200,
  ingredients: 5000,
  notes: 10000,
  pairsWith: 1000,
  link: 2048,
  cookDates: 10000,
  planItems: 100,
  planHistory: 1000,
  historyEntries: 200,
  day: 20,
  savedAt: 60,
  checkedKeys: 5000,
  checkedKeyLength: 500,
});

const PLAN_TYPES = new Set(['dinner', 'lunch', 'dessert']);
// Marks recipes published by The Kitchen Loop. Only the seed data (or a restored backup)
// sets it; the API ignores it from clients — see lib/app.js.
const ORIGINS = new Set(['kitchen-loop']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// String ids are interpolated into inline onclick handlers by the frontend, so they are
// restricted to characters that can never break out of a quoted JS string or attribute.
const STRING_ID = /^[A-Za-z0-9_-]{1,64}$/;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function fail(path, message) {
  throw new ValidationError(`${path}: ${message}`);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function expectObject(v, path) {
  if (!isPlainObject(v)) fail(path, 'expected an object');
  return v;
}

function expectArray(v, path, max) {
  if (!Array.isArray(v)) fail(path, 'expected an array');
  if (v.length > max) fail(path, `too many items (max ${max})`);
  return v;
}

function str(v, path, max, { required = false, fallback = '' } = {}) {
  if (v === undefined || v === null) {
    if (required) fail(path, 'is required');
    return fallback;
  }
  if (typeof v !== 'string') fail(path, 'expected a string');
  if (v.length > max) fail(path, `too long (max ${max} characters)`);
  if (required && !v.trim()) fail(path, 'must not be empty');
  return v;
}

function bool(v, path) {
  if (v === undefined) return false;
  if (typeof v !== 'boolean') fail(path, 'expected a boolean');
  return v;
}

function recipeId(v, path) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && STRING_ID.test(v)) return v;
  fail(path, 'expected a non-negative integer or a short [A-Za-z0-9_-] string');
}

function optionalRecipeId(v, path) {
  return v === undefined || v === null ? null : recipeId(v, path);
}

function isoDate(v, path) {
  if (typeof v !== 'string' || v.length > 40 || Number.isNaN(Date.parse(v))) {
    fail(path, 'expected an ISO date string');
  }
  return v;
}

function optionalIsoDate(v, path) {
  return v === undefined || v === null ? null : isoDate(v, path);
}

// Links are rendered as <a href>, so only http(s) URLs are accepted — this is what stops a
// stored `javascript:` URL from becoming a click-to-run script.
function link(v, path) {
  const s = str(v, path, LIMITS.link).trim();
  if (!s) return '';
  let url;
  try { url = new URL(s); } catch { fail(path, 'expected an http(s) URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail(path, 'expected an http(s) URL');
  return s;
}

function validateRecipe(r, path) {
  expectObject(r, path);
  const cookDates = r.cookDates === undefined ? [] : expectArray(r.cookDates, `${path}.cookDates`, LIMITS.cookDates);
  const recipe = {
    id: recipeId(r.id, `${path}.id`),
    name: str(r.name, `${path}.name`, LIMITS.name, { required: true }).trim(),
    tags: str(r.tags, `${path}.tags`, LIMITS.tags),
    ingredients: str(r.ingredients, `${path}.ingredients`, LIMITS.ingredients, { required: true }),
    notes: str(r.notes, `${path}.notes`, LIMITS.notes),
    instagramLink: link(r.instagramLink, `${path}.instagramLink`),
    tiktokLink: link(r.tiktokLink, `${path}.tiktokLink`),
    threadsLink: link(r.threadsLink, `${path}.threadsLink`),
    pairsWith: str(r.pairsWith, `${path}.pairsWith`, LIMITS.pairsWith),
    cookDates: cookDates.map((d, i) => isoDate(d, `${path}.cookDates[${i}]`)),
  };
  if (r.addedDate !== undefined) recipe.addedDate = isoDate(r.addedDate, `${path}.addedDate`);
  if (r.origin !== undefined) {
    if (!ORIGINS.has(r.origin)) fail(`${path}.origin`, 'unknown origin');
    recipe.origin = r.origin;
  }
  return recipe;
}

function validateRecipes(list, path = 'recipes') {
  expectArray(list, path, LIMITS.recipes);
  const seen = new Set();
  return list.map((r, i) => {
    const recipe = validateRecipe(r, `${path}[${i}]`);
    const key = `${typeof recipe.id}:${recipe.id}`;
    if (seen.has(key)) fail(`${path}[${i}].id`, 'duplicate recipe id');
    seen.add(key);
    return recipe;
  });
}

function validatePlanItem(p, path) {
  expectObject(p, path);
  if (!PLAN_TYPES.has(p.type)) fail(`${path}.type`, 'expected dinner, lunch or dessert');
  if (p.week !== 1 && p.week !== 2) fail(`${path}.week`, 'expected 1 or 2');
  return {
    type: p.type,
    week: p.week,
    day: str(p.day, `${path}.day`, LIMITS.day),
    recipeId: optionalRecipeId(p.recipeId, `${path}.recipeId`),
    recipeName: str(p.recipeName, `${path}.recipeName`, LIMITS.name),
    sideId: optionalRecipeId(p.sideId, `${path}.sideId`),
    sideName: p.sideName === undefined || p.sideName === null ? null : str(p.sideName, `${path}.sideName`, LIMITS.name),
    cooked: bool(p.cooked, `${path}.cooked`),
    cookedDate: optionalIsoDate(p.cookedDate, `${path}.cookedDate`),
  };
}

function validatePlan(list, path = 'plan') {
  return expectArray(list, path, LIMITS.planItems).map((p, i) => validatePlanItem(p, `${path}[${i}]`));
}

function validateCustomHistoryEntry(e, path) {
  expectObject(e, path);
  return {
    recipeId: optionalRecipeId(e.recipeId, `${path}.recipeId`),
    recipeName: str(e.recipeName, `${path}.recipeName`, LIMITS.name),
  };
}

function validatePlanHistory(list, path = 'planHistory') {
  return expectArray(list, path, LIMITS.planHistory).map((h, i) => {
    const p = `${path}[${i}]`;
    expectObject(h, p);
    const savedAt = str(h.savedAt, `${p}.savedAt`, LIMITS.savedAt);
    const entries = expectArray(h.entries, `${p}.entries`, LIMITS.historyEntries);
    if (h.type === 'custom') {
      return { type: 'custom', savedAt, entries: entries.map((e, j) => validateCustomHistoryEntry(e, `${p}.entries[${j}]`)) };
    }
    if (h.type !== undefined) fail(`${p}.type`, 'unknown history type');
    return { savedAt, entries: entries.map((e, j) => validatePlanItem(e, `${p}.entries[${j}]`)) };
  });
}

// Shopping ticks are keyed by ingredient text. Built on a null-prototype object so a
// "__proto__" key can never reach Object.prototype, and such keys are rejected outright.
function validateChecked(obj, path = 'shoppingChecked') {
  expectObject(obj, path);
  const keys = Object.keys(obj);
  if (keys.length > LIMITS.checkedKeys) fail(path, `too many items (max ${LIMITS.checkedKeys})`);
  const out = Object.create(null);
  for (const k of keys) {
    if (FORBIDDEN_KEYS.has(k)) fail(path, `forbidden key "${k}"`);
    if (k.length > LIMITS.checkedKeyLength) fail(path, 'key too long');
    if (typeof obj[k] !== 'boolean') fail(`${path}["${k}"]`, 'expected a boolean');
    if (obj[k]) out[k] = true;
  }
  return out;
}

function validateCustomListUpdate(body) {
  expectObject(body, 'body');
  const recipeIds = expectArray(body.recipeIds, 'recipeIds', LIMITS.recipes)
    .map((id, i) => recipeId(id, `recipeIds[${i}]`));
  const update = { recipeIds: [...new Set(recipeIds)] };
  if (body.shoppingChecked !== undefined) update.shoppingChecked = validateChecked(body.shoppingChecked, 'shoppingChecked');
  return update;
}

// PUT /api/data accepts any subset of the household fields; absent fields are left as-is.
function validateDataUpdate(body) {
  expectObject(body, 'body');
  const allowed = new Set(['recipes', 'plan', 'planHistory', 'shoppingChecked']);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) fail(k, 'unknown field');
  }
  const update = {};
  if (body.recipes !== undefined) update.recipes = validateRecipes(body.recipes);
  if (body.plan !== undefined) update.plan = validatePlan(body.plan);
  if (body.planHistory !== undefined) update.planHistory = validatePlanHistory(body.planHistory);
  if (body.shoppingChecked !== undefined) update.shoppingChecked = validateChecked(body.shoppingChecked);
  return update;
}

function validateChangelogSeen(body) {
  expectObject(body, 'body');
  if (!Number.isSafeInteger(body.version) || body.version < 0) fail('version', 'expected a non-negative integer');
  return body.version;
}

module.exports = {
  LIMITS,
  ValidationError,
  validateRecipes,
  validatePlan,
  validatePlanHistory,
  validateChecked,
  validateCustomListUpdate,
  validateDataUpdate,
  validateChangelogSeen,
};
