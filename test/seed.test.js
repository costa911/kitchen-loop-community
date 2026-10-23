'use strict';

// Content checks for the first-run recipes in seed/sample-recipes.json.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SEED, tempDir, startServer, request } = require('./helpers');

// The 15 recipes published by The Kitchen Loop, as named by their author.
const PUBLISHED = [
  'Lasagna', 'Sausage & Peas Pasta', "Daddy's Tzatziki", 'Coconut Daal', 'Mac & Cheese',
  "Grandpa's Hilton Courgette Cold Salad", 'Greek Yogurt ? = Dressing', 'Chicken Mince Wraps',
  'Aubergine Katsu Curry', 'Tahini Lampuki', 'Whipped Feta Dip', 'Pasta Aurora', 'Chicken Laksa',
  "Bean 'n' Egg Salad", 'Chorizo, Leek & Potato Soup',
];

const official = SEED.filter((r) => r.origin === 'kitchen-loop');
const invented = SEED.filter((r) => r.origin === undefined);
const tags = (r) => r.tags.split(',').map((t) => t.trim());
const isMain = (r) => !tags(r).some((t) => ['Dessert', 'Side', 'Dressing'].includes(t));

test('exactly the 15 published recipes carry the Kitchen Loop marker', () => {
  assert.deepEqual(official.map((r) => r.name), PUBLISHED);
  assert.ok(SEED.every((r) => r.origin === undefined || r.origin === 'kitchen-loop'));
});

test('each published recipe links to its post on TikTok, Instagram and Threads', () => {
  const patterns = {
    tiktokLink: /^https:\/\/www\.tiktok\.com\/@the_kitchen_loop\/photo\/\d{19}$/,
    instagramLink: /^https:\/\/www\.instagram\.com\/p\/[A-Za-z0-9_-]{11}\/$/,
    threadsLink: /^https:\/\/www\.threads\.com\/share\/[A-Za-z0-9_-]{9,12}\/$/,
  };
  for (const [field, re] of Object.entries(patterns)) {
    const urls = official.map((r) => r[field]);
    for (const [i, u] of urls.entries()) assert.match(u, re, `${official[i].name} ${field}`);
    assert.equal(new Set(urls).size, urls.length, `${field} values must be unique`);
  }
});

test('no link carries share-tracking parameters, fragments or non-https schemes', () => {
  for (const r of SEED) {
    for (const field of ['tiktokLink', 'instagramLink', 'threadsLink']) {
      if (!r[field]) continue;
      const u = new URL(r[field]);
      assert.equal(u.protocol, 'https:', `${r.name} ${field}`);
      assert.equal(u.search, '', `${r.name} ${field} has a query string`);
      assert.equal(u.hash, '', `${r.name} ${field} has a fragment`);
    }
  }
});

test('published recipes keep their method on social media; none is reproduced here', () => {
  for (const r of official) {
    assert.equal(r.notes, '', `${r.name} must not contain method text`);
    assert.ok(r.ingredients.split(',').length >= 3, `${r.name} keeps its ingredient list`);
  }
});

test('invented samples have full written methods and no social links', () => {
  assert.ok(invented.length >= 1);
  for (const r of invented) {
    assert.match(r.notes, /^Method/, r.name);
    assert.ok(r.notes.split('\n').filter((l) => /^\d+\. /.test(l)).length >= 5, `${r.name} has numbered steps`);
    assert.ok(!r.tiktokLink && !r.instagramLink && !r.threadsLink, r.name);
  }
});

test('a fresh install can plan 14 different dinners', () => {
  const mains = SEED.filter(isMain);
  assert.equal(mains.length, 14);
  assert.equal(new Set(mains.map((r) => r.name)).size, 14);
});

test('ids are unique and do not reuse production identifiers', () => {
  const ids = SEED.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(String(id), /^(tkl|sample)-[a-z0-9-]+$/);
});

test('an existing installation is never re-seeded or changed by new first-run data', async () => {
  const dir = tempDir();
  const mine = { schemaVersion: 1, revision: 7, recipes: [{ id: 'sample-02', name: 'Weeknight Beef Chilli', tags: 'Dinner', ingredients: 'Beef Mince, Onion', cookDates: ['2026-09-01T18:00:00.000Z'] }] };
  const file = path.join(dir, 'kitchen-loop.json');
  fs.writeFileSync(file, JSON.stringify(mine));
  const app = await startServer(dir);
  try {
    const d = (await request(app.port, { path: '/api/data' })).json;
    assert.deepEqual(d.recipes.map((r) => r.name), ['Weeknight Beef Chilli']);
    assert.equal(d.revision, 7);
    assert.ok(!d.recipes.some((r) => r.origin));
  } finally {
    await app.stop();
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), mine, 'file must be untouched by startup');
});
