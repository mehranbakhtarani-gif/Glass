const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const STORE_KEY = 'holoo_textile_import_erp_v2';
const BASELINE = '2026-11-19T14:00:00.000Z';

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

test('three isolated device clients preserve CAS conflicts and pending local operations', { timeout: 180000 }, async () => {
  let server;
  let browser;
  let baseUrl;
  let serverUpdatedAt = BASELINE;
  let serverSnapshot = null;
  let appliedCount = 0;
  const requests = [];

  server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); }
    catch { res.writeHead(400).end('Bad request'); return; }
    if (pathname === '/') pathname = '/index.html';
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

  try {
    browser = await chromium.launch({ headless: true });
    const actors = [
      { id: 'mehran-phone', actor: 'mehran' },
      { id: 'ehsan-phone-a', actor: 'ehsan' },
      { id: 'ehsan-phone-b', actor: 'ehsan' }
    ];
    const clients = [];

    for (const device of actors) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.addInitScript(({ actor }) => {
        localStorage.setItem('holoo_textile_import_erp_v2_device_actor_v1', actor);
        localStorage.setItem('holoo_textile_import_erp_v2_device_actor_lock_v1', actor);
      }, { actor: device.actor });

      await context.route('https://bdbckuwsilncbvqsknub.supabase.co/functions/v1/glass-gateway', async route => {
        const body = route.request().postDataJSON();
        const token = route.request().headers()['authorization'] || '';
        const expectedToken = 'Bearer test-device-token-' + device.id;
        if (token !== expectedToken) {
          await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'device_unauthorized' }) });
          return;
        }
        if (body.action === 'read') {
          await route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({ snapshot: serverSnapshot ? { data: serverSnapshot, updated_at: serverUpdatedAt, revision: appliedCount } : null })
          });
          return;
        }
        if (body.action !== 'apply' || !body.operation) {
          await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_operation' }) });
          return;
        }
        const op = body.operation;
        requests.push({ device: device.id, actor: device.actor, operationId: op.operationId, expectedUpdatedAt: op.expectedUpdatedAt });
        if (op.expectedUpdatedAt !== serverUpdatedAt) {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { status: 'conflict' } }) });
          return;
        }
        serverSnapshot = op.payload;
        appliedCount++;
        serverUpdatedAt = '2026-11-19T14:30:00.' + String(appliedCount).padStart(3, '0') + 'Z';
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ result: { status: 'applied', updated_at: serverUpdatedAt } })
        });
      });

      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.route('https://bdbckuwsilncbvqsknub.supabase.co/**', route => route.continue());
      await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForFunction(() =>
        typeof saveState === 'function' &&
        typeof pushToSupabase === 'function' &&
        typeof state === 'object' && !!state.settings &&
        typeof operationJournalBarrier !== 'undefined',
        undefined,
        { timeout: 45000 }
      );
      await page.evaluate(({ deviceId }) => {
        localStorage.setItem('holoo_textile_import_erp_v2_device_token_v1', 'test-device-token-' + deviceId);
        localStorage.setItem('holoo_textile_import_erp_v2_cloud_baseline_v1', '2026-11-19T14:00:00.000Z');
        scheduleCloudSync = () => {};
      }, { deviceId: device.id });
      clients.push({ context, page, device, pageErrors });
    }

    // Queue one independent local change on each device against the same server revision.
    for (const client of clients) {
      await client.page.evaluate(async ({ deviceId }) => {
        state.settings.companyName = 'ISOLATED TEST ' + deviceId;
        const accepted = saveState();
        if (accepted !== true) throw new Error('Local operation was not accepted for ' + deviceId);
        await operationJournalBarrier;
        const pending = await listPendingOperations();
        if (pending.length !== 1) throw new Error('Expected one pending local operation for ' + deviceId);
      }, { deviceId: client.device.id });
    }

    // All three clients now submit concurrently with the same expected revision.
    const outcomes = await Promise.all(clients.map(client =>
      client.page.evaluate(() => pushToSupabase(false))
    ));

    assert.equal(requests.length, 3, 'all three independent devices must reach the mocked gateway');
    assert.equal(appliedCount, 1, 'only one client may advance the shared company revision');
    assert.equal(outcomes.filter(Boolean).length, 1, 'exactly one device should report a successful push');
    assert.equal(outcomes.filter(value => value === false).length, 2, 'two stale devices must report conflict');
    assert.equal(new Set(requests.map(item => item.operationId)).size, 3, 'each device must submit a unique operation id');
    assert.equal(new Set(requests.map(item => item.expectedUpdatedAt)).size, 1, 'all devices must start from the same base revision');

    const clientResults = [];
    for (const client of clients) {
      clientResults.push(await client.page.evaluate(async () => ({
        pending: (await listPendingOperations()).length,
        outbox: !!localStorage.getItem(STORE_KEY + '_cloud_outbox_v1'),
        conflict: !!(await readCloudConflict()),
        localCompany: state.settings.companyName,
        pageErrors: []
      })));
      assert.deepEqual(client.pageErrors, [], 'browser runtime must not emit uncaught page errors');
    }

    assert.equal(clientResults.filter(result => result.pending === 0 && !result.outbox).length, 1,
      'the winning device must acknowledge and clear its operation');
    assert.equal(clientResults.filter(result => result.pending === 1 && result.outbox && result.conflict).length, 2,
      'losing devices must preserve their pending operations and persist conflict snapshots');
    assert.equal(clientResults.filter(result => result.localCompany.startsWith('ISOLATED TEST ')).length, 3,
      'conflict handling must not overwrite any device local draft with the remote winner');

    for (const client of clients) await client.context.close();
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
});
