'use strict';
// ============================================================================
// BFC extensions: Infinity Hammer DataEntry blobs, IH .blueprint flavor,
// container items codec, CSV bundle projection.
// Appended to codecs.js by the build; in node, require after codecs.js with
// the same scope (build concatenates; tests use requireExt()).
// ============================================================================
/* global getStableHashCode, H, shortestFloat32, invariantFloat, emptyIR, emptyZdo,
   sectorOf, normalizeQuat, b64decode, blueprintCodec, rewindCodec, vbuildCodec,
   pieceToZdo, zdoToPiece, BinReader, BinWriter, BFC */

function b64encode(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

// ----------------------------------------------------------------------------
// Infinity Hammer DataEntry blob (Jere Kuusela's Data library, ZPackage-based).
// Layout verified empirically against 6431 blobs in EichenwaldeTest.blueprint
// (exact-length parse on every blob):
//   int32 flags
//     1=floats 2=vec3s 4=quats 8=ints 16=strings 64=longs 128=byteArrays
//     512=persistent 1024=distant 2048=priority   (256/32: never observed)
//   sections in WRITE ORDER (differs from flag bit order!):
//     floats, vec3s, quats, ints, LONGS, STRINGS, byteArrays,
//     then persistent(byte), distant(byte), priority(byte)
//   counts: single byte; entries: hash i32 LE + value
//   strings: LEB128 len + UTF-8; byteArrays: i32 len + raw
// persistent/distant flags are emitted only when true; priority always.
// ----------------------------------------------------------------------------
const DE = { FLOATS: 1, VEC3S: 2, QUATS: 4, INTS: 8, STRINGS: 16, UNKNOWN32: 32, LONGS: 64, BYTES: 128, UNKNOWN256: 256, PERSISTENT: 512, DISTANT: 1024, PRIORITY: 2048 };

const dataEntryCodec = {
  // base64 string | Uint8Array -> entry object (bucket entries shaped like ZDO buckets)
  parse(input, opts = {}) {
    const bytes = typeof input === 'string' ? b64decode(input) : input;
    const r = new BinReader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const resolve = opts.hashResolver || (() => null);
    const de = { flags: r.i32(), floats: [], vec3s: [], quats: [], ints: [], longs: [], strings: [], bytes: [] };
    const nm = (e) => { const n = resolve(e.hash); if (n) e.name = n; return e; };
    const f = de.flags;
    if (f & ~(DE.FLOATS | DE.VEC3S | DE.QUATS | DE.INTS | DE.STRINGS | DE.LONGS | DE.BYTES | DE.PERSISTENT | DE.DISTANT | DE.PRIORITY))
      throw new Error(`DataEntry has unsupported flag bits (0x${(f >>> 0).toString(16)}); refusing to guess the layout`);
    if (f & DE.FLOATS) { const n = r.u8(); for (let i = 0; i < n; i++) de.floats.push(nm({ hash: r.i32(), value: r.f32() })); }
    if (f & DE.VEC3S)  { const n = r.u8(); for (let i = 0; i < n; i++) de.vec3s.push(nm({ hash: r.i32(), value: { x: r.f32(), y: r.f32(), z: r.f32() } })); }
    if (f & DE.QUATS)  { const n = r.u8(); for (let i = 0; i < n; i++) de.quats.push(nm({ hash: r.i32(), value: { x: r.f32(), y: r.f32(), z: r.f32(), w: r.f32() } })); }
    if (f & DE.INTS)   { const n = r.u8(); for (let i = 0; i < n; i++) de.ints.push(nm({ hash: r.i32(), value: r.i32() })); }
    if (f & DE.LONGS)  { const n = r.u8(); for (let i = 0; i < n; i++) de.longs.push(nm({ hash: r.i32(), value: r.i64() })); }
    if (f & DE.STRINGS){ const n = r.u8(); for (let i = 0; i < n; i++) de.strings.push(nm({ hash: r.i32(), value: r.str() })); }
    if (f & DE.BYTES)  { const n = r.u8(); for (let i = 0; i < n; i++) de.bytes.push(nm({ hash: r.i32(), value: r.bytesArr() })); }
    if (f & DE.PERSISTENT) de.persistent = r.bool();
    if (f & DE.DISTANT)    de.distant = r.bool();
    if (f & DE.PRIORITY)   de.priority = r.u8();
    if (r.off !== r.len) throw new Error(`DataEntry blob length mismatch: consumed ${r.off} of ${r.len} bytes`);
    return de;
  },

  // entry object -> base64. Emits flags from content; persistent/distant only when
  // truthy (matches the Infinity Hammer writer), priority whenever it is defined.
  serialize(de) {
    const w = new BinWriter();
    let flags = 0;
    const has = (a) => a && a.length > 0;
    if (has(de.floats)) flags |= DE.FLOATS;
    if (has(de.vec3s)) flags |= DE.VEC3S;
    if (has(de.quats)) flags |= DE.QUATS;
    if (has(de.ints)) flags |= DE.INTS;
    if (has(de.strings)) flags |= DE.STRINGS;
    if (has(de.longs)) flags |= DE.LONGS;
    if (has(de.bytes)) flags |= DE.BYTES;
    if (de.persistent) flags |= DE.PERSISTENT;
    if (de.distant) flags |= DE.DISTANT;
    if (de.priority !== undefined) flags |= DE.PRIORITY;
    w.i32(flags);
    const cnt = (a, label) => {
      if (a.length > 255) throw new Error(`DataEntry ${label} bucket has ${a.length} entries; format count is a single byte`);
      w.u8(a.length);
    };
    if (has(de.floats)) { cnt(de.floats, 'float'); for (const e of de.floats) { w.i32(e.hash); w.f32(e.value); } }
    if (has(de.vec3s))  { cnt(de.vec3s, 'vec3');  for (const e of de.vec3s) { w.i32(e.hash); w.f32(e.value.x); w.f32(e.value.y); w.f32(e.value.z); } }
    if (has(de.quats))  { cnt(de.quats, 'quat');  for (const e of de.quats) { w.i32(e.hash); w.f32(e.value.x); w.f32(e.value.y); w.f32(e.value.z); w.f32(e.value.w); } }
    if (has(de.ints))   { cnt(de.ints, 'int');    for (const e of de.ints) { w.i32(e.hash); w.i32(e.value); } }
    if (has(de.longs))  { cnt(de.longs, 'long');  for (const e of de.longs) { w.i32(e.hash); w.i64(e.value); } }
    if (has(de.strings)){ cnt(de.strings, 'string'); for (const e of de.strings) { w.i32(e.hash); w.str(e.value); } }
    if (has(de.bytes))  { cnt(de.bytes, 'bytes'); for (const e of de.bytes) { w.i32(e.hash); w.bytesArr(e.value); } }
    if (de.persistent) w.bool(true);
    if (de.distant) w.bool(true);
    if (de.priority !== undefined) w.u8(de.priority);
    return b64encode(new Uint8Array(w.toBuffer()));
  },
};

// ----------------------------------------------------------------------------
// Infinity Hammer Blueprint.Center('') emulation (see Blueprint.cs).
// Quirks preserved deliberately:
//   - Unity `new Bounds()` starts at the origin, so (0,0,0) is always inside
//     the encapsulated bounds -> XZ center is pulled toward the origin when
//     the pieces don't straddle it.
//   - Y is the minimum piece Y (objects only, origin NOT included).
//   - A piece matching centerPiece overrides: center = its pos, and the
//     inverse of its rotation is applied to everything.
// Returns {center:{x,y,z}, rot:{x,y,z,w}|null}.
// ----------------------------------------------------------------------------
function ihCenter(pieces, centerPiece = '', includeOrigin = true) {
  if (pieces.length === 0) return { center: { x: 0, y: 0, z: 0 }, rot: null };
  // includeOrigin replicates Unity's `new Bounds()` starting at (0,0,0) — the
  // loader's recompute path. The writer centers by the TRUE bbox instead, so
  // that the loader's origin-augmented recompute still comes out exactly zero
  // (a truly centered build always straddles the origin).
  let minX = includeOrigin ? 0 : Infinity, maxX = includeOrigin ? 0 : -Infinity;
  let minZ = includeOrigin ? 0 : Infinity, maxZ = includeOrigin ? 0 : -Infinity;
  let minY = Infinity;
  for (const p of pieces) {
    minX = Math.min(minX, p.pos.x); maxX = Math.max(maxX, p.pos.x);
    minZ = Math.min(minZ, p.pos.z); maxZ = Math.max(maxZ, p.pos.z);
    minY = Math.min(minY, p.pos.y);
  }
  let center = { x: (minX + maxX) / 2, y: minY, z: (minZ + maxZ) / 2 };
  let rot = null;
  if (centerPiece) {
    const c = pieces.find(p => p.name === centerPiece);
    if (c) { center = { ...c.pos }; rot = quatInverse(c.rot); }
  }
  return { center, rot };
}
function quatInverse(q) { return { x: -q.x, y: -q.y, z: -q.z, w: q.w }; }
function quatRotate(q, v) { // q * v
  const { x, y, z, w } = q;
  const ix = w * v.x + y * v.z - z * v.y, iy = w * v.y + z * v.x - x * v.z,
        iz = w * v.z + x * v.y - y * v.x, iw = -x * v.x - y * v.y - z * v.z;
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x,
  };
}
function quatMul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

