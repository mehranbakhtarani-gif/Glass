const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFunction(name) {
  const marker = 'function ' + name + '(';
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, 'production function ' + name + ' must exist');
  const open = html.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let template = false;
  for (let i = open; i < html.length; i++) {
    const ch = html[i], next = html[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (template) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '`') template = false;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '`') { template = true; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error('Could not extract function ' + name);
}

const openDb = extractFunction('openLocalDatabase');
const writeMirror = extractFunction('writeLocalMirror');
const restore = extractFunction('restoreLastDurableLocalSnapshot');
const saveState = extractFunction('saveState');

test('IndexedDB open rejects when API is unavailable', () => {
  assert.match(openDb, /if\s*\(!\('indexedDB'\s+in\s+window\)\)\s*return reject/);
});

test('mirror and operation journal share one readwrite transaction', () => {
  assert.match(writeMirror, /db\.transaction\(\[LOCAL_DB_STORE,\s*OPERATION_DB_STORE\],\s*'readwrite'\)/);
  assert.match(writeMirror, /objectStore\(LOCAL_DB_STORE\)\.put/);
  assert.match(writeMirror, /objectStore\(OPERATION_DB_STORE\)\.add/);
  assert.match(writeMirror, /tx\.oncomplete\s*=\s*resolve/);
});

test('transaction errors and aborts reject instead of being swallowed', () => {
  assert.match(writeMirror, /tx\.onerror\s*=\s*\(\)\s*=>\s*reject/);
  assert.match(writeMirror, /tx\.onabort\s*=\s*\(\)\s*=>\s*reject/);
});

test('save queue is serialized and async failures trigger rollback', () => {
  assert.match(saveState, /operationJournalBarrier\.then\(\(\)\s*=>\s*writeLocalMirror/);
  assert.ok(saveState.includes('journalWrite.then(') && saveState.includes('}).catch(error => {') && saveState.includes('restoreLastDurableLocalSnapshot(error);'));
  assert.match(saveState, /operationJournalBarrier\s*=\s*journalWrite/);
});

test('rollback latches future saves and restores durable state plus metadata', () => {
  assert.match(restore, /localPersistenceFailed\s*=\s*true/);
  assert.match(restore, /state\s*=\s*JSON\.parse\(JSON\.stringify\(lastSavedState\)\)/);
  assert.match(restore, /localStorage\.setItem\(STORE_KEY,\s*JSON\.stringify\(lastSavedState\)\)/);
  assert.match(restore, /lastSavedMeta\.(localUpdated|operationSequence|cloudOutbox)/);
  assert.match(saveState, /if\s*\(localPersistenceFailed\)\s*\{/);
});

test('cloud sync is scheduled only after the IndexedDB journal write resolves', () => {
  const success = saveState.indexOf('journalWrite.then(');
  const failure = saveState.indexOf('}).catch(error =>', success);
  const sync = saveState.indexOf('scheduleCloudSync()', success);
  assert.ok(success >= 0 && failure > success && sync > success && sync < failure);
});
