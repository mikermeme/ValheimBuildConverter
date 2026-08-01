'use strict';
// Headless smoke test for converter-v2.html: stub the DOM, run both script
// blocks, drive the real UI flow. Run: node smoke2.js
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'converter-v2.html'), 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (blocks.length !== 2) throw new Error(`expected 2 script blocks, got ${blocks.length}`);

// ------------------------------ DOM stub -------------------------------------
const registry = new Map();
const downloads = [];
const urlMap = new Map();
let urlSeq = 0;

function makeEl(id) {
  const el = {
    id, innerHTML: '', textContent: '', className: '', title: '', value: '', checked: false,
    style: {}, dataset: {}, files: [], children: [], handlers: {},
    classList: { add() {}, remove() {} },
    addEventListener(type, fn) { (el.handlers[type] = el.handlers[type] || []).push(fn); },
    appendChild(c) { el.children.push(c); return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); },
    click() {
      if (el.download !== undefined && el.href !== undefined)
        downloads.push({ name: el.download, blob: urlMap.get(el.href) });
      for (const fn of el.handlers.click || []) fn({ preventDefault() {} });
      if (el.onclick) el.onclick();
    },
    fire(type, ev = {}) { for (const fn of el.handlers[type] || []) fn({ preventDefault() {}, ...ev }); },
  };
  return el;
}
const docHandlers = {};
const documentStub = {
  getElementById(id) { if (!registry.has(id)) registry.set(id, makeEl(id)); return registry.get(id); },
  createElement(tag) { return makeEl('<' + tag + '>'); },
  addEventListener(type, fn) { (docHandlers[type] = docHandlers[type] || []).push(fn); },
  body: makeEl('body'),
};
class BlobStub {
  constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; }
  get size() { return this.parts.reduce((s, p) => s + (p.byteLength ?? p.length ?? 0), 0); }
  text() { return this.parts.map(p => typeof p === 'string' ? p : Buffer.from(p).toString('utf8')).join(''); }
}
const URLStub = {
  createObjectURL(blob) { const t = 'blob:' + (urlSeq++); urlMap.set(t, blob); return t; },
  revokeObjectURL() {},
};
const fetchStub = async (url) => {
  if (url === 'master_hash_lookup.json') {
    const body = fs.readFileSync('/mnt/user-data/uploads/master_hash_lookup.json', 'utf8');
    return { ok: true, json: async () => JSON.parse(body) };
  }
  return { ok: false, status: 404 };
};

const sandbox = {
  console, TextEncoder, TextDecoder, Buffer, setTimeout, clearTimeout,
  document: documentStub, URL: URLStub, Blob: BlobStub, fetch: fetchStub,
  atob: s => Buffer.from(s, 'base64').toString('latin1'),
  btoa: s => Buffer.from(s, 'latin1').toString('base64'),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const vm = require('vm');
const ctx = vm.createContext(sandbox);
for (const b of blocks) vm.runInContext(b, ctx);

// ------------------------------ drive ----------------------------------------
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok', name); }
  else { fail++; console.log('  FAIL', name, extra ?? ''); }
}
const fakeFile = (name, data) => ({
  name, size: data.length,
  arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  text: async () => Buffer.from(data).toString('utf8'),
});
const tick = () => new Promise(r => setTimeout(r, 0));

