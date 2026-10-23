'use strict';

// Guards the public repository contents: only expected application files are tracked, and
// nothing refers to the private telemetry backend, its storage or its credentials.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT } = require('./helpers');

const ALLOWED = [
  /^\.dockerignore$/, /^\.gitignore$/, /^Dockerfile$/, /^LICENSE$/, /^README\.md$/, /^TESTING\.md$/, /^compose\.yaml$/,
  /^package\.json$/, /^server\.js$/,
  /^lib\/[a-z-]+\.js$/,
  /^public\/index\.html$/, /^public\/thekitchenloop\.png$/, /^public\/kitchen-loop-original\.png$/,
  /^public\/fonts\/OFL\.txt$/, /^public\/fonts\/dm-sans-latin(-ext)?-[456]00-normal\.woff2$/,
  /^seed\/sample-recipes\.json$/,
  /^scripts\/[a-z0-9-]+\.(sh|mjs)$/,
  /^docs\/[a-z0-9-]+\.md$/,
  /^test\/[a-z-]+(\.test)?\.js$/,
];

// References that must never appear: private APIs, data stores, credentials and
// unrelated third-party services. The public client-side telemetry endpoint is allowed,
// but backend implementation and private deployment material are not.
const FORBIDDEN = [
  /kitchen-loop-(api|data|worker)\b/i,
  /x-passphrase|tkl_passphrase|passphrase/i,
  /github_token|heartbeat_kv|account_id/i,
  /wrangler\.jsonc?|country_metrics|daily_usage_metrics|request\.cf|ADMIN_TOKEN|ID_SALT/i,
  /api\.github\.com/i,
  /fonts\.(googleapis|gstatic)\.com/i,
  /BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_/,
];

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

test('only allowlisted files are tracked', (t) => {
  const files = trackedFiles();
  if (!files) return t.skip('not a git checkout');
  const unexpected = files.filter((f) => !ALLOWED.some((re) => re.test(f)));
  assert.deepEqual(unexpected, []);
});

test('the public tree contains no private telemetry backend paths', (t) => {
  const files = trackedFiles();
  if (!files) return t.skip('not a git checkout');
  assert.equal(files.some((f) => f === 'telemetry' || f.startsWith('telemetry/')), false);
});

test('no references to private credentials or unrelated external services', (t) => {
  const files = trackedFiles();
  if (!files) return t.skip('not a git checkout');
  const self = path.relative(ROOT, __filename);
  const hits = [];
  for (const f of files) {
    if (f === self || /\.(png|woff2)$/.test(f)) continue;
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const re of FORBIDDEN) {
      const m = text.match(re);
      if (m) hits.push(`${f}: ${m[0]}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('the page loads nothing from other origins', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const external = [...html.matchAll(/\b(?:src|href)\s*=\s*["']?(https?:)?\/\//gi)].map((m) => m[0]);
  assert.deepEqual(external, []);
  assert.doesNotMatch(html, /@import|url\(\s*["']?https?:/i);
  assert.match(html, /const API='\/api';/);
  assert.match(html, /const TELEMETRY_ENDPOINT = 'https:\/\/kitchen-loop-telemetry\.costa911\.workers\.dev';/);
  assert.match(html, /TELEMETRY_ENDPOINT}\/v1\/events/);
});
