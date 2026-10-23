'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { ROOT } = require('./helpers');

const ID = '123e4567-e89b-42d3-a456-426614174000';
const pageSource = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function makeClientHarness() {
  const store = new Map();
  const elements = new Map();
  const modal = { dataset: {}, listeners: [], addEventListener(type, handler) { this.listeners.push({ type, handler }); }, contains() { return true; } };
  elements.set('recipe-modal', modal);
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, { id, checked: false, disabled: false, value: '', textContent: '', style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {} });
    return elements.get(id);
  };
  let fetchCalls = [];
  const context = {
    localStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) },
    document: { getElementById: getElement, querySelectorAll: () => [] },
    navigator: { platform: 'Linux x86_64' },
    crypto: { randomUUID: () => ID, getRandomValues(bytes) { bytes.fill(1); return bytes; } },
    fetch: async (url, options) => { fetchCalls.push({ url, options }); return { ok: true }; },
    setTimeout: () => 1,
    clearTimeout() {},
    showToast() {},
    console,
  };
  const start = pageSource.indexOf("const API='/api';");
  const end = pageSource.indexOf('function openModal');
  const source = `${pageSource.slice(start, end)}\nglobalThis.__client={telemetryState,sendTelemetry,sendDueTelemetry,setTelemetryEnabled,setTelemetryUsageEnabled,setTelemetryCountryEnabled,enableAllTelemetry,enableAllTelemetryFromPrivacy,disableAllTelemetryFromPrivacy,renderTelemetrySettings,rejectAllTelemetry,customiseTelemetry,maybeShowTelemetryPrompt,platformFamily,setupTelemetryClickTracking,saveDataNow};`;
  vm.runInNewContext(source, context);
  return { context, store, modal, fetchCalls, client: context.__client };
}
test('frontend migration, revocation, unavailable telemetry and platform mapping are safe', async () => {
  const harness = makeClientHarness();
  harness.store.set('kitchen_loop_telemetry_v1', JSON.stringify({ enabled: true, installationId: ID, installSent: true }));
  assert.equal(harness.client.telemetryState().usageEnabled, false);
  assert.equal(harness.client.telemetryState().consentVersion, 1);
  assert.equal(harness.client.telemetryState().countryEnabled, false);
  assert.equal(await harness.client.sendTelemetry('recipe_created'), false);
  harness.store.set('kitchen_loop_telemetry_v2', JSON.stringify({ enabled: false, usageEnabled: false, consentVersion: 2, installationId: ID }));
  assert.equal(await harness.client.sendTelemetry('social_clicked'), false);
  harness.context.navigator.platform = 'Win32';
  assert.equal(harness.client.platformFamily(), 'windows');
  harness.context.navigator.platform = 'MacIntel';
  assert.equal(harness.client.platformFamily(), 'macos');
  harness.context.navigator.platform = 'Linux x86_64';
  assert.equal(harness.client.platformFamily(), 'linux');
});

test('consent prompt enable-all grants all three current permissions without changing schemas', async () => {
  const harness = makeClientHarness();
  assert.match(pageSource, /Enable all anonymous insights/);
  assert.match(pageSource, /onclick="rejectAllTelemetry\(\)"/);
  assert.match(pageSource, /onclick="customiseTelemetry\(\)"/);
  assert.match(pageSource, /Adoption:/);
  assert.match(pageSource, /Product usage:/);
  assert.match(pageSource, /Approximate country:/);
  await harness.client.enableAllTelemetry();
  const state = JSON.parse(harness.store.get('kitchen_loop_telemetry_v2'));
  assert.equal(state.enabled, true);
  assert.equal(state.usageEnabled, true);
  assert.equal(state.countryEnabled, true);
  assert.equal(state.consentVersion, 2);
  assert.equal(state.countryConsentVersion, 3);
  assert.equal(JSON.parse(harness.fetchCalls[0].options.body).telemetry_schema, 3);
  assert.equal(JSON.parse(harness.fetchCalls[0].options.body).country_consent_version, 3);
});

test('consent prompt no-thanks rejects all permissions and customise leaves them off', async () => {
  const rejected = makeClientHarness();
  await rejected.client.rejectAllTelemetry();
  assert.equal(rejected.client.telemetryState().enabled, false);
  assert.equal(rejected.client.telemetryState().usageEnabled, false);
  assert.equal(rejected.client.telemetryState().countryEnabled, false);
  assert.equal(rejected.fetchCalls.length, 0);

  const customised = makeClientHarness();
  customised.client.customiseTelemetry();
  assert.equal(customised.client.telemetryState().enabled, false);
  assert.equal(customised.client.telemetryState().usageEnabled, false);
  assert.equal(customised.client.telemetryState().countryEnabled, false);
  assert.equal(JSON.parse(customised.store.get('kitchen_loop_telemetry_prompt_v2')).decision, 'customised');
});

test('withdrawal disables all permissions without changing consent schemas', async () => {
  const harness = makeClientHarness();
  harness.store.set('kitchen_loop_telemetry_v2', JSON.stringify({ enabled: true, usageEnabled: true, countryEnabled: true, consentVersion: 2, countryConsentVersion: 3, installationId: ID, installSent: true }));
  await harness.client.setTelemetryEnabled(false);
  const state = harness.client.telemetryState();
  assert.equal(state.enabled, false);
  assert.equal(state.usageEnabled, false);
  assert.equal(state.countryEnabled, false);
  assert.equal(state.consentVersion, 2);
  assert.equal(state.countryConsentVersion, 3);
  assert.equal(await harness.client.sendTelemetry('recipe_created'), false);
});

