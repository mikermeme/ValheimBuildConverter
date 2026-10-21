'use strict';
// Tests for codecs-ext.js (Infinity Hammer + CSV bundle). Run: node test-ext.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Load codecs.js + codecs-ext.js in one shared scope (mirrors the built page)
const ctx = vm.createContext({ console, TextEncoder, TextDecoder, Buffer, module: { exports: {} } });
vm.runInContext(fs.readFileSync(path.join(__dirname, 'codecs.js'), 'utf8').replace(/if \(typeof module.*\n?/g, '').replace(/if \(typeof window.*\n?/g, ''), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'codecs-ext.js'), 'utf8'), ctx);
const BFC = vm.runInContext('BFC', ctx);

const UP = '/mnt/user-data/uploads';
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok', name); }
  catch (e) { fail++; console.log('  FAIL', name, '—', e.message); }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg ?? ''} expected ${b}, got ${a}`); }
function near(a, b, tol, msg) { if (Math.abs(a - b) > tol) throw new Error(`${msg ?? ''} |${a} - ${b}| > ${tol}`); }

// Hash table
const table = JSON.parse(fs.readFileSync(path.join(UP, 'master_hash_lookup.json'), 'utf8'));
const bySigned = new Map(table.map(e => [e.hash_signed, e]));
const resolve = h => {
  const e = bySigned.get(h); if (!e) return null;
  for (const n of e.names) if (BFC.getStableHashCode(n) === h) return n;
  return e.names[0];
};

const ihText = fs.readFileSync(path.join(UP, 'EichenwaldeTest.blueprint'), 'latin1');

console.log('DataEntry blob codec');
const pieceLines = ihText.split(/\r?\n/).filter(l => l && !l.startsWith('#')).map(l => l.split(';')).filter(p => p.length >= 13 && p[13]);
t(`all ${pieceLines.length} sample blobs parse with exact length`, () => {
  for (const p of pieceLines) BFC.dataEntryCodec.parse(p[13]);
});
t('all sample blobs re-serialize byte-exact', () => {
  let n = 0;
  for (const p of pieceLines) {
    const de = BFC.dataEntryCodec.parse(p[13]);
    const out = BFC.dataEntryCodec.serialize(de);
    if (out !== p[13]) throw new Error(`blob ${n} (${p[0]}) mismatch:\n  in : ${p[13].slice(0, 60)}\n  out: ${out.slice(0, 60)}`);
    n++;
  }
});
t('unsupported flag bits are refused', () => {
  const w = Buffer.alloc(5); w.writeInt32LE(32, 0);
  let threw = false;
  try { BFC.dataEntryCodec.parse(new Uint8Array(w)); } catch { threw = true; }
  if (!threw) throw new Error('expected throw');
});

console.log('IH blueprint parse');
let ihIR;
t('EichenwaldeTest parses: 6432 zdos (incl. healed sign), flavor detected', () => {
  ihIR = BFC.parseBlueprintUnified(ihText, { hashResolver: resolve });
  eq(ihIR.zdos.length, 6432, 'zdo count (matches #Name "Multiple (6432)")');
  if (!ihIR.reports.warnings.some(w => /Healed 1 piece line/.test(w))) throw new Error('expected healing warning');
  eq(ihIR.meta.blueprintFlavor, 'infinityhammer', 'flavor');
  eq(ihIR.snapPoints.length, 6, 'snap points');
});
t('buckets populated from blobs; persistent/distant/type mapped', () => {
  const withVars = ihIR.zdos.filter(z => z.floats.length + z.ints.length + z.longs.length > 0).length;
  if (withVars < 6000) throw new Error(`only ${withVars} zdos carry vars`);
  // ground truth straight from the blobs
  let gtP = 0, gtD = 0, gtSolid = 0;
  for (const p of pieceLines) {
    const de = BFC.dataEntryCodec.parse(p[13]);
    if (de.persistent) gtP++;
    if (de.distant) gtD++;
    if (de.priority === 2) gtSolid++;
  }
  eq(ihIR.zdos.filter(z => z.persistent).length, gtP + 1, 'persistent count (+1 healed sign)');
  eq(ihIR.zdos.filter(z => z.distant).length, gtD, 'distant count');
  const solid = ihIR.zdos.filter(z => z.type === 2).length;
  if (solid < gtSolid || solid > gtSolid + 1) throw new Error(`solid count ${solid} vs ground truth ${gtSolid}`);
});
t('absolute anchoring lands near #Coordinates area', () => {
  // XZY header: x=8014.841, z=9588.459, y=213.801
  const zs = ihIR.zdos;
  const cx = zs.reduce((s, z) => s + z.pos.x, 0) / zs.length;
  const cz = zs.reduce((s, z) => s + z.pos.z, 0) / zs.length;
  near(cx, 8014.841, 60, 'mean x');
  near(cz, 9588.459, 60, 'mean z');
  // spawnpoint vars are absolute world coords the game wrote — pieces carrying
  // one must sit near it (creatures wander, so tolerance is generous)
  let checked = 0;
  for (const z of zs) {
    const sp = z.vec3s.find(e => e.hash === BFC.getStableHashCode('spawnpoint'));
    if (!sp) continue;
    near(z.pos.x, sp.value.x, 120, `${z.prefabName} x vs spawnpoint`);
    near(z.pos.z, sp.value.z, 120, `${z.prefabName} z vs spawnpoint`);
    checked++;
  }
  if (checked < 50) throw new Error(`only ${checked} spawnpoint checks`);
});

t('healed sign piece carries its full data blob and multi-line text', () => {
  const signs = ihIR.zdos.filter(z => z.prefabName === 'sign');
  if (!signs.length) throw new Error('no sign zdos');
  const healedSign = signs.find(z => {
    const t = z.strings.find(e => e.hash === BFC.getStableHashCode('text'));
    return t && /Look around for other loot/.test(t.value);
  });
  if (!healedSign) throw new Error('healed sign not reconstructed from blob');
  if (!healedSign.persistent) throw new Error('healed sign lost persistent flag');
});

console.log('rewind -> IH -> rewind fidelity');
const eichRewind = fs.readFileSync(path.join(UP, 'Eichenwalde')).buffer;
t('Eichenwalde rewind -> IH blueprint -> parse: everything preserved', () => {
  const src = BFC.rewindCodec.parse(eichRewind.slice(0), { hashResolver: resolve });
  const bpText = BFC.serializeIHBlueprint(src, { unresolvedPolicy: 'emit' });
  const back = BFC.parseBlueprintUnified(bpText, { hashResolver: resolve });
  eq(back.zdos.length, src.zdos.length, 'zdo count');
  // Full-content multiset comparison. Position rounded to 0.01 (one float32
  // ulp of headroom at world scale); stacked duplicate pieces are handled by
  // comparing sorted signatures rather than pairing greedily.
  const b64 = (u8) => Buffer.from(u8).toString('base64');
  const sig = z => JSON.stringify({
    p: z.prefabHash, pe: z.persistent, d: z.distant, t: z.type,
    x: Math.round(z.pos.x * 100), y: Math.round(z.pos.y * 100), zz: Math.round(z.pos.z * 100),
    b: ['floats', 'vec3s', 'quats', 'ints', 'longs', 'strings', 'bytes'].map(bk =>
      z[bk].map(e => `${e.hash}:${bk === 'bytes' ? b64(e.value) : bk === 'longs' ? e.value.toString() : JSON.stringify(e.value)}`).sort()),
  });
  const sa = src.zdos.map(sig).sort();
  const sb = back.zdos.map(sig).sort();
  for (let i = 0; i < sa.length; i++)
    if (sa[i] !== sb[i]) throw new Error(`signature mismatch at ${i}:\n  src : ${sa[i].slice(0, 160)}\n  back: ${sb[i].slice(0, 160)}`);
  // and it must serialize back to a valid rewind
  const buf = BFC.rewindCodec.serialize(back);
  const re = BFC.rewindCodec.parse(buf, { hashResolver: resolve });
  eq(re.zdos.length, src.zdos.length, 'rewind round trip count');
});

console.log('statistical cross-check vs in-game IH save');
t('EichenwaldeTest matches Eichenwalde rewind on static content', () => {
  const rw = BFC.rewindCodec.parse(eichRewind.slice(0), { hashResolver: resolve });
  const hist = zs => {
    const m = new Map();
    for (const z of zs) m.set(z.prefabName ?? z.prefabHash, (m.get(z.prefabName ?? z.prefabHash) || 0) + 1);
    return m;
  };
  const a = hist(rw.zdos), b = hist(ihIR.zdos);
  // static building prefabs should appear in identical counts
  let same = 0, checkedPrefabs = 0;
  for (const [name, cnt] of a) {
    if (typeof name !== 'string' || !/^(stone|wood|piece|Grill|forge|portal)/i.test(name)) continue;
    checkedPrefabs++;
    if (b.get(name) === cnt) same++;
  }
  if (checkedPrefabs < 10) throw new Error('too few static prefab classes to compare');
  if (same / checkedPrefabs < 0.5) throw new Error(`static prefab histograms diverge badly: ${same}/${checkedPrefabs}`);
  console.log(`    (histogram: ${same}/${checkedPrefabs} static prefab classes have identical counts)`);
  // relative geometry: pairwise distance signature of a mid-frequency static prefab
  const pick = [...a.keys()].find(n => typeof n === 'string' && /^stone/i.test(n) && a.get(n) === b.get(n) && a.get(n) >= 8 && a.get(n) <= 40);
  if (!pick) throw new Error('no comparable static prefab found');
  const sig = zs => {
    const pts = zs.filter(z => (z.prefabName ?? '') === pick).map(z => z.pos);
    const d = [];
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++)
      d.push(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y, pts[i].z - pts[j].z));
    return d.sort((x, y) => x - y);
  };
  const da = sig(rw.zdos), db = sig(ihIR.zdos);
  eq(da.length, db.length, `${pick} pair count`);
  for (let i = 0; i < da.length; i++) near(da[i], db[i], 0.35, `${pick} distance[${i}]`);
});

console.log('CSV bundle codec');
t('rewind -> CSV -> rewind round trip (vars, items, BigInt longs)', () => {
  const src = BFC.rewindCodec.parse(eichRewind.slice(0), { hashResolver: resolve });
  const csv = BFC.csvBundleCodec.serialize(src, { hashResolver: resolve });
  const back = BFC.csvBundleCodec.parse({ metaText: csv.metaCSV, zdosText: csv.zdosCSV, itemsText: csv.itemsCSV });
  if (back.reports.errors.length) throw new Error('errors: ' + JSON.stringify(back.reports.errors.slice(0, 3)));
  eq(back.zdos.length, src.zdos.length, 'zdo count');
  eq(back.meta.origin.x, src.meta.origin.x, 'origin');
  for (let i = 0; i < src.zdos.length; i++) {
    const s = src.zdos[i], b = back.zdos[i];
    eq(b.prefabHash, s.prefabHash, `row ${i} prefab`);
    eq(b.persistent, s.persistent, `row ${i} persistent`);
    eq(b.type, s.type, `row ${i} type`);
    for (const bucket of ['floats', 'vec3s', 'quats', 'ints', 'longs', 'strings', 'bytes'])
      eq(b[bucket].length, s[bucket].length, `row ${i} ${bucket}`);
    for (const e of s.longs) {
      const m = b.longs.find(x => x.hash === e.hash);
      if (!m || m.value !== e.value) throw new Error(`row ${i} long ${e.hash}: ${m && m.value} != ${e.value}`);
    }
    const si = s.strings.find(x => x.hash === BFC.H.items);
    const bi = b.strings.find(x => x.hash === BFC.H.items);
    if (!!si !== !!bi) throw new Error(`row ${i} items presence mismatch`);
    if (si) {
      const a1 = BFC.containerItemsCodec.parse(si.value).items, a2 = BFC.containerItemsCodec.parse(bi.value).items;
      eq(a2.length, a1.length, `row ${i} item count`);
      for (let k = 0; k < a1.length; k++) {
        eq(a2[k].prefabName, a1[k].prefabName, `row ${i} item ${k} prefab`);
        eq(a2[k].stack, a1[k].stack, `row ${i} item ${k} stack`);
        eq(a2[k].crafterID, a1[k].crafterID, `row ${i} item ${k} crafterID`);
        eq(a2[k].customData.length, a1[k].customData.length, `row ${i} item ${k} customData`);
      }
    }
  }
});
t('CSV cells survive Excel-ish quoting (commas, quotes, newlines)', () => {
  const ir = BFC.emptyIR('test');
  const z = BFC.emptyZdo();
  z.prefabName = 'sign'; z.prefabHash = BFC.getStableHashCode('sign');
  z.strings.push({ hash: BFC.getStableHashCode('text'), name: 'text', value: 'He said "hi", then\nleft' });
  ir.zdos.push(z);
  const csv = BFC.csvBundleCodec.serialize(ir, { hashResolver: resolve });
  const back = BFC.csvBundleCodec.parse({ metaText: csv.metaCSV, zdosText: csv.zdosCSV, itemsText: csv.itemsCSV });
  eq(back.zdos[0].strings[0].value, 'He said "hi", then\nleft', 'string value');
});

console.log('PB <-> IH interop');
t('PlanBuild blueprint parses through unified parser identically', () => {
  const pbText = fs.readFileSync(path.join(UP, 'cozy_house.blueprint'), 'utf8');
  const a = BFC.blueprintCodec.parse(pbText, { hashResolver: resolve });
  const b = BFC.parseBlueprintUnified(pbText, { hashResolver: resolve });
  eq(b.meta.blueprintFlavor, 'planbuild', 'flavor');
  eq(b.zdos.length, a.zdos.length, 'zdo count');
  for (let i = 0; i < a.zdos.length; i++) {
    eq(b.zdos[i].prefabHash, a.zdos[i].prefabHash, `piece ${i} prefab`);
    near(b.zdos[i].pos.x, a.zdos[i].pos.x, 1e-6, `piece ${i} x`);
  }
});
t('PB blueprint -> IH flavor -> parse keeps geometry and gains data blobs', () => {
  const pbText = fs.readFileSync(path.join(UP, 'cozy_house.blueprint'), 'utf8');
  const a = BFC.parseBlueprintUnified(pbText, { hashResolver: resolve });
  const ih = BFC.serializeIHBlueprint(a, {});
  const b = BFC.parseBlueprintUnified(ih, { hashResolver: resolve });
  eq(b.zdos.length, a.zdos.length, 'count');
  const key = z => `${z.prefabHash}|${z.pos.x.toFixed(2)}|${z.pos.z.toFixed(2)}`;
  const set = new Set(a.zdos.map(key));
  let hit = 0;
  for (const z of b.zdos) if (set.has(key(z))) hit++;
  if (hit < a.zdos.length * 0.999) throw new Error(`geometry drift: ${hit}/${a.zdos.length}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