// GetExtraInfo emulation (HammerSave.cs): purely cosmetic display string.
function ihExtraInfo(z) {
  const find = (arr, name) => arr.find(e => e.hash === getStableHashCode(name));
  let info = '';
  const text = find(z.strings, 'text'); if (text) info = text.value;
  const tamed = find(z.strings, 'TamedName'); if (tamed) info = tamed.value;
  const tag = find(z.strings, 'tag'); if (tag) info = tag.value;
  const item = find(z.strings, 'item');
  if (item) {
    const v = find(z.ints, 'variant');
    info = v && v.value !== 0 ? `${item.value}:${v.value}` : item.value;
  }
  const pose = find(z.ints, 'pose');
  const slot0 = find(z.strings, '0_item');
  if (pose && slot0) { // armor stand approximation from ZDO vars
    const slots = [];
    for (let j = 0; ; j++) {
      const si = find(z.strings, `${j}_item`);
      if (!si) break;
      const sv = find(z.ints, `${j}_variant`);
      slots.push(`${si.value}:${sv ? sv.value : 0}`);
    }
    info = `${pose.value}:${slots.length}:${slots.join(':')}`;
  }
  return info;
}

// ----------------------------------------------------------------------------
// IH blueprint flavor: parse + serialize on top of the shared line grammar.
// ----------------------------------------------------------------------------
function parseXZY(s) { // HammerHelper.PrintXZY writes x,z,y
  const p = s.split(',').map(t => invariantFloat(t.trim()));
  return { x: p[0] || 0, y: p[2] || 0, z: p[1] || 0 };
}
function printXZY(v) { return `${shortestFloat32(v.x)},${shortestFloat32(v.z)},${shortestFloat32(v.y)}`; }

