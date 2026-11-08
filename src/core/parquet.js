'use strict';
// Parquet reading with range reads only: the footer first, then row blocks on demand. Never reads the whole file.
// Runs in the worker thread (and in tests). No VS Code here.

const fs = require('fs');
const F = require('./format');

const MB = 1024 * 1024;
const BLOCK_ROWS = 2000; // rows per cached block
const CACHE_CELLS = 1500000; // about this many cells stay decoded in memory
const BATCH_BYTES = 192 * MB; // a block read of a big row group without an offset index goes in column batches of this size

let mods = null;
async function lib() {
  if (!mods) {
    const hp = await import('hyparquet');
    const c = await import('hyparquet-compressors');
    mods = { hp, compressors: c.compressors };
  }
  return mods;
}

class ParquetError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Random-access reader over a file. Counts the bytes it reads (tests check that a big file is not read whole). */
async function openFile(p) {
  const fh = await fs.promises.open(p, 'r');
  const { size } = await fh.stat();
  const file = {
    byteLength: size,
    bytesRead: 0,
    async slice(start, end) {
      const e = Math.min(end === undefined ? size : end, size);
      const s = Math.max(0, start);
      const len = Math.max(0, e - s);
      const buf = Buffer.allocUnsafeSlow(len);
      let off = 0;
      while (off < len) {
        const { bytesRead } = await fh.read(buf, off, len - off, s + off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      file.bytesRead += off;
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + off);
    },
  };
  return { file, close: () => fh.close().catch(() => {}) };
}

/** Bytes-only reader (tests, virtual file systems). */
function bytesFile(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const file = { byteLength: b.byteLength, bytesRead: 0, async slice(s, e) { const out = b.slice(s, e === undefined ? b.byteLength : e); file.bytesRead += out.byteLength; return out.buffer; } };
  return { file, close: async () => {} };
}

const ascii = buf => String.fromCharCode(...new Uint8Array(buf));

/** Checks the magic bytes and the footer length before hyparquet sees the file. Throws a ParquetError with a clear message. */
async function checkEnvelope(file, maxFooterMB) {
  const size = file.byteLength;
  if (size === 0) throw new ParquetError('EMPTY', 'This file is empty (0 bytes). There is nothing to show.');
  const head = ascii(await file.slice(0, Math.min(8, size)));
  if (size < 12) {
    throw new ParquetError('TOO_SHORT', `This file is only ${size} bytes. A Parquet file has at least 12 bytes ("PAR1" at the start and at the end), so it is empty or cut off.`);
  }
  const tail = new Uint8Array(await file.slice(size - 8, size));
  const tailMagic = String.fromCharCode(...tail.slice(4));
  if (tailMagic === 'PARE') {
    throw new ParquetError('ENCRYPTED', 'This Parquet file is encrypted (Parquet Modular Encryption, encrypted footer). It can only be read with its decryption keys, which this viewer does not ask for. The file itself is fine.');
  }
  if (tailMagic !== 'PAR1') {
    if (head.startsWith('PAR1')) {
      throw new ParquetError('TRUNCATED', 'The end of this Parquet file is missing: it starts with "PAR1" but has no footer. It was probably cut off by an interrupted download, copy or write, or a program is still writing it. Copy it again from the source.');
    }
    throw new ParquetError('NOT_PARQUET', `This is not a Parquet file: it does not start or end with "PAR1".${sniff(head)}`);
  }
  const footerLen = new DataView(tail.buffer).getUint32(0, true);
  if (footerLen === 0 || footerLen > size - 12) {
    throw new ParquetError('BAD_FOOTER', `The footer of this file says its metadata is ${F.fmtBytes(footerLen)} long, but the file is only ${F.fmtBytes(size)}. The file is damaged or cut off.`);
  }
  if (footerLen > maxFooterMB * MB) {
    throw new ParquetError('FOOTER_TOO_LARGE', `The metadata (footer) of this file is ${F.fmtBytes(footerLen)}. The limit is ${maxFooterMB} MB (setting parquetViewer.maxFooterMB).`);
  }
  if (!head.startsWith('PAR1')) {
    // Valid footer but no leading magic: hyparquet does not need it, so carry on.
  }
  return footerLen;
}

function sniff(head) {
  if (head.startsWith('ORC')) return ' It looks like an ORC file.';
  if (head.startsWith('Obj\u0001')) return ' It looks like an Avro file.';
  if (head.startsWith('ARROW1')) return ' It looks like an Arrow IPC (Feather) file.';
  if (head.startsWith('PK')) return ' It looks like a ZIP archive.';
  if (head.startsWith('\u001f\u008b')) return ' It looks like a gzip file. Unzip it first.';
  if (/^[\x09\x0a\x0d\x20-\x7e]{6,}$/.test(head)) return ' It looks like a text file.';
  return '';
}

// ---------- schema and types ----------

function logicalText(el) {
  const lt = el.logical_type;
  if (lt && lt.type) {
    const extra = [];
    if (lt.unit) extra.push(String(lt.unit).toLowerCase());
    if (lt.isAdjustedToUTC !== undefined) extra.push(lt.isAdjustedToUTC ? 'UTC' : 'local');
    if (lt.precision !== undefined) extra.push(`${lt.precision},${lt.scale ?? 0}`);
    if (lt.bitWidth !== undefined) extra.push(`${lt.isSigned === false ? 'u' : ''}int${lt.bitWidth}`);
    return extra.length ? `${lt.type}(${extra.join(', ')})` : lt.type;
  }
  if (el.converted_type === 'DECIMAL') return `DECIMAL(${el.precision ?? '?'},${el.scale ?? 0})`;
  return el.converted_type || '';
}

/** Kind of a top-level column for the grid: int, float, decimal, string, bool, date, time, timestamp, binary, json, list, map, struct. */
function columnKind(node) {
  const el = node.element;
  const lt = (el.logical_type && el.logical_type.type) || el.converted_type || '';
  if (node.children && node.children.length) {
    if (lt === 'LIST') return 'list';
    if (lt === 'MAP' || lt === 'MAP_KEY_VALUE') return 'map';
    return 'struct';
  }
  if (el.repetition_type === 'REPEATED') return 'list';
  switch (lt) {
    case 'STRING': case 'UTF8': case 'ENUM': case 'UUID': return 'string';
    case 'JSON': case 'BSON': return 'json';
    case 'DATE': return 'date';
    case 'TIMESTAMP': case 'TIMESTAMP_MILLIS': case 'TIMESTAMP_MICROS': return 'timestamp';
    case 'TIME': case 'TIME_MILLIS': case 'TIME_MICROS': return 'time';
    case 'DECIMAL': return 'decimal';
    case 'INTERVAL': return 'string';
    case 'INTEGER': case 'INT_8': case 'INT_16': case 'INT_32': case 'INT_64':
    case 'UINT_8': case 'UINT_16': case 'UINT_32': case 'UINT_64': return 'int';
    case 'FLOAT16': return 'float';
    default: break;
  }
  switch (el.type) {
    case 'BOOLEAN': return 'bool';
    case 'INT32': case 'INT64': return 'int';
    case 'INT96': return 'timestamp';
    case 'FLOAT': case 'DOUBLE': return 'float';
    case 'BYTE_ARRAY': return 'string';
    case 'FIXED_LEN_BYTE_ARRAY': return 'binary';
    default: return 'string';
  }
}

/** Flat schema rows (depth, name, physical, logical, repetition) in file order. */
function schemaRows(metadata) {
  const out = [];
  const stack = [];
  metadata.schema.forEach((el, i) => {
    while (stack.length && stack[stack.length - 1] === 0) stack.pop();
    const depth = stack.length;
    if (stack.length) stack[stack.length - 1]--;
    if (i > 0) {
      out.push({
        depth: depth - 1,
        name: String(el.name),
        physical: el.type || (el.num_children ? 'group' : ''),
        logical: logicalText(el),
        repetition: el.repetition_type || '',
        typeLength: el.type_length === undefined ? undefined : Number(el.type_length),
        fieldId: el.field_id === undefined ? undefined : Number(el.field_id),
      });
    }
    if (el.num_children) stack.push(el.num_children);
  });
  return out;
}

/** Schema as a nested JSON object (Copy schema as JSON). */
function schemaJson(metadata) {
  const els = metadata.schema;
  let i = 0;
  const node = () => {
    const el = els[i++];
    const o = { name: String(el.name) };
    if (el.type) o.type = el.type;
    if (el.type_length !== undefined) o.typeLength = Number(el.type_length);
    const lt = logicalText(el);
    if (lt) o.logicalType = lt;
    if (el.repetition_type) o.repetition = el.repetition_type;
    if (el.field_id !== undefined) o.fieldId = Number(el.field_id);
    if (el.num_children) { o.fields = []; for (let k = 0; k < el.num_children && i < els.length; k++) o.fields.push(node()); }
    return o;
  };
  const root = node();
  return { name: root.name, fields: root.fields || [] };
}

/**
 * A copy of the metadata for reading, with the annotations we decode ourselves removed from flat columns:
 * DECIMAL (exact text instead of a rounded JS number), TIME, INTERVAL and BSON (hyparquet stops on the last two).
 * Returns the copy and per-column decoders.
 */
function readMetadata(metadata, tree) {
  const decoders = new Map();
  const schema = metadata.schema.map(el => ({ ...el }));
  const byName = new Map();
  // top-level leaf elements are direct children of the root that have no children
  tree.children.forEach(node => byName.set(node.element, node));
  for (let i = 1; i < schema.length; i++) {
    const orig = metadata.schema[i];
    const node = byName.get(orig);
    if (!node || (node.children && node.children.length)) continue;
    const ct = orig.converted_type;
    const lt = orig.logical_type && orig.logical_type.type;
    const name = String(orig.name);
    if ((ct === 'DECIMAL' || lt === 'DECIMAL') && orig.type !== 'BYTE_ARRAY') {
      const scale = orig.logical_type && orig.logical_type.scale !== undefined ? orig.logical_type.scale : (orig.scale || 0);
      decoders.set(name, v => F.decimalText(v, scale));
      schema[i] = { ...orig, converted_type: undefined, logical_type: undefined };
    } else if (lt === 'TIME' || ct === 'TIME_MILLIS' || ct === 'TIME_MICROS') {
      const unit = lt === 'TIME' ? String(orig.logical_type.unit) : ct === 'TIME_MICROS' ? 'MICROS' : 'MILLIS';
      decoders.set(name, v => F.timeText(v, unit));
      schema[i] = { ...orig, converted_type: undefined, logical_type: undefined };
    } else if (ct === 'INTERVAL') {
      decoders.set(name, v => (v === null || v === undefined ? null : F.intervalText(v)));
      schema[i] = { ...orig, converted_type: undefined, logical_type: undefined };
    } else if (ct === 'BSON' || lt === 'BSON') {
      decoders.set(name, v => (v === null || v === undefined ? null : F.bytesText(v)));
      schema[i] = { ...orig, converted_type: undefined, logical_type: undefined };
    } else if (orig.type === 'FIXED_LEN_BYTE_ARRAY' && !ct && !lt) {
      decoders.set(name, v => (v === null || v === undefined ? null : v instanceof Uint8Array ? F.bytesText(v) : v));
    }
  }
  return { metadata: { ...metadata, schema }, decoders };
}

// ---------- the source ----------

/**
 * Opens a Parquet file: reads and checks the footer only.
 * @param {{path?:string, bytes?:Uint8Array}} source
 * @param {{maxFooterMB?:number, maxChunkMB?:number}} [options]
 */
async function openParquet(source, options = {}) {
  const o = { maxFooterMB: 256, maxChunkMB: 2048, ...options };
  const { hp, compressors } = await lib();
  const { file, close } = source.bytes ? bytesFile(source.bytes) : await openFile(source.path);
  try {
    await checkEnvelope(file, o.maxFooterMB);
    let metadata;
    try {
      metadata = await hp.parquetMetadataAsync(file, { parsers: F.makeParsers() });
    } catch (e) {
      throw new ParquetError('BAD_METADATA', `The metadata (footer) of this file can't be read: ${msg(e)}. The file is damaged, or it was written by a tool that does not follow the Parquet format.`);
    }
    let tree;
    try {
      tree = hp.parquetSchema(metadata);
    } catch (e) {
      throw new ParquetError('BAD_SCHEMA', `The schema in this file can't be read: ${msg(e)}.`);
    }
    return new ParquetSource({ hp, compressors, file, close, metadata, tree, options: o });
  } catch (e) {
    await close();
    throw e;
  }
}

function msg(e) { return String(e && e.message ? e.message : e).replace(/^Error: /, ''); }

class ParquetSource {
  constructor({ hp, compressors, file, close, metadata, tree, options }) {
    Object.assign(this, { hp, compressors, file, closeFile: close, metadata, tree, options });
    this.parsers = F.makeParsers();
    const rm = readMetadata(metadata, tree);
    this.readMeta = rm.metadata;
    this.decoders = rm.decoders;
    this.columns = tree.children.map(node => {
      const el = node.element;
      const nested = !!(node.children && node.children.length) || el.repetition_type === 'REPEATED';
      return {
        name: String(el.name),
        kind: columnKind(node),
        nested,
        detail: nested ? (logicalText(el) || 'group') : [el.type, logicalText(el)].filter(Boolean).join(' / '),
      };
    });
    this.nameToIdx = new Map(this.columns.map((c, i) => [c.name, i]));
    // row groups: start row, rows, sizes, problems
    const size = file.byteLength;
    this.groups = [];
    let start = 0;
    (metadata.row_groups || []).forEach((rg, gi) => {
      const rows = Number(rg.num_rows) || 0;
      let comp = 0, uncomp = 0, hasOffsetIndex = true;
      let problem = '';
      for (const cc of rg.columns || []) {
        const md = cc.meta_data;
        if (!md) { problem = problem || `Row group ${gi + 1} has a column without metadata.`; hasOffsetIndex = false; continue; }
        const off = Number(md.dictionary_page_offset || md.data_page_offset);
        const len = Number(md.total_compressed_size);
        comp += len; uncomp += Number(md.total_uncompressed_size || 0);
        if (!(cc.offset_index_offset && cc.offset_index_length)) hasOffsetIndex = false;
        if (cc.crypto_metadata || cc.encrypted_column_metadata) {
          problem = problem || 'Some columns of this file are encrypted (Parquet Modular Encryption with a plain footer). Rows can only be read with the decryption keys, which this viewer does not ask for. The schema and the file details are in the Schema tab.';
        }
        const colName = (md.path_in_schema || []).join('.');
        if (cc.file_path) problem = problem || `Row group ${gi + 1} keeps column "${colName}" in another file (${cc.file_path}). Only single-file Parquet is supported.`;
        else if (!(off >= 0) || !(len >= 0) || off + len > size) {
          problem = problem || `Row group ${gi + 1} says column "${colName}" is ${F.fmtBytes(len)} at byte ${off.toLocaleString('en-US')}, but the file is only ${F.fmtBytes(size)}. The file is damaged or cut off, so the rows of this row group can't be shown.`;
        } else if (len > o(options).maxChunkMB * MB) {
          problem = problem || `Row group ${gi + 1}, column "${colName}" is ${F.fmtBytes(len)}, over the limit of ${o(options).maxChunkMB} MB for one column chunk (setting parquetViewer.maxChunkMB).`;
        }
      }
      this.groups.push({ index: gi, start, rows, comp, uncomp, hasOffsetIndex, problem });
      start += rows;
    });
    const declared = Number(metadata.num_rows);
    this.totalRows = start;
    this.rowCountNote = Number.isFinite(declared) && declared !== start
      ? `The footer says ${declared.toLocaleString('en-US')} rows, but its row groups add up to ${start.toLocaleString('en-US')}. The row groups are used.` : '';
    this.cache = new Map(); // key -> {rows: any[][], cells}
    this.cacheCells = 0;
  }

  get bytesRead() { return this.file.bytesRead; }
  get size() { return this.file.byteLength; }

  info() {
    const md = this.metadata;
    const codecs = new Set(), encodings = new Set();
    for (const rg of md.row_groups || []) for (const cc of rg.columns || []) {
      const m = cc.meta_data;
      if (!m) continue;
      if (m.codec) codecs.add(m.codec);
      for (const e of m.encodings || []) encodings.add(e);
    }
    const comp = this.groups.reduce((a, g) => a + g.comp, 0);
    const uncomp = this.groups.reduce((a, g) => a + g.uncomp, 0);
    return {
      rows: this.totalRows,
      rowCountNote: this.rowCountNote,
      rowGroups: this.groups.length,
      createdBy: md.created_by || '',
      version: md.version,
      codecs: [...codecs],
      encodings: [...encodings],
      fileSize: this.size,
      metadataBytes: Number(md.metadata_length) || 0,
      compressedBytes: comp,
      uncompressedBytes: uncomp,
      keyValue: (md.key_value_metadata || []).map(kv => ({
        key: String(kv.key),
        value: kv.value === undefined || kv.value === null ? '' : (kv.key === 'ARROW:schema' ? `(${String(kv.value).length.toLocaleString('en-US')} characters, base64 Arrow schema)` : String(kv.value).slice(0, 20000)),
      })),
      fields: schemaRows(md),
      groups: this.groups.slice(0, 5000).map(g => ({ index: g.index, start: g.start, rows: g.rows, comp: g.comp, uncomp: g.uncomp, offsetIndex: g.hasOffsetIndex, problem: g.problem })),
      problems: this.groups.filter(g => g.problem).slice(0, 20).map(g => g.problem),
    };
  }

  schemaJson() { return schemaJson(this.metadata); }

  groupOf(row) {
    // binary search over group starts
    let lo = 0, hi = this.groups.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.groups[mid].start <= row) lo = mid; else hi = mid - 1;
    }
    return this.groups[lo];
  }

  /** The block (group-aligned) that holds a row: {g, start, end}. */
  blockOf(row) {
    const g = this.groupOf(row);
    const size = this.blockRows(g);
    const k = Math.floor((row - g.start) / size);
    const start = g.start + k * size;
    return { g, start, end: Math.min(g.start + g.rows, start + size) };
  }

  /**
   * Rows per cached block. With a page index only the needed pages are read, so blocks are small. Without one,
   * every read decodes the column chunk from the start of the row group, so blocks are as big as the cache allows
   * (a third of it) to keep scrolling and export through a big row group from decoding the same rows again and again.
   */
  blockRows(g) {
    if (g.hasOffsetIndex) return BLOCK_ROWS;
    const cols = Math.max(1, this.columns.length);
    return Math.max(BLOCK_ROWS, Math.min(262144, Math.floor(CACHE_CELLS / 3 / cols)));
  }

  /** Decoded rows [start, end) of one group, all columns or the given ones. Arrays of raw values per row. */
  async readRange(g, start, end, columns) {
    if (g.problem) throw new ParquetError('BAD_GROUP', g.problem);
    const names = columns || this.columns.map(c => c.name);
    const idx = names.map(n => this.nameToIdx.get(n));
    const data = names.map(() => new Array(end - start).fill(null));
    const pos = new Map(names.map((n, i) => [n, i]));
    // Column batches keep memory bounded for big row groups that have no offset index.
    const batches = [];
    if (!g.hasOffsetIndex && g.comp > BATCH_BYTES && names.length > 1) {
      const rg = this.metadata.row_groups[g.index];
      const sizeOf = new Map();
      for (const cc of rg.columns) { const m = cc.meta_data; if (m) { const n = m.path_in_schema[0]; sizeOf.set(n, (sizeOf.get(n) || 0) + Number(m.total_compressed_size)); } }
      let cur = [], bytes = 0;
      for (const n of names) {
        const s = sizeOf.get(n) || 0;
        if (cur.length && bytes + s > BATCH_BYTES) { batches.push(cur); cur = []; bytes = 0; }
        cur.push(n); bytes += s;
      }
      if (cur.length) batches.push(cur);
    } else {
      batches.push(columns ? names : undefined);
    }
    for (const batch of batches) {
      try {
        await this.hp.parquetRead({
          file: this.file, metadata: this.readMeta, compressors: this.compressors, parsers: this.parsers,
          rowStart: start, rowEnd: end, columns: batch, useOffsetIndex: true,
          onChunk: ({ columnName, columnData, rowStart }) => {
            const ci = pos.get(columnName);
            if (ci === undefined) return;
            const out = data[ci];
            const n = columnData.length;
            for (let i = 0; i < n; i++) {
              const r = rowStart + i - start;
              if (r >= 0 && r < out.length) out[r] = columnData[i];
            }
          },
        });
      } catch (e) {
        throw new ParquetError('READ_FAILED', `Rows ${(start + 1).toLocaleString('en-US')} to ${end.toLocaleString('en-US')} (row group ${g.index + 1}) can't be read: ${msg(e)}.`);
      }
    }
    // our own decoders (exact decimals, time, interval)
    names.forEach((n, i) => {
      const dec = this.decoders.get(n);
      if (!dec) return;
      const col = data[i];
      for (let r = 0; r < col.length; r++) col[r] = dec(col[r]);
    });
    void idx;
    return data; // column-major
  }

  async block(row) {
    const b = this.blockOf(row);
    const key = b.start;
    let hit = this.cache.get(key);
    if (hit) { this.cache.delete(key); this.cache.set(key, hit); return hit; }
    const data = await this.readRange(b.g, b.start, b.end);
    hit = { start: b.start, end: b.end, data, cells: (b.end - b.start) * Math.max(1, data.length) };
    this.cache.set(key, hit);
    this.cacheCells += hit.cells;
    while (this.cacheCells > CACHE_CELLS && this.cache.size > 1) {
      const [k, v] = this.cache.entries().next().value;
      this.cache.delete(k);
      this.cacheCells -= v.cells;
    }
    return hit;
  }

  /** Raw rows for physical row numbers (any order). Returns an array of row arrays. */
  async rowsAt(rowNums) {
    const out = new Array(rowNums.length);
    // group by block so each block is read once
    const order = rowNums.map((r, i) => i).sort((a, b) => rowNums[a] - rowNums[b]);
    let blk = null;
    for (const i of order) {
      const r = rowNums[i];
      if (!blk || r < blk.start || r >= blk.end) blk = await this.block(r);
      const k = r - blk.start;
      out[i] = blk.data.map(col => col[k]);
    }
    return out;
  }

  /** Raw rows [start, end) in physical order. */
  async rows(start, end) {
    const nums = [];
    for (let r = start; r < end; r++) nums.push(r);
    return this.rowsAt(nums);
  }

  /**
   * Reads whole row groups, some columns only, and calls onRows(firstRow, columnsData) for each group.
   * Used by filter, sort, search and export. shouldStop() is checked between groups.
   */
  async scan(columns, onGroup, shouldStop, onProgress) {
    const total = this.groups.length;
    for (let i = 0; i < total; i++) {
      if (shouldStop && shouldStop()) return false;
      const g = this.groups[i];
      if (g.rows === 0) continue;
      if (g.problem) throw new ParquetError('BAD_GROUP', g.problem);
      // One read per row group when the selected column chunks are small enough; big groups go in pieces so
      // memory stays bounded (each piece re-reads the chunk unless the file has a page index).
      const want = columns ? new Set(columns) : null;
      let bytes = 0;
      for (const cc of this.metadata.row_groups[g.index].columns || []) {
        const m = cc.meta_data;
        if (m && (!want || want.has(m.path_in_schema[0]))) bytes += Number(m.total_compressed_size) || 0;
      }
      const step = bytes <= BATCH_BYTES && g.rows <= 4194304 ? g.rows : Math.max(BLOCK_ROWS, Math.min(g.rows, 262144));
      for (let s = g.start; s < g.start + g.rows; s += step) {
        if (shouldStop && shouldStop()) return false;
        const e = Math.min(g.start + g.rows, s + step);
        const data = await this.readRange(g, s, e, columns);
        await onGroup(s, data, e - s);
        if (onProgress) onProgress((s + (e - s) - 0) / Math.max(1, this.totalRows));
      }
    }
    return true;
  }

  async close() { this.cache.clear(); this.cacheCells = 0; await this.closeFile(); }
}

function o(options) { return { maxChunkMB: 2048, ...(options || {}) }; }

module.exports = { openParquet, ParquetSource, ParquetError, checkEnvelope, columnKind, schemaRows, schemaJson, logicalText, BLOCK_ROWS, bytesFile };