(async () => {
  for (const fn of docHandlers.DOMContentLoaded || []) fn();
  await tick(); await tick(); // hash table fetch
  const chip = registry.get('hash-chip');
  t('hash table loaded', /Hash table: [\d,]+ entries/.test(chip.textContent), chip.textContent);

  // ---- load EichenwaldeTest.blueprint (Infinity Hammer) ----
  const ihBytes = fs.readFileSync('/mnt/user-data/uploads/EichenwaldeTest.blueprint');
  const input = registry.get('file-input');
  input.files = [fakeFile('EichenwaldeTest.blueprint', ihBytes)];
  input.fire('change');
  await tick(); await tick();
  const insp = registry.get('inspector').innerHTML;
  t('inspector shows 6,432 objects', insp.includes('6,432'), insp.slice(0, 200));
  t('flavor badge infinityhammer', insp.includes('infinityhammer'));
  t('main visible', registry.get('main').style.display === 'grid');

  // select targets by clicking rendered cards; convert each
  const targets = registry.get('targets');
  const selectTarget = (needle) => {
    const card = targets.children.find(c => c.innerHTML.includes(needle));
    if (!card) throw new Error('target card not found: ' + needle);
    card.onclick();
  };
  // pre-seed dynamic option elements read by convert()
  documentStub.getElementById("opt-ref").value = "mincorner";
  documentStub.getElementById("opt-data").checked = true;
  documentStub.getElementById("opt-emit").checked = true;
  documentStub.getElementById("opt-name").value = "";
  documentStub.getElementById("opt-creator").value = "";

  const convertBtn = registry.get('convert-btn');
  const statusEl = registry.get('conv-status');

  selectTarget('.rewind');
  downloads.length = 0;
  convertBtn.click();
  t('IH blueprint -> rewind ok', statusEl.innerHTML.includes('✅') && downloads.some(d => d.name.endsWith('.rewind')), statusEl.innerHTML.slice(0, 200));
  const rewindBlob = downloads.find(d => d.name.endsWith('.rewind'));

  selectTarget('PlanBuild classic');
  downloads.length = 0;
  convertBtn.click();
  t('IH blueprint -> PlanBuild ok', statusEl.innerHTML.includes('✅') && downloads.some(d => d.name.endsWith('.blueprint')), statusEl.innerHTML.slice(0, 200));
  t('PB conversion produced loss report', registry.get('report').innerHTML.includes('dropped'), registry.get('report').innerHTML.slice(0, 150));

  selectTarget('Infinity Hammer extended');
  downloads.length = 0;
  convertBtn.click();
  t('IH -> IH normalization ok', statusEl.innerHTML.includes('✅') && statusEl.innerHTML.includes('hammer_restore'), statusEl.innerHTML.slice(0, 250));

  selectTarget('CSV bundle');
  downloads.length = 0;
  convertBtn.click();
  const csvNames = downloads.map(d => d.name).join(', ');
  t('CSV bundle: meta+zdos+items (+snappoints)', downloads.length >= 3 && /meta\.csv/.test(csvNames) && /zdos\.csv/.test(csvNames) && /items\.csv/.test(csvNames), csvNames);

  // ---- re-ingest the CSV bundle ----
  const byName = suffix => downloads.find(d => d.name.endsWith(suffix));
  const csvFiles = ['meta.csv', 'zdos.csv', 'items.csv'].map(sfx =>
    fakeFile(byName(sfx).name, Buffer.from(byName(sfx).blob.text(), 'utf8')));
  input.files = csvFiles;
  input.fire('change');
  await tick(); await tick();
  t('CSV re-ingest shows 6,432 objects', registry.get('inspector').innerHTML.includes('6,432'), registry.get('inspector').innerHTML.slice(0, 200));

  selectTarget('.rewind');
  downloads.length = 0;
  convertBtn.click();
  t('CSV -> rewind ok', statusEl.innerHTML.includes('✅'), statusEl.innerHTML.slice(0, 200));
  const rewind2 = downloads.find(d => d.name.endsWith('.rewind'));
  t('rewind size stable across CSV round trip',
    rewind2 && Math.abs(rewind2.blob.size - rewindBlob.blob.size) < rewindBlob.blob.size * 0.001,
    rewind2 && `${rewindBlob.blob.size} vs ${rewind2.blob.size}`);

  // ---- load a rewind directly ----
  const rw = fs.readFileSync('/mnt/user-data/uploads/exampleTinyRewind');
  input.files = [fakeFile('exampleTinyRewind.rewind', rw)];
  input.fire('change');
  await tick(); await tick();
  t('tiny rewind loads', registry.get('main').style.display === 'grid' && registry.get('inspector').innerHTML.includes('objects'));
  selectTarget('Infinity Hammer extended');
  downloads.length = 0;
  convertBtn.click();
  t('tiny rewind -> IH ok', statusEl.innerHTML.includes('✅'), statusEl.innerHTML.slice(0, 300));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