// Parse an IH-or-PlanBuild blueprint. Detects flavor; when a piece line carries
// a 14th data field, the DataEntry blob populates the ZDO buckets outright and
// additionalInfo detection is skipped for that piece.
function parseBlueprintUnified(text, opts = {}) {
  const resolve = opts.hashResolver || (() => null);
  const ir = emptyIR('blueprint');
  const rep = ir.reports;
  let section = 'pieces';
  let coordinates = null, rotationHdr = null, centerPiece = '';
  const rawPieces = [];
  // A piece line is standalone-valid if it has a name and numeric pos/rot.
  // Infinity Hammer's writer emits raw sign text into the info field, so a
  // newline inside sign text splits one piece across several lines; heal by
  // rejoining continuations (empty name / non-numeric transform) with '\n'.
  const validPieceLine = (l) => {
    const p = l.split(';');
    if (p.length < 9 || !p[0]) return false;
    for (let i = 2; i <= 8; i++) if (p[i] === undefined || p[i] === '' || !Number.isFinite(invariantFloat(p[i], NaN))) return false;
    return true;
  };
  const pieceLines = [];
  let healed = 0;
  for (let rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const low = line.toLowerCase();
    if (line.startsWith('#') && !/^#0x[0-9A-Fa-f]+;/.test(line)) {
      if (low.startsWith('#name:')) ir.meta.name = line.slice(6);
      else if (low.startsWith('#creator:')) ir.meta.creator = line.slice(9);
      else if (low.startsWith('#description:')) {
        const d = line.slice(13);
        ir.meta.description = (d.startsWith('"') && d.endsWith('"')) ? jsonDecodeMaybe(d) : d;
      }
      else if (low.startsWith('#category:')) ir.meta.category = line.slice(10);
      else if (low.startsWith('#center:')) { centerPiece = line.slice(8); }
      else if (low.startsWith('#coordinates:')) coordinates = parseXZY(line.slice(13));
      else if (low.startsWith('#rotation:')) rotationHdr = parseXZY(line.slice(10));
      else if (low.startsWith('#snappoints')) section = 'snap';
      else if (low.startsWith('#terrain')) section = 'terrain';
      else if (low.startsWith('#pieces')) section = 'pieces';
      else if (low.startsWith('#height') || low.startsWith('#paint')) {
        section = 'ihterrain';
        rep.warnings.push('Infinity Hammer #Height/#Paint terrain data is not converted (dropped)');
      }
      continue;
    }
    let l = line;
    if (l.includes(',') && !l.includes('.') && section !== 'ihterrain') { l = l.replace(/,/g, '.'); rep.warnings.push('Legacy comma decimal separators repaired on one line'); }
    if (section === 'snap') {
      const p = l.split(';');
      ir.snapPoints.push({ x: invariantFloat(p[0]), y: invariantFloat(p[1]), z: invariantFloat(p[2]) });
    } else if (section === 'terrain') {
      ir.terrainMods.push(l);
    } else if (section === 'pieces') {
      if (!validPieceLine(l) && pieceLines.length) { pieceLines[pieceLines.length - 1] += '\n' + l; healed++; }
      else pieceLines.push(l);
    }
  }
  if (healed) rep.warnings.push(`Healed ${healed} piece line(s) split by raw newlines in sign text (Infinity Hammer writer quirk)`);
  for (const l of pieceLines) {
    const p = l.split(';');
    rawPieces.push({
      name: p[0], category: p[1] || '',
      pos: { x: invariantFloat(p[2]), y: invariantFloat(p[3]), z: invariantFloat(p[4]) },
      rot: normalizeQuat({ x: invariantFloat(p[5]), y: invariantFloat(p[6]), z: invariantFloat(p[7]), w: invariantFloat(p[8], 1) }),
      additionalInfo: p.length > 9 ? p[9] : '',
      scale: { x: invariantFloat(p[10], 1), y: invariantFloat(p[11], 1), z: invariantFloat(p[12], 1) },
      data: p.length > 13 ? p[13] : '',
      chance: invariantFloat(p[14], 1),
    });
  }
  const hasData = rawPieces.some(p => p.data);
  const flavor = (hasData || coordinates !== null) ? 'infinityhammer' : 'planbuild';
  ir.meta.blueprintFlavor = flavor;
  ir.meta.ihCoordinates = coordinates;
  ir.meta.ihRotation = rotationHdr;
  ir.meta.ihCenterPiece = centerPiece;

  // Absolute anchoring: replicate what hammer_restore does — Center('') is
  // re-run on load, then the ghost is placed at #Coordinates.
  let shift = { x: 0, y: 0, z: 0 }, crot = null;
  if (coordinates) {
    const c = ihCenter(rawPieces, centerPiece);
    shift = c.center; crot = c.rot;
  }
  let index = 0;
  for (const pc of rawPieces) {
    let pos = { x: pc.pos.x - shift.x, y: pc.pos.y - shift.y, z: pc.pos.z - shift.z };
    let rot = pc.rot;
    if (crot) { pos = quatRotate(crot, pos); rot = normalizeQuat(quatMul(crot, rot)); }
    if (coordinates) pos = { x: pos.x + coordinates.x, y: pos.y + coordinates.y, z: pos.z + coordinates.z };
    const sentinel = /^#0x([0-9A-Fa-f]+)$/.exec(pc.name);
    let z;
    if (pc.data) {
      let de;
      try { de = dataEntryCodec.parse(pc.data, { hashResolver: resolve }); }
      catch (e) {
        rep.warnings.push(`Piece ${index} (${pc.name}): unreadable data blob (${e.message}); fell back to additionalInfo`);
        de = null;
      }
      if (de) {
        z = emptyZdo();
        if (sentinel) { z.prefabName = null; z.prefabHash = parseInt(sentinel[1], 16) | 0; }
        else { z.prefabName = pc.name; z.prefabHash = getStableHashCode(pc.name); }
        z.floats = de.floats; z.vec3s = de.vec3s; z.quats = de.quats;
        z.ints = de.ints; z.longs = de.longs; z.strings = de.strings; z.bytes = de.bytes;
        z.persistent = de.persistent === true;               // absent => writer saw false
        z.distant = de.distant === true;
        z.type = de.priority !== undefined ? de.priority : 0;
        z._addInfoKind = 'ih-data';
      }
    }
    if (!z) {
      z = pieceToZdo(pc, index, rep, opts.overrides || {});
      if (sentinel) { z.prefabName = null; z.prefabHash = parseInt(sentinel[1], 16) | 0; }
      z.type = 2; // Solid default for plain build pieces; game self-corrects anyway
    }
    z.uidUser = 0n; z.uidId = index + 1;
    z.pos = { x: Math.fround(pos.x), y: Math.fround(pos.y), z: Math.fround(pos.z) };
    z.rot = rot;
    [z.sectorX, z.sectorY] = sectorOf(z.pos.x, z.pos.z);
    // line scale -> vars, unless the blob already carries scale
    const hasScaleVar = z.vec3s.some(e => e.hash === H.scale) || z.floats.some(e => e.hash === H.scaleScalar);
    const s = pc.scale;
    if (!hasScaleVar && !(s.x === 1 && s.y === 1 && s.z === 1)) {
      if (Math.abs(s.x - s.y) < 1e-6 && Math.abs(s.x - s.z) < 1e-6)
        z.floats.push({ hash: H.scaleScalar, name: 'scaleScalar', value: Math.fround(s.x) });
      else
        z.vec3s.push({ hash: H.scale, name: 'scale', value: { x: Math.fround(s.x), y: Math.fround(s.y), z: Math.fround(s.z) } });
    }
    z._category = pc.category;
    z._chance = pc.chance;
    ir.zdos.push(z);
    index++;
  }
  // Snap points and origin follow the same anchoring
  if (coordinates) {
    ir.snapPoints = ir.snapPoints.map(sp => {
      let p = { x: sp.x - shift.x, y: sp.y - shift.y, z: sp.z - shift.z };
      if (crot) p = quatRotate(crot, p);
      return { x: p.x + coordinates.x, y: p.y + coordinates.y, z: p.z + coordinates.z };
    });
    ir.meta.origin = { ...coordinates };
  }
  return ir;
}