test('privacy page offers all/disable actions and keeps individual permissions accurate', async () => {
  assert.match(pageSource, /onclick="enableAllTelemetryFromPrivacy\(\)"/);
  assert.match(pageSource, /onclick="disableAllTelemetryFromPrivacy\(\)"/);
  assert.match(pageSource, /<summary>Customise individual settings<\/summary>/);
  assert.match(pageSource, /id="telemetry-opt-in"/);
  assert.match(pageSource, /id="telemetry-usage-opt-in"/);
  assert.match(pageSource, /id="telemetry-country-opt-in"/);

  const harness = makeClientHarness();
  harness.store.set('kitchen_loop_telemetry_v2', JSON.stringify({ enabled: true, usageEnabled: false, countryEnabled: true, consentVersion: 2, countryConsentVersion: 3, installationId: ID }));
  harness.client.renderTelemetrySettings();
  assert.equal(harness.context.document.getElementById('telemetry-opt-in').checked, true);
  assert.equal(harness.context.document.getElementById('telemetry-usage-opt-in').checked, false);
  assert.equal(harness.context.document.getElementById('telemetry-country-opt-in').checked, true);

  await harness.client.enableAllTelemetryFromPrivacy();
  let state = harness.client.telemetryState();
  assert.equal(state.enabled, true);
  assert.equal(state.usageEnabled, true);
  assert.equal(state.countryEnabled, true);
  await harness.client.disableAllTelemetryFromPrivacy();
  state = harness.client.telemetryState();
  assert.equal(state.enabled, false);
  assert.equal(state.usageEnabled, false);
  assert.equal(state.countryEnabled, false);
});

test('country consent is renewed explicitly and remains independent of usage consent', async () => {
  const harness = makeClientHarness();
  harness.store.set('kitchen_loop_telemetry_v2', JSON.stringify({ enabled: true, usageEnabled: true, consentVersion: 2, installationId: ID, installSent: true }));
  assert.equal(harness.client.telemetryState().countryEnabled, false);
  harness.client.setTelemetryCountryEnabled(true);
  await new Promise((resolve) => setImmediate(resolve));
  const state = JSON.parse(harness.store.get('kitchen_loop_telemetry_v2'));
  assert.equal(state.countryEnabled, true);
  assert.equal(state.countryConsentVersion, 3);
  assert.equal(state.usageEnabled, true);
  const sent = JSON.parse(harness.fetchCalls[0].options.body);
  assert.equal(sent.country_consent_version, 3);
  assert.equal(sent.telemetry_schema, 3);
  assert.equal(state.lastHeartbeatMonth, new Date().toISOString().slice(0,7));
});

test('country consent renewal records a successful first install locally', async () => {
  const harness = makeClientHarness();
  harness.store.set('kitchen_loop_telemetry_v2', JSON.stringify({ enabled: true, usageEnabled: false, consentVersion: 2, installationId: ID, installSent: false }));
  harness.client.setTelemetryCountryEnabled(true);
  await new Promise((resolve) => setImmediate(resolve));
  const state = JSON.parse(harness.store.get('kitchen_loop_telemetry_v2'));
  assert.equal(state.installSent, true);
  assert.equal(JSON.parse(harness.fetchCalls[0].options.body).event, 'install');
});

test('enabling adoption telemetry after install does not mark a heartbeat month', async () => {
  const harness = makeClientHarness();
  harness.store.set('kitchen_loop_telemetry_v2', JSON.stringify({ enabled: true, usageEnabled: false, consentVersion: 2, installationId: ID, installSent: false }));
  await harness.client.setTelemetryEnabled(true);
  const state = JSON.parse(harness.store.get('kitchen_loop_telemetry_v2'));
  assert.equal(state.installSent, true);
  assert.equal(state.lastHeartbeatMonth, undefined);
});

test('frontend failed saves return false and click tracking is delegated once', async () => {
  const harness = makeClientHarness();
  harness.context.fetch = async () => { throw new Error('offline'); };
  assert.equal(await harness.client.saveDataNow([]), false);
  assert.ok(pageSource.indexOf('const ok=await saveDataNow(candidate);') < pageSource.indexOf("void sendTelemetry('recipe_created')"));
  assert.ok(pageSource.indexOf('if(ok){ recipes=candidate;') < pageSource.indexOf("void sendTelemetry('recipe_updated')"));

  harness.store.set('kitchen_loop_telemetry_v2', JSON.stringify({ enabled: true, usageEnabled: true, consentVersion: 2, installationId: ID }));
  harness.context.fetch = async (url, options) => { harness.fetchCalls.push({ url, options }); return { ok: true }; };
  harness.client.setupTelemetryClickTracking();
  harness.client.setupTelemetryClickTracking();
  const link = { href: 'https://example.test/recipe', closest: () => link };
  harness.modal.listeners[0].handler({ target: { closest: () => link } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.fetchCalls.length, 1);
  const sent = JSON.parse(harness.fetchCalls[0].options.body);
  assert.deepEqual(Object.keys(sent).sort(), ['app_version', 'event', 'installation_id', 'platform', 'telemetry_schema']);
});
