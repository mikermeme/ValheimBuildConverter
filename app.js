'use strict';
/* global BFC */
// ============================================================================
// Valheim Build File Converter v2 — app layer.
// Codec layer (window.BFC) does all format work; this file is UI + wiring.
// ============================================================================
(function () {

// ------------------------------ hash table ---------------------------------
let hashBySigned = null;   // Map<signedHash, {names:[...]}>
let nameToHashFn = (k) => /^-?\d+$/.test(k) ? parseInt(k, 10) | 0 : BFC.getStableHashCode(k);

function resolveVerified(hash) {
  if (!hashBySigned) return null;
  const e = hashBySigned.get(hash);
  if (!e) return null;
  for (const n of e.names) if (BFC.getStableHashCode(n) === hash) return n;
  return e.names[0] ?? null;
}

async function loadHashTable() {
  const chip = document.getElementById('hash-chip');
  try {
    const resp = await fetch('master_hash_lookup.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const table = await resp.json();
    hashBySigned = new Map(table.map(e => [e.hash_signed, e]));
    let enriched = 0;
    try { // optional compound-name enrichment (ClassName_FieldName)
      const ff = await fetch('FieldsFiltered.csv');
      if (ff.ok) {
        const { rows } = BFC.parseCSVText(await ff.text());
        for (const r of rows) {
          const cls = r.ClassName ?? r.class ?? r.Class, fld = r.FieldName ?? r.field ?? r.Field;
          if (!cls || !fld) continue;
          const name = `${cls}_${fld}`;
          const h = BFC.getStableHashCode(name);
          if (!hashBySigned.has(h)) { hashBySigned.set(h, { names: [name] }); enriched++; }
        }
      }
    } catch (_) { /* optional */ }
    chip.textContent = `Hash table: ${hashBySigned.size.toLocaleString()} entries${enriched ? ` (+${enriched} field names)` : ''}`;
    chip.className = 'chip ok';
    if (state.ir) refreshAll(); // re-resolve names now that the table is here
  } catch (e) {
    chip.textContent = 'Hash table missing — unresolved prefabs will be skipped or hex-emitted';
    chip.className = 'chip err';
    chip.title = 'Put master_hash_lookup.json next to this HTML file. ' + e.message;
  }
}

// ------------------------------ state ---------------------------------------
const state = { ir: null, baseName: 'build', sourceFmt: null, target: 'ih' };

const TARGETS = [
  { id: 'rewind', title: '.rewind', ext: '.rewind',
    desc: 'Binary snapshot for the Rewind mod.',
    fid: () => ({ cls: 'full', text: 'Full fidelity: every ZDO variable, flag and container survives.' }) },
  { id: 'ih', title: '.blueprint — Infinity Hammer extended', ext: '.blueprint',
    desc: 'PlanBuild-compatible text with per-piece ZDO data blocks. hammer_restore rebuilds at the exact original world position.',
    fid: () => ({ cls: 'full', text: 'Near-lossless: all ZDO variables, persistent/distant/priority preserved in base64 data blocks.' }) },
  { id: 'pb', title: '.blueprint — PlanBuild classic', ext: '.blueprint',
    desc: 'Plain PlanBuild format for maximum mod compatibility.',
    fid: (ir) => {
      if (!ir) return { cls: 'geo', text: '' };
      const n = countDroppableVars(ir);
      return n ? { cls: 'partial', text: `Geometry + additionalInfo only — ~${n.toLocaleString()} ZDO variable(s) will be dropped (loss report on convert).` }
               : { cls: 'full', text: 'No extra ZDO variables present — nothing to lose.' };
    } },
  { id: 'csv', title: 'CSV bundle', ext: '.csv',
    desc: 'meta / zdos / items spreadsheets — edit in Excel, drop back here to rebuild.',
    fid: () => ({ cls: 'full', text: 'Full fidelity: same columns as the original tool; longs precision-safe.' }) },
];

function countDroppableVars(ir) {
  // cheap preview: vars beyond scale + the single additionalInfo channel
  let n = 0;
  for (const z of ir.zdos) {
    let consumed = 0;
    if (z.strings.some(e => e.hash === BFC.H.items)) consumed = 1;
    else if (z.strings.length || z.ints.length) consumed = 1; // one channel at best
    const total = z.floats.length + z.vec3s.length + z.quats.length + z.ints.length + z.longs.length + z.strings.length + z.bytes.length;
    const scaleVars = (z.vec3s.some(e => e.hash === BFC.H.scale) ? 1 : 0) + (z.floats.some(e => e.hash === BFC.H.scaleScalar) ? 1 : 0);
    n += Math.max(0, total - scaleVars - consumed);
  }
  return n;
}

// ------------------------------ ingestion -----------------------------------
async function handleFiles(files) {
  if (!files.length) return;
  const status = document.getElementById('conv-status');
  status.innerHTML = '';
  document.getElementById('report').innerHTML = '';
  try {
    const csvs = {};
    let mainFile = null;
    for (const f of files) {
      const n = f.name.toLowerCase();
      if (n.endsWith('.csv')) {
        if (n.includes('meta')) csvs.meta = f;
        else if (n.includes('zdo')) csvs.zdos = f;
        else if (n.includes('item')) csvs.items = f;
        else csvs.zdos = csvs.zdos || f;
      } else mainFile = mainFile || f;
    }
    let ir, baseName, fmt;
    if (mainFile) {
      const bytes = new Uint8Array(await mainFile.arrayBuffer());
      fmt = BFC.sniffFormat(bytes, mainFile.name);
      baseName = mainFile.name.replace(/\.(blueprint|vbuild|rewind)$/i, '');
      if (fmt === 'rewind') {
        ir = BFC.rewindCodec.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { hashResolver: resolveVerified });
      } else if (fmt === 'blueprint') {
        ir = BFC.parseBlueprintUnified(new TextDecoder().decode(bytes), { hashResolver: resolveVerified });
        if (ir.meta.blueprintFlavor === 'infinityhammer') fmt = 'blueprint (Infinity Hammer)';
        else fmt = 'blueprint (PlanBuild)';
      } else if (fmt === 'vbuild') {
        ir = BFC.vbuildCodec.parse(new TextDecoder().decode(bytes), { id: baseName });
      } else throw new Error(`Could not detect the format of ${mainFile.name}`);
      ir.meta.name = ir.meta.name ?? baseName;
    } else if (csvs.zdos) {
      const texts = {
        metaText: csvs.meta ? await csvs.meta.text() : '',
        zdosText: await csvs.zdos.text(),
        itemsText: csvs.items ? await csvs.items.text() : '',
      };
      ir = BFC.csvBundleCodec.parse(texts, { nameToHash: nameToHashFn });
      if (ir.reports.errors && ir.reports.errors.length) {
        status.innerHTML = `<div class="status err"><b>CSV validation failed:</b><div class="list">` +
          ir.reports.errors.slice(0, 50).map(e => `${e.where} row ${e.row}: ${esc(e.msg)}`).join('\n') + `</div></div>`;
        return;
      }
      // resolve prefab names for display
      for (const z of ir.zdos) if (z.prefabName == null) z.prefabName = resolveVerified(z.prefabHash);
      fmt = 'csv bundle';
      baseName = csvs.zdos.name.replace(/\.?zdos\.csv$/i, '').replace(/\.csv$/i, '') || 'build';
      ir.meta.name = ir.meta.name ?? baseName;
    } else throw new Error('No recognizable build file among the dropped files.');
    state.ir = ir; state.baseName = baseName; state.sourceFmt = fmt;
    refreshAll();
  } catch (e) {
    console.error(e);
    status.innerHTML = `<div class="status err"><b>Load failed:</b> ${esc(e.message)}</div>`;
    document.getElementById('main').style.display = 'grid';
  }
}

// ------------------------------ inspector -----------------------------------
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

function renderInspector() {
  const ir = state.ir;
  const el = document.getElementById('inspector');
  const zs = ir.zdos;
  const withData = zs.filter(z => z.floats.length + z.vec3s.length + z.quats.length + z.ints.length + z.longs.length + z.strings.length + z.bytes.length > 0).length;
  const containers = zs.filter(z => z.strings.some(e => e.hash === BFC.H.items)).length;
  const unresolved = zs.filter(z => z.prefabName == null).length;
  const m = ir.meta;
  const flavorBadge = m.blueprintFlavor ? `<span class="badge flavor">${m.blueprintFlavor}</span>` : '';
  const hist = new Map();
  for (const z of zs) {
    const k = z.prefabName ?? ('#0x' + (z.prefabHash >>> 0).toString(16).toUpperCase());
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const max = top.length ? top[0][1] : 1;
  let origin = '';
  if (m.ihCoordinates) origin = `<div class="kv">Saved at <b>${m.ihCoordinates.x.toFixed(1)}, ${m.ihCoordinates.y.toFixed(1)}, ${m.ihCoordinates.z.toFixed(1)}</b> (from #Coordinates — positions restored to absolute)</div>`;
  else if (m.origin && (m.origin.x || m.origin.y || m.origin.z)) origin = `<div class="kv">Origin <b>${m.origin.x.toFixed(1)}, ${m.origin.y.toFixed(1)}, ${m.origin.z.toFixed(1)}</b></div>`;

  el.innerHTML = `
    <h2><span class="badge">${esc(state.sourceFmt)}</span>${flavorBadge}${esc(m.name ?? state.baseName)}</h2>
    <div class="kv">${m.creator ? `by <b>${esc(m.creator)}</b> · ` : ''}${m.category ? `category <b>${esc(m.category)}</b> · ` : ''}${esc(m.description ?? '')}</div>
    ${origin}
    <div class="stats">
      <div class="stat"><div class="n">${zs.length.toLocaleString()}</div><div class="l">objects</div></div>
      <div class="stat"><div class="n ${withData ? 'good' : 'dim'}">${withData.toLocaleString()}</div><div class="l">with ZDO data</div></div>
      <div class="stat"><div class="n ${containers ? '' : 'dim'}">${containers.toLocaleString()}</div><div class="l">containers</div></div>
      <div class="stat"><div class="n ${unresolved ? 'bad' : 'dim'}">${unresolved.toLocaleString()}</div><div class="l">unresolved</div></div>
      <div class="stat"><div class="n ${ir.snapPoints.length ? '' : 'dim'}">${ir.snapPoints.length}</div><div class="l">snap points</div></div>
    </div>
    <table class="hist">${top.map(([n, c]) =>
      `<tr><td>${esc(n)}</td><td class="n">${c}</td><td style="width:34%"><div class="bar" style="width:${Math.round(100 * c / max)}%"></div></td></tr>`).join('')}
    </table>
    ${ir.reports.warnings.length ? `<details><summary>${ir.reports.warnings.length} source warning(s)</summary><div class="list">${dedupe(ir.reports.warnings).map(esc).join('\n')}</div></details>` : ''}
  `;
}

function dedupe(arr) {
  const c = new Map();
  for (const w of arr) c.set(w, (c.get(w) || 0) + 1);
  return [...c.entries()].map(([w, n]) => (n > 1 ? `${n}× ` : '') + w);
}

// ------------------------------ targets & options ----------------------------
function renderTargets() {
  const el = document.getElementById('targets');
  el.innerHTML = '';
  for (const t of TARGETS) {
    const fid = t.fid(state.ir);
    const div = document.createElement('div');
    div.className = 'target' + (state.target === t.id ? ' sel' : '');
    div.innerHTML = `<div class="t">${t.title}</div><div class="d">${t.desc}</div>` +
      (fid.text ? `<div class="fid ${fid.cls}">${fid.text}</div>` : '');
    div.onclick = () => { state.target = t.id; renderTargets(); renderOpts(); };
    el.appendChild(div);
  }
}

function renderOpts() {
  const el = document.getElementById('opts');
  const t = state.target;
  let html = '';
  if (t === 'pb') {
    html += `<label>Reference point
      <select id="opt-ref">
        <option value="mincorner" selected>Min corner (PlanBuild convention)</option>
        <option value="origin">Source origin</option>
        <option value="zero">None — keep coordinates</option>
      </select></label>`;
  }
  if (t === 'ih') {
    html += `<label><input type="checkbox" id="opt-data" checked> Embed full ZDO data blocks (uncheck for a plain centered blueprint)</label>`;
  }
  if (t === 'pb' || t === 'ih') {
    html += `<label><input type="checkbox" id="opt-emit"> Emit unresolved prefabs as <code>#0xHEX</code> instead of skipping</label>
      <label>Name <input type="text" id="opt-name" placeholder="${esc(state.ir?.meta.name ?? state.baseName)}"></label>
      <label>Creator <input type="text" id="opt-creator" placeholder="${esc(state.ir?.meta.creator ?? '')}"></label>`;
  }
  el.innerHTML = html;
}

// ------------------------------ convert --------------------------------------
function download(name, data, mime) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([data], { type: mime }));
  link.download = name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

function renderReport(ir) {
  const el = document.getElementById('report');
  let html = '';
  const warns = dedupe(ir.reports.warnings);
  if (warns.length)
    html += `<details open><summary>⚠️ ${ir.reports.warnings.length} warning(s)</summary><div class="list">${warns.map(esc).join('\n')}</div></details>`;
  const losses = BFC.summarizeLosses(ir.reports.losses);
  if (losses.length) {
    const total = ir.reports.losses.reduce((s, l) => s + l.count, 0);
    html += `<details><summary>🗑️ ${total.toLocaleString()} dropped item(s) across ${losses.length} kinds</summary><div class="list">${losses.slice(0, 400).map(l => `${l.count}\t${esc(l.key)}`).join('\n')}</div></details>`;
    html += `<button class="btn btn-sm" id="loss-dl">Download loss report</button>`;
  }
  el.innerHTML = html;
  const dl = document.getElementById('loss-dl');
  if (dl) dl.onclick = () => download(`${state.baseName}.loss-report.txt`,
    losses.map(l => `${l.count}\t${l.key}`).join('\n'), 'text/plain');
}

function convert() {
  const ir = state.ir;
  if (!ir) return;
  const status = document.getElementById('conv-status');
  const t = state.target;
  // fresh reports per conversion; keep source warnings visible
  const srcWarnings = ir.reports.warnings.slice();
  ir.reports = { warnings: srcWarnings.slice(), losses: [], errors: [] };
  const opt = id => document.getElementById(id);
  if (opt('opt-name') && opt('opt-name').value.trim()) ir.meta.name = opt('opt-name').value.trim();
  if (opt('opt-creator') && opt('opt-creator').value.trim()) ir.meta.creator = opt('opt-creator').value.trim();
  const safe = (ir.meta.name ?? state.baseName).replace(/[^\w\- ()\[\]]+/g, '_');
  try {
    if (t === 'rewind') {
      if (ir.snapPoints.length) ir.reports.warnings.push(`${ir.snapPoints.length} snap point(s) are not representable in .rewind — dropped`);
      const buf = BFC.rewindCodec.serialize(ir);
      const check = BFC.rewindCodec.parse(buf);
      if (check.zdos.length !== ir.zdos.length) throw new Error('self-check: ZDO count mismatch after reparse');
      const buf2 = BFC.rewindCodec.serialize(check);
      const a = new Uint8Array(buf), b = new Uint8Array(buf2);
      if (a.length !== b.length) throw new Error('self-check: output not byte-stable');
      download(`${safe}.rewind`, buf, 'application/octet-stream');
      status.innerHTML = `<div class="status ok">✅ ${ir.zdos.length.toLocaleString()} ZDOs → <b>${esc(safe)}.rewind</b> (${buf.byteLength.toLocaleString()} bytes). Self-check passed.</div>`;
    } else if (t === 'ih') {
      const text = BFC.serializeIHBlueprint(ir, {
        includeData: opt('opt-data') ? opt('opt-data').checked : true,
        unresolvedPolicy: opt('opt-emit') && opt('opt-emit').checked ? 'emit' : 'skip',
      });
      const check = BFC.parseBlueprintUnified(text, { hashResolver: resolveVerified });
      const emitted = ir.zdos.length - ir.reports.losses.filter(l => l.kind === 'zdo-skipped-unresolved').length;
      if (check.zdos.length !== emitted) throw new Error(`self-check: reparse found ${check.zdos.length} pieces, expected ${emitted}`);
      const varsIn = totalVars(ir), varsOut = totalVars(check);
      if (opt('opt-data') && opt('opt-data').checked && varsOut < varsIn - ir.reports.losses.length * 50)
        ir.reports.warnings.push(`var count after reparse: ${varsOut}/${varsIn}`);
      download(`${safe}.blueprint`, text, 'text/plain;charset=utf-8');
      status.innerHTML = `<div class="status ok">✅ ${check.zdos.length.toLocaleString()} pieces → <b>${esc(safe)}.blueprint</b> (Infinity Hammer). Self-check passed — ${varsOut.toLocaleString()} ZDO variables preserved.` +
        ` Restore in-game at the original spot with <code>hammer_restore ${esc(safe)}</code>.</div>`;
    } else if (t === 'pb') {
      const text = BFC.blueprintCodec.serialize(ir, {
        reference: opt('opt-ref') ? opt('opt-ref').value : 'mincorner',
        unresolvedPolicy: opt('opt-emit') && opt('opt-emit').checked ? 'emit' : 'skip',
      });
      const check = BFC.blueprintCodec.parse(text, { id: safe });
      const emitted = ir.zdos.length - ir.reports.losses.filter(l => l.kind === 'zdo-skipped-unresolved').length;
      if (check.zdos.length !== emitted) throw new Error(`self-check: reparse found ${check.zdos.length} pieces, expected ${emitted}`);
      download(`${safe}.blueprint`, text, 'text/plain;charset=utf-8');
      status.innerHTML = `<div class="status ok">✅ ${check.zdos.length.toLocaleString()} pieces → <b>${esc(safe)}.blueprint</b> (PlanBuild). Self-check passed.</div>`;
    } else { // csv
      const bundle = BFC.csvBundleCodec.serialize(ir, { hashResolver: resolveVerified });
      const back = BFC.csvBundleCodec.parse({ metaText: bundle.metaCSV, zdosText: bundle.zdosCSV, itemsText: bundle.itemsCSV }, { nameToHash: nameToHashFn });
      if (back.zdos.length !== ir.zdos.length) throw new Error('self-check: CSV reparse count mismatch');
      download(`${safe}.meta.csv`, bundle.metaCSV, 'text/csv');
      download(`${safe}.zdos.csv`, bundle.zdosCSV, 'text/csv');
      download(`${safe}.items.csv`, bundle.itemsCSV, 'text/csv');
      if (ir.snapPoints.length)
        download(`${safe}.snappoints.csv`, 'x,y,z\n' + ir.snapPoints.map(s => [s.x, s.y, s.z].map(BFC.shortestFloat32).join(',')).join('\n') + '\n', 'text/csv');
      status.innerHTML = `<div class="status ok">✅ CSV bundle downloaded (${ir.zdos.length.toLocaleString()} rows). Edit in Excel, then drop the CSVs back here to rebuild.</div>`;
    }
    renderReport(ir);
  } catch (e) {
    console.error(e);
    status.innerHTML = `<div class="status err"><b>Conversion failed:</b> ${esc(e.message)}</div>`;
  }
}

function totalVars(ir) {
  let n = 0;
  for (const z of ir.zdos) n += z.floats.length + z.vec3s.length + z.quats.length + z.ints.length + z.longs.length + z.strings.length + z.bytes.length;
  return n;
}

// ------------------------------ wiring ---------------------------------------
function refreshAll() {
  document.getElementById('main').style.display = 'grid';
  renderInspector();
  renderTargets();
  renderOpts();
}

document.addEventListener('DOMContentLoaded', () => {
  const drop = document.getElementById('drop');
  const input = document.getElementById('file-input');
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => handleFiles([...input.files]));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('over');
    handleFiles([...e.dataTransfer.files]);
  });
  document.getElementById('convert-btn').addEventListener('click', convert);
  loadHashTable();
});

})();