// Serialize IR -> Infinity Hammer flavored .blueprint.
// Pieces are emitted pre-centered (so the loader's Center('') recompute is a
// no-op) with #Coordinates = the absolute center, which makes hammer_restore
// reproduce the original world positions exactly.
function serializeIHBlueprint(ir, opts = {}) {
  const rep = opts.reports || ir.reports;
  const includeData = opts.includeData !== false;
  const pieces = [];
  for (const z of ir.zdos) {
    let name = z.prefabName;
    if (name == null || name.startsWith('#0x')) {
      if (opts.unresolvedPolicy === 'emit') {
        name = name ?? ('#0x' + (z.prefabHash >>> 0).toString(16).toUpperCase());
        rep.warnings.push(`Unresolved prefab hash ${z.prefabHash} emitted as ${name} (will not place in-game)`);
      } else {
        rep.losses.push({ kind: 'zdo-skipped-unresolved', prefabHash: z.prefabHash, count: 1 });
        continue;
      }
    }
    // scale: prefer explicit vars, mirror onto the line like the live game state
    let scale = { x: 1, y: 1, z: 1 };
    const v = z.vec3s.find(e => e.hash === H.scale);
    const f = z.floats.find(e => e.hash === H.scaleScalar);
    if (v) scale = { ...v.value }; else if (f) scale = { x: f.value, y: f.value, z: f.value };
    pieces.push({ name, pos: { ...z.pos }, rot: z.rot, scale, z });
  }
  const { center } = ihCenter(pieces, '', false); // true bbox: see note in ihCenter
  const fr = Math.fround;
  const lines = [];
  lines.push(`#Name:${ir.meta.name ?? ''}`);
  lines.push(`#Creator:${ir.meta.creator ?? ''}`);
  lines.push(`#Description:${ir.meta.description ?? ''}`);
  lines.push(`#Category:${ir.meta.category ?? 'InfinityHammer'}`);
  lines.push('#Center:');
  lines.push(`#Coordinates:${printXZY({ x: fr(center.x), y: fr(center.y), z: fr(center.z) })}`);
  lines.push('#Rotation:0,0,0');
  lines.push('#SnapPoints');
  for (const sp of ir.snapPoints)
    lines.push([sp.x - center.x, sp.y - center.y, sp.z - center.z].map(x => shortestFloat32(fr(x))).join(';'));
  lines.push('#Pieces');
  pieces.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  let dataCount = 0;
  for (const p of pieces) {
    const z = p.z;
    let data = '';
    if (includeData) {
      const de = {
        floats: z.floats, vec3s: z.vec3s, quats: z.quats, ints: z.ints,
        longs: z.longs, strings: z.strings, bytes: z.bytes,
        persistent: z.persistent, distant: z.distant, priority: z.type,
      };
      data = dataEntryCodec.serialize(de);
      dataCount++;
    }
    const info = ihExtraInfo(z);
    const cells = [
      p.name, '',
      shortestFloat32(fr(p.pos.x - center.x)), shortestFloat32(fr(p.pos.y - center.y)), shortestFloat32(fr(p.pos.z - center.z)),
      shortestFloat32(p.rot.x), shortestFloat32(p.rot.y), shortestFloat32(p.rot.z), shortestFloat32(p.rot.w),
      info.replace(/;/g, ',').replace(/[\r\n]+/g, ' '),
      shortestFloat32(fr(p.scale.x)), shortestFloat32(fr(p.scale.y)), shortestFloat32(fr(p.scale.z)),
      data,
    ];
    if (z._chance !== undefined && z._chance !== 1) cells.push(shortestFloat32(z._chance));
    lines.push(cells.join(';'));
  }
  if (includeData) rep.warnings.push(`Emitted full ZDO data blocks for ${dataCount} pieces (Infinity Hammer extended format)`);
  return lines.join('\n') + '\n';
}

