const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
let server;
let baseUrl;

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

test('real Chromium IndexedDB abort restores the last durable snapshot and blocks cloud sync', { timeout: 120000 }, async () => {
  server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); }
    catch { res.writeHead(400).end('Bad request'); return; }
    const file = path.resolve(root, '.' + pathname);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end('Forbidden'); return;
    }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404).end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': contentType(file), 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(() => {
      // Isolated test origin only; no real device identity or credentials.
      localStorage.setItem('holoo_textile_import_erp_v2_device_actor_v1', 'mehran');
      localStorage.setItem('holoo_textile_import_erp_v2_device_actor_lock_v1', 'mehran');
      window.__glassIdbFault = { armed: false, injected: 0 };
      const originalTransaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function(storeNames, mode, options) {
        const tx = originalTransaction.call(this, storeNames, mode, options);
        const names = typeof storeNames === 'string' ? [storeNames] : Array.from(storeNames || []);
        if (window.__glassIdbFault.armed && mode === 'readwrite' &&
            names.includes('state') && names.includes('operations')) {
          window.__glassIdbFault.armed = false;
          window.__glassIdbFault.injected++;
          queueMicrotask(() => { try { tx.abort(); } catch (_) {} });
        }
        return tx;
      };
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('https://bdbckuwsilncbvqsknub.supabase.co/**', route => route.abort());
    await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });

    await page.waitForFunction(() =>
      typeof saveState === 'function' &&
      typeof state === 'object' && !!state.settings &&
      typeof localPersistenceFailed === 'boolean',
      { timeout: 45000 }
    );

    const setup = await page.evaluate(async () => {
      scheduleCloudSync = () => { window.__glassSyncSchedules = (window.__glassSyncSchedules || 0) + 1; };
      const result = saveState();
      if (result !== true) throw new Error('Initial durable save was not accepted');
      await operationJournalBarrier;
      const baseline = JSON.parse(JSON.stringify(lastSavedState));
      const metadata = { ...lastSavedMeta };
      const mirror = await readLocalMirror();
      const pending = await listPendingOperations();
      if (!mirror || JSON.stringify(mirror.payload) !== JSON.stringify(baseline)) {
        throw new Error('Initial IndexedDB mirror did not match the durable snapshot');
      }
      window.__glassSyncSchedules = 0;
      return { baseline, metadata, pendingIds: pending.map(item => item.operationId) };
    });

    await page.evaluate(() => {
      window.__glassIdbFault.armed = true;
      state.settings.companyName = String(state.settings.companyName || 'Glass') + ' — SHOULD ROLL BACK';
      const accepted = saveState();
      if (accepted !== true) throw new Error('Save was not queued before asynchronous IndexedDB failure');
    });

    await page.waitForFunction(() => localPersistenceFailed === true, { timeout: 15000 });

    const result = await page.evaluate(async () => {
      const mirror = await readLocalMirror();
      const pending = await listPendingOperations();
      const stored = JSON.parse(localStorage.getItem(STORE_KEY));
      const stateSnapshot = JSON.parse(JSON.stringify(state));
      const metadata = {
        localUpdated: localStorage.getItem(LOCAL_UPDATED_KEY),
        operationSequence: localStorage.getItem(OPERATION_SEQUENCE_KEY),
        cloudOutbox: localStorage.getItem(CLOUD_OUTBOX_KEY)
      };
      const blockedSave = saveState();
      return {
        injected: window.__glassIdbFault.injected,
        stateSnapshot,
        stored,
        mirror: mirror && mirror.payload,
        pendingIds: pending.map(item => item.operationId),
        metadata,
        blockedSave,
        syncSchedules: window.__glassSyncSchedules || 0,
        failureLatched: localPersistenceFailed
      };
    });

    assert.equal(result.injected, 1, 'the test must abort exactly one real IndexedDB transaction');
    assert.equal(result.failureLatched, true, 'persistence failure must latch');
    assert.deepEqual(result.stateSnapshot, setup.baseline, 'in-memory state must roll back');
    assert.deepEqual(result.stored, setup.baseline, 'localStorage snapshot must roll back');
    assert.deepEqual(result.mirror, setup.baseline, 'IndexedDB mirror must remain at the last committed snapshot');
    assert.deepEqual(result.pendingIds, setup.pendingIds, 'aborted operation must not enter the durable journal');
    assert.deepEqual(result.metadata, setup.metadata, 'durability metadata must roll back');
    assert.equal(result.blockedSave, false, 'subsequent saves must be refused');
    assert.equal(result.syncSchedules, 0, 'failed write must not schedule cloud sync');
    assert.deepEqual(pageErrors, [], 'browser runtime must not emit uncaught page errors');
    await context.close();
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
});