// ----------------------------------------------------------------------------
// Container items (Inventory.Save format v106) — lifted from the proven
// rewind-converter implementation, on BinReader/BinWriter.
// ----------------------------------------------------------------------------
const containerItemsCodec = {
  parse(base64Str) {
    const bytes = b64decode(base64Str);
    const r = new BinReader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const formatVersion = r.i32();
    if (formatVersion !== 106) return { formatVersion, items: [], unknown: true };
    const n = r.i32();
    const items = [];
    for (let i = 0; i < n; i++) {
      const item = {
        prefabName: r.str(), stack: r.i32(), durability: r.f32(),
        gridX: r.i32(), gridY: r.i32(), equipped: r.bool(),
        quality: r.i32(), variant: r.i32(), crafterID: r.i64(), crafterName: r.str(),
        customData: [],
      };
      const cd = r.i32();
      for (let j = 0; j < cd; j++) item.customData.push({ key: r.str(), value: r.str() });
      item.worldLevel = r.i32();
      item.pickedUp = r.bool();
      items.push(item);
    }
    return { formatVersion, items };
  },
  serialize(items) {
    const w = new BinWriter();
    w.i32(106); w.i32(items.length);
    for (const it of items) {
      w.str(it.prefabName); w.i32(it.stack || 0); w.f32(it.durability || 0);
      w.i32(it.gridX || 0); w.i32(it.gridY || 0); w.bool(!!it.equipped);
      w.i32(it.quality || 0); w.i32(it.variant || 0); w.i64(BigInt(it.crafterID || 0)); w.str(it.crafterName || '');
      const cd = it.customData || [];
      w.i32(cd.length);
      for (const c of cd) { w.str(c.key); w.str(c.value); }
      w.i32(it.worldLevel || 0); w.bool(!!it.pickedUp);
    }
    return b64encode(new Uint8Array(w.toBuffer()));
  },
};

// ----------------------------------------------------------------------------
// CSV bundle projection (meta.csv + zdos.csv + items.csv), column-compatible
// with the original Rewind2csv tool so existing spreadsheets keep working.
// Fixes the original's long-precision bug: longs stay BigInt end to end.
// ----------------------------------------------------------------------------
const CSV_TYPE_NAMES = ['Default', 'Prioritized', 'Solid', 'Terrain'];
function escapeCSV(s) {
  s = String(s ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function parseCSVText(text) {
  const rows = []; let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.length > 1 || row[0] !== '') rows.push(row); }
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0];
  return { headers, rows: rows.slice(1).map(cells => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']))) };
}
function serializeBucketCell(entries, type, resolve) {
  if (!entries || !entries.length) return '';
  const parts = [];
  for (const e of entries) {
    const name = e.name ?? resolve(e.hash) ?? String(e.hash);
    let val;
    switch (type) {
      case 'float': val = shortestFloat32(e.value); break;
      case 'int': val = String(e.value); break;
      case 'long': val = e.value.toString(); break;
      case 'vec3': val = JSON.stringify({ x: +shortestFloat32(e.value.x), y: +shortestFloat32(e.value.y), z: +shortestFloat32(e.value.z) }); break;
      case 'quat': val = JSON.stringify({ x: +shortestFloat32(e.value.x), y: +shortestFloat32(e.value.y), z: +shortestFloat32(e.value.z), w: +shortestFloat32(e.value.w) }); break;
      case 'string': val = JSON.stringify(e.value); break;
      case 'bytes': val = b64encode(e.value); break;
    }
    parts.push(`${name}=${val}`);
  }
  return parts.join('; ');
}
function deserializeBucketCell(str, type, toHash) {
  if (!str || !str.trim()) return [];
  const entries = []; let i = 0;
  const len = str.length;
  while (i < len) {
    while (i < len && (str[i] === ' ' || str[i] === '\t')) i++;
    if (i >= len) break;
    const keyStart = i;
    while (i < len && str[i] !== '=') i++;
    if (i >= len) break;
    const key = str.substring(keyStart, i).trim(); i++;
    let inStr = false, depth = 0;
    const valStart = i;
    while (i < len) {
      const ch = str[i];
      if (inStr) { if (ch === '\\') { i += 2; continue; } if (ch === '"') inStr = false; }
      else {
        if (ch === '"') inStr = true;
        else if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') depth--;
        else if (ch === ';' && depth === 0) break;
      }
      i++;
    }
    const rawVal = str.substring(valStart, i).trim();
    if (i < len && str[i] === ';') i++;
    if (!key || !rawVal) continue;
    const hash = toHash(key);
    switch (type) {
      case 'float': entries.push({ hash, value: Math.fround(invariantFloat(rawVal)) }); break;
      case 'int': entries.push({ hash, value: parseInt(rawVal, 10) | 0 }); break;
      case 'long': entries.push({ hash, value: BigInt(rawVal) }); break;
      case 'vec3': { const o = JSON.parse(rawVal); entries.push({ hash, value: { x: Math.fround(o.x), y: Math.fround(o.y), z: Math.fround(o.z) } }); break; }
      case 'quat': { const o = JSON.parse(rawVal); entries.push({ hash, value: { x: Math.fround(o.x), y: Math.fround(o.y), z: Math.fround(o.z), w: Math.fround(o.w) } }); break; }
      case 'string': entries.push({ hash, value: String(JSON.parse(rawVal)) }); break;
      case 'bytes': entries.push({ hash, value: b64decode(rawVal) }); break;
    }
  }
  return entries;
}
const CSV_BUCKETS = [['floats', 'float'], ['vec3s', 'vec3'], ['quats', 'quat'], ['ints', 'int'], ['longs', 'long'], ['strings', 'string'], ['bytes', 'bytes']];

const csvBundleCodec = {
  // IR -> { 'name.meta.csv': text, 'name.zdos.csv': text, 'name.items.csv': text }
  serialize(ir, opts = {}) {
    const resolve = opts.hashResolver || ((h) => null);
    const rname = (h) => resolve(h) ?? String(h);
    const m = ir.meta;
    const metaCSV = 'version,origin_x,origin_y,origin_z,source_format,name,creator,description,category\n'
      + [m.rewindVersion, m.origin.x, m.origin.y, m.origin.z, m.sourceFormat,
         escapeCSV(m.name ?? ''), escapeCSV(m.creator ?? ''), escapeCSV(m.description ?? ''), escapeCSV(m.category ?? '')].join(',') + '\n';
    const fixedCols = ['row_id', 'persistent', 'distant', 'type', 'prefab', 'pos_x', 'pos_y', 'pos_z', 'rot_x', 'rot_y', 'rot_z', 'rot_w', 'has_items'];
    const allCols = [...fixedCols, ...CSV_BUCKETS.map(b => b[0])];
    let zdosCSV = allCols.join(',') + '\n';
    const itemsByZdo = [];
    ir.zdos.forEach((z, ri) => {
      const itemStr = z.strings.find(s => s.hash === H.items);
      const row = {
        row_id: ri + 1,
        persistent: z.persistent ? '1' : '0',
        distant: z.distant ? '1' : '0',
        type: CSV_TYPE_NAMES[z.type] ?? String(z.type),
        prefab: z.prefabName ?? String(z.prefabHash),
        pos_x: shortestFloat32(z.pos.x), pos_y: shortestFloat32(z.pos.y), pos_z: shortestFloat32(z.pos.z),
        rot_x: shortestFloat32(z.rot.x), rot_y: shortestFloat32(z.rot.y), rot_z: shortestFloat32(z.rot.z), rot_w: shortestFloat32(z.rot.w),
        has_items: itemStr ? 'true' : 'false',
      };
      for (const [bucket, type] of CSV_BUCKETS) {
        const src = bucket === 'strings' ? z.strings.filter(s => s.hash !== H.items) : z[bucket];
        row[bucket] = serializeBucketCell(src, type, rname);
      }
      zdosCSV += allCols.map(h => escapeCSV(row[h])).join(',') + '\n';
      if (itemStr) {
        const parsed = containerItemsCodec.parse(itemStr.value);
        if (!parsed.unknown) itemsByZdo.push({ zdoIdx: ri, items: parsed.items });
      }
    });
    const customKeys = new Set();
    for (const e of itemsByZdo) for (const it of e.items) for (const cd of it.customData) customKeys.add(cd.key);
    const itemFixed = ['zdo_row_id', 'grid_x', 'grid_y', 'prefab', 'stack', 'durability', 'equipped', 'quality', 'variant', 'crafter_id', 'crafter_name', 'world_level', 'picked_up'];
    const itemCols = [...itemFixed, ...[...customKeys].sort().map(k => `itemdata:${k}`)];
    let itemsCSV = itemCols.join(',') + '\n';
    for (const e of itemsByZdo) {
      for (const it of e.items) {
        const row = {
          zdo_row_id: e.zdoIdx + 1, grid_x: it.gridX, grid_y: it.gridY, prefab: it.prefabName,
          stack: it.stack, durability: shortestFloat32(it.durability), equipped: it.equipped ? '1' : '0',
          quality: it.quality, variant: it.variant, crafter_id: it.crafterID.toString(), crafter_name: it.crafterName,
          world_level: it.worldLevel, picked_up: it.pickedUp ? '1' : '0',
        };
        for (const cd of it.customData) row[`itemdata:${cd.key}`] = cd.value;
        itemsCSV += itemCols.map(h => escapeCSV(row[h] !== undefined ? row[h] : '')).join(',') + '\n';
      }
    }
    return { metaCSV, zdosCSV, itemsCSV };
  },

  // { metaText, zdosText, itemsText } -> IR (+ errors on ir.reports.errors)
  parse(texts, opts = {}) {
    const toHash = opts.nameToHash || ((k) => /^-?\d+$/.test(k) ? parseInt(k, 10) | 0 : getStableHashCode(k));
    const ir = emptyIR('csv');
    ir.reports.errors = [];
    const err = (where, ri, msg) => ir.reports.errors.push({ where, row: ri, msg });
    const meta = parseCSVText(texts.metaText || '');
    if (meta.rows.length) {
      const r = meta.rows[0];
      ir.meta.rewindVersion = parseInt(r.version, 10) || 29;
      ir.meta.origin = { x: invariantFloat(r.origin_x), y: invariantFloat(r.origin_y), z: invariantFloat(r.origin_z) };
      if (r.name !== undefined) { ir.meta.name = r.name || null; ir.meta.creator = r.creator || null; ir.meta.description = r.description || null; ir.meta.category = r.category || null; }
    } else ir.reports.warnings.push('meta.csv empty — defaults used (version=29, origin 0,0,0)');
    const zdos = parseCSVText(texts.zdosText || '');
    if (!zdos.rows.length) { err('zdos.csv', 0, 'no data rows'); return ir; }
    const items = texts.itemsText ? parseCSVText(texts.itemsText) : { headers: [], rows: [] };
    const itemsByRow = new Map();
    items.rows.forEach((r, ri) => {
      const id = parseInt(r.zdo_row_id, 10);
      if (!Number.isFinite(id)) { err('items.csv', ri + 2, 'invalid zdo_row_id'); return; }
      if (!itemsByRow.has(id)) itemsByRow.set(id, []);
      const item = {
        prefabName: r.prefab, stack: parseInt(r.stack, 10) || 0, durability: invariantFloat(r.durability),
        gridX: parseInt(r.grid_x, 10) || 0, gridY: parseInt(r.grid_y, 10) || 0,
        equipped: r.equipped === '1' || r.equipped === 'true', quality: parseInt(r.quality, 10) || 0,
        variant: parseInt(r.variant, 10) || 0, crafterID: BigInt(r.crafter_id || 0), crafterName: r.crafter_name || '',
        worldLevel: parseInt(r.world_level, 10) || 0, pickedUp: r.picked_up === '1' || r.picked_up === 'true',
        customData: [],
      };
      for (const h of items.headers) if (h.startsWith('itemdata:') && r[h] !== '' && r[h] !== undefined)
        item.customData.push({ key: h.slice(9), value: r[h] });
      itemsByRow.get(id).push(item);
    });
    zdos.rows.forEach((r, ri) => {
      const z = emptyZdo();
      const rowId = parseInt(r.row_id, 10) || (ri + 1);
      z.uidUser = 0n; z.uidId = rowId;
      z.persistent = r.persistent === '1' || r.persistent === 'true';
      z.distant = r.distant === '1' || r.distant === 'true';
      z.type = CSV_TYPE_NAMES.indexOf(r.type) >= 0 ? CSV_TYPE_NAMES.indexOf(r.type) : (parseInt(r.type, 10) || 0);
      z.prefabName = /^-?\d+$/.test(r.prefab) ? null : r.prefab;
      z.prefabHash = toHash(r.prefab);
      z.pos = { x: Math.fround(invariantFloat(r.pos_x)), y: Math.fround(invariantFloat(r.pos_y)), z: Math.fround(invariantFloat(r.pos_z)) };
      z.rot = normalizeQuat({ x: invariantFloat(r.rot_x), y: invariantFloat(r.rot_y), z: invariantFloat(r.rot_z), w: invariantFloat(r.rot_w, 1) });
      [z.sectorX, z.sectorY] = sectorOf(z.pos.x, z.pos.z);
      for (const [bucket, type] of CSV_BUCKETS) {
        try { z[bucket] = deserializeBucketCell(r[bucket], type, toHash); }
        catch (e) { err('zdos.csv', ri + 2, `${bucket}: ${e.message}`); z[bucket] = []; }
      }
      const zItems = itemsByRow.get(rowId);
      if (zItems) z.strings.push({ hash: H.items, name: 'items', value: containerItemsCodec.serialize(zItems) });
      else if (r.has_items === 'true') ir.reports.warnings.push(`row ${rowId}: has_items=true but no items.csv rows — container emitted empty`);
      ir.zdos.push(z);
    });
    for (const id of itemsByRow.keys())
      if (id < 1 || id > zdos.rows.length) err('items.csv', 0, `zdo_row_id ${id} does not exist in zdos.csv`);
    return ir;
  },
};

// Extend the public API
BFC.dataEntryCodec = dataEntryCodec;
BFC.containerItemsCodec = containerItemsCodec;
BFC.csvBundleCodec = csvBundleCodec;
BFC.parseBlueprintUnified = parseBlueprintUnified;
BFC.serializeIHBlueprint = serializeIHBlueprint;
BFC.ihCenter = ihCenter;
BFC.ihExtraInfo = ihExtraInfo;
BFC.parseCSVText = parseCSVText;
BFC.escapeCSV = escapeCSV;
BFC.b64encode = b64encode;
