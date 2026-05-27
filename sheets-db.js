// ══════════════════════════════════════════════════════════════════
// sheets-db.js — Google Sheets backed in-memory database adapter
// ──────────────────────────────────────────────────────────────────
// • Drop-in replacement for mysql2/promise pool: db.query / db.execute /
//   db.getConnection() — server.js me kuchh change nahi chahiye.
// • Internally alasql (in-memory SQL engine) use karta hai — saari
//   reads MEMORY se = microseconds (MySQL se 50-100x tez).
// • Writes pehle memory me (instant response), phir background me
//   ek debounced batchUpdate call Google Sheets pe (1.5 sec ke baad).
// • Sheet ID `.env` me `GOOGLE_SHEET_ID` me set karo — pehli baar
//   blank sheet ho to saare tabs (users, tasks, etc.) auto-create
//   ho jaate hain headers ke saath + ek default admin user seed ho
//   jaata hai (admin@admin.com / admin).
// ══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const alasql = require('alasql');
const { google } = require('googleapis');

// ── Config ─────────────────────────────────────────────────────────
const FLUSH_DEBOUNCE_MS = 1500;
const MAX_CELL_CHARS = 45000;       // Sheets cell limit ~50k, leave room
const BLOB_DIR = path.join(__dirname, 'data', 'blobs');

// ── Schema (10 tables) ─────────────────────────────────────────────
// `cols` = column order ki authoritative list (sheet headers bhi yahi)
// `autoFill` = INSERT pe agar column miss hai to ye default fill hoga
// keyType: 'AUTO' = AUTOINCREMENT INT id, 'NONE' = no auto key

const SCHEMA = {
  users: {
    cols: ['id','name','email','notification_email','password','role','phone','profile_image','department','week_off','extra_off'],
    autoFill: {}
  },
  delegation_tasks: {
    cols: ['id','description','assigned_to','assigned_by','due_date','status','priority','approval','waiting_approval','remarks','created_at','last_reminder_date','completed_at'],
    autoFill: { created_at: 'NOW' }
  },
  checklist_tasks: {
    cols: ['id','description','assigned_to','assigned_by','due_date','status','priority','remarks','frequency','created_at','completed_at'],
    autoFill: { created_at: 'NOW' }
  },
  task_approvals: {
    cols: ['id','task_id','task_type','requested_by','requested_to','action_type','status','note','created_at'],
    autoFill: { created_at: 'NOW' }
  },
  task_transfers: {
    cols: ['id','task_id','task_type','from_user','to_user','requested_by','status','note','created_at'],
    autoFill: { created_at: 'NOW' }
  },
  task_comments: {
    cols: ['id','task_id','task_type','user_id','comment','created_at'],
    autoFill: { created_at: 'NOW' }
  },
  week_plans: {
    cols: ['id','employee_id','hod_id','start_date','target_count','improvement_pct','created_at','updated_at'],
    autoFill: { created_at: 'NOW', updated_at: 'NOW' }
  },
  fms_sheets: {
    cols: ['id','fms_name','sheet_name','sheet_id','header_row','total_steps','created_by','created_at'],
    autoFill: { created_at: 'NOW' }
  },
  fms_steps: {
    cols: ['id','fms_id','step_order','step_name','plan_col','actual_col','extra_input','extra_col','show_cols','delay_reason_col','doer_name_col'],
    autoFill: {}
  },
  fms_step_doers: {
    cols: ['id','step_id','user_id'],
    autoFill: {}
  },
  fms_extra_rows: {
    cols: ['id','step_id','row_label','col_letter','field_type','dropdown_options'],
    autoFill: {}
  }
};

const TABLE_NAMES = Object.keys(SCHEMA);

// Derived "display" columns — sheet me extra dikhte hain par alasql me store nahi hote.
// User-facing readability ke liye (e.g. YES/NO instead of 'completed'/'pending').
// Init-time pe ignore hote hain (load only reads SCHEMA cols).
const SHEET_DERIVED = {
  delegation_tasks: {
    is_done: row => (row.status === 'completed') ? 'YES' : 'NO'
  },
  checklist_tasks: {
    is_done: row => (row.status === 'completed') ? 'YES' : 'NO'
  }
};

// Integer columns — sheet se string aati hain, alasql me daalne se pehle
// parse karte hain taaki SQL me arithmetic/IN comparisons sahi chalein.
const INT_COLS = new Set([
  'id','assigned_to','assigned_by','user_id','task_id','requested_by','requested_to',
  'employee_id','hod_id','target_count','improvement_pct','fms_id','step_id','step_order',
  'total_steps','header_row','from_user','to_user','waiting_approval','created_by'
]);

// ══════════════════════════════════════════════════════════════════
// ALASQL CUSTOM FUNCTIONS (MySQL compatibility)
// ══════════════════════════════════════════════════════════════════
function isoDate() { return new Date().toISOString().slice(0,10); }
function isoDateTime() { return new Date().toISOString().slice(0,19).replace('T',' '); }

alasql.fn.DATE_FORMAT = function (d, fmt) {
  if (d == null || d === '') return null;
  let s = String(d);
  // already YYYY-MM-DD or similar — slice
  if (fmt === '%Y-%m-%d') return s.length >= 10 ? s.slice(0,10) : s;
  // fallback generic
  const dt = new Date(s);
  if (isNaN(dt.getTime())) return s.slice(0,10);
  const y = dt.getFullYear();
  const m = String(dt.getMonth()+1).padStart(2,'0');
  const day = String(dt.getDate()).padStart(2,'0');
  return String(fmt).replace('%Y',y).replace('%m',m).replace('%d',day);
};
alasql.fn.CURDATE = isoDate;
alasql.fn.NOW = isoDateTime;
alasql.fn.CURRENT_TIMESTAMP = isoDateTime;
alasql.fn.YEAR = (d) => {
  if (!d) return null;
  const s = String(d);
  return parseInt(s.slice(0,4), 10) || null;
};

// ══════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════
let _api = null;
let _spreadsheetId = null;
let _tabIdByName = {};   // tabName -> sheetId (numeric, used for delete)
let _initialized = false;
let _initPromise = null;

const _dirtyTables = new Set();
let _flushTimer = null;
let _flushInProgress = false;
let _pendingFlushResolvers = [];

// Per-table next-auto-id counter (used for insertId result)
const _nextId = {};

// ══════════════════════════════════════════════════════════════════
// BLOB STORAGE (for large cells like profile images)
// ══════════════════════════════════════════════════════════════════
function ensureBlobDir() {
  if (!fs.existsSync(BLOB_DIR)) fs.mkdirSync(BLOB_DIR, { recursive: true });
}
function blobStore(value) {
  ensureBlobDir();
  const hash = crypto.createHash('md5').update(value).digest('hex');
  const file = path.join(BLOB_DIR, `${hash}.txt`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, value, 'utf8');
  return `blob:${hash}`;
}
function blobLoad(ref) {
  const hash = String(ref).slice(5);
  const file = path.join(BLOB_DIR, `${hash}.txt`);
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
}

function serializeForSheet(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.length > MAX_CELL_CHARS) return blobStore(s);
  return s;
}
function deserializeFromSheet(v) {
  if (typeof v === 'string' && v.startsWith('blob:')) return blobLoad(v);
  return v;
}

function parseCellValue(col, raw) {
  let v = deserializeFromSheet(raw);
  if (v === undefined || v === null || v === '') {
    return INT_COLS.has(col) ? null : '';
  }
  if (INT_COLS.has(col)) {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  }
  return v;
}

// ══════════════════════════════════════════════════════════════════
// GOOGLE SHEETS CLIENT
// ══════════════════════════════════════════════════════════════════
async function getApiClient() {
  if (_api) return _api;
  const creds = process.env.GOOGLE_CREDENTIALS
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS)
    : require('./credentials.json');
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  _api = google.sheets({ version: 'v4', auth: await auth.getClient() });
  return _api;
}

function getSpreadsheetId() {
  const raw = (process.env.GOOGLE_SHEET_ID || process.env.SHEET_ID || '').trim();
  if (!raw) throw new Error('GOOGLE_SHEET_ID env var not set — please set it to your Google Sheet ID');
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : raw;
}

// ══════════════════════════════════════════════════════════════════
// INIT — load all tables from Sheets into alasql
// ══════════════════════════════════════════════════════════════════
async function init() {
  if (_initialized) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      _spreadsheetId = getSpreadsheetId();
      const api = await getApiClient();

      // 1. Create alasql tables (basic schema)
      // NOTE: `id` is plain INT (no PRIMARY KEY). Bulk load below does
      // `alasql.tables[t].data = inserts` which bypasses alasql's PK index,
      // leaving it inconsistent and causing "Something wrong with primary key
      // index on table" on later INSERTs. Uniqueness is managed via _nextId.
      for (const t of TABLE_NAMES) {
        const colsSql = SCHEMA[t].cols
          .map(c => `\`${c}\` ${c==='id' ? 'INT' : 'STRING'}`)
          .join(', ');
        alasql(`CREATE TABLE IF NOT EXISTS ${t} (${colsSql})`);
      }

      // 2. Spreadsheet metadata — kya tabs already exist?
      const meta = await api.spreadsheets.get({
        spreadsheetId: _spreadsheetId,
        fields: 'sheets.properties'
      });
      _tabIdByName = {};
      for (const s of meta.data.sheets || []) {
        _tabIdByName[s.properties.title] = s.properties.sheetId;
      }

      // 3. Missing tabs auto-create with headers
      const missing = TABLE_NAMES.filter(t => !(t in _tabIdByName));
      if (missing.length) {
        console.log(`  📊 Creating ${missing.length} missing tab(s): ${missing.join(', ')}`);
        const requests = missing.map(t => ({
          addSheet: { properties: { title: t } }
        }));
        const resp = await api.spreadsheets.batchUpdate({
          spreadsheetId: _spreadsheetId,
          requestBody: { requests }
        });
        for (const reply of resp.data.replies || []) {
          if (reply.addSheet) {
            _tabIdByName[reply.addSheet.properties.title] = reply.addSheet.properties.sheetId;
          }
        }
        // Write headers in newly created tabs (include derived cols)
        const headerData = missing.map(t => {
          const derivedCols = Object.keys(SHEET_DERIVED[t] || {});
          return { range: `${t}!A1`, values: [[...SCHEMA[t].cols, ...derivedCols]] };
        });
        await api.spreadsheets.values.batchUpdate({
          spreadsheetId: _spreadsheetId,
          requestBody: { valueInputOption: 'RAW', data: headerData }
        });
      }

      // 4. Bulk load all tabs in ONE API call
      const ranges = TABLE_NAMES.map(t => `${t}!A:ZZ`);
      const batchResp = await api.spreadsheets.values.batchGet({
        spreadsheetId: _spreadsheetId,
        ranges
      });
      const valueRanges = batchResp.data.valueRanges || [];

      // 5. Populate alasql tables
      let totalRows = 0;
      for (let i = 0; i < TABLE_NAMES.length; i++) {
        const table = TABLE_NAMES[i];
        const cols = SCHEMA[table].cols;
        const rows = (valueRanges[i] && valueRanges[i].values) || [];
        if (rows.length <= 1) {
          // Either empty or only header. Ensure header row exists for clean future writes.
          _nextId[table] = 1;
          continue;
        }
        const headerRow = rows[0];
        // Map sheet column index -> schema column name (handles any order)
        const colIndex = {};
        for (let c = 0; c < headerRow.length; c++) {
          colIndex[String(headerRow[c]).trim()] = c;
        }
        let maxId = 0;
        const inserts = [];
        for (let r = 1; r < rows.length; r++) {
          const sheetRow = rows[r];
          if (!sheetRow || sheetRow.every(x => x === '' || x == null)) continue;
          const obj = {};
          for (const col of cols) {
            const idx = colIndex[col];
            obj[col] = parseCellValue(col, idx == null ? '' : sheetRow[idx]);
          }
          if (obj.id && typeof obj.id === 'number' && obj.id > maxId) maxId = obj.id;
          inserts.push(obj);
        }
        // Insert all rows in one alasql call (very fast)
        if (inserts.length) {
          alasql.tables[table].data = inserts; // direct injection (faster than INSERT loop)
        }
        _nextId[table] = maxId + 1;
        totalRows += inserts.length;
      }
      console.log(`  ✅ Sheets DB loaded: ${totalRows} rows across ${TABLE_NAMES.length} tables`);

      // 6. Seed default admin if users table is empty (PLAIN TEXT password)
      const userCount = alasql('SELECT COUNT(*) AS c FROM users')[0].c;
      if (userCount === 0) {
        alasql(
          'INSERT INTO users (id,name,email,notification_email,password,role,phone,profile_image,department,week_off,extra_off) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          [1, 'Admin', 'admin@admin.com', '', 'admin', 'admin', '', '', '', '', '']
        );
        _nextId.users = 2;
        markDirty('users');
        console.log('  🌱 Seeded default admin: admin@admin.com / admin');
      }

      _initialized = true;

      // Mark derived-column tables dirty so existing sheets get the new
      // is_done column populated on first flush after deployment.
      for (const t of Object.keys(SHEET_DERIVED)) markDirty(t);

      // 7. Flush-on-exit — best-effort save before process exits
      const flushAndExit = async (sig) => {
        try { await flushNow(); } catch(_) {}
        process.exit(0);
      };
      process.on('SIGINT', flushAndExit);
      process.on('SIGTERM', flushAndExit);

    } catch (err) {
      _initPromise = null;
      throw err;
    }
  })();
  return _initPromise;
}

// ══════════════════════════════════════════════════════════════════
// SQL PREPROCESSING
// ══════════════════════════════════════════════════════════════════

// alasql me kuch words reserved hain (TOTAL, COUNT, etc.) jo aliases ke
// liye fail karte hain. Solution: har `AS xxx` ko backticks me wrap kar do.
function escapeAliases(sql) {
  // Skip portions inside single-quoted strings
  return sql.replace(/'(?:[^'\\]|\\.)*'|\bAS\s+(\w+)\b/gi, (match, alias) => {
    if (!alias) return match; // string literal — leave as-is
    return `AS \`${alias}\``;
  });
}

// Detect target table for mutation queries (for dirty tracking)
function detectMutationTable(sql) {
  const s = sql.replace(/^\s+/, '');
  let m;
  if (/^INSERT/i.test(s)) {
    m = s.match(/INSERT\s+(?:IGNORE\s+)?INTO\s+`?(\w+)`?/i);
  } else if (/^UPDATE/i.test(s)) {
    m = s.match(/UPDATE\s+`?(\w+)`?/i);
  } else if (/^DELETE/i.test(s)) {
    m = s.match(/DELETE\s+FROM\s+`?(\w+)`?/i);
  } else {
    return null;
  }
  return m ? m[1] : null;
}

// MySQL bulk INSERT: `INSERT INTO t (a,b) VALUES ?` with params=[[[v1,v2],[v3,v4]]]
function expandBulkInsert(sql, params) {
  const m = sql.match(/^\s*INSERT\s+INTO\s+`?(\w+)`?\s*\(([^)]+)\)\s*VALUES\s*\?\s*$/i);
  if (!m) return null;
  if (!Array.isArray(params) || !Array.isArray(params[0]) || !Array.isArray(params[0][0])) return null;
  const [, table, colsStr] = m;
  const cols = colsStr.split(',').map(c => c.trim().replace(/^`|`$/g, ''));
  const rows = params[0];
  const placeholders = cols.map(() => '?').join(',');
  const valuesClause = rows.map(() => `(${placeholders})`).join(',');
  const flatParams = [];
  for (const r of rows) flatParams.push(...r);
  return {
    sql: `INSERT INTO ${table} (${cols.join(',')}) VALUES ${valuesClause}`,
    params: flatParams,
    table,
    cols,
    rowCount: rows.length
  };
}

// MySQL ON DUPLICATE KEY UPDATE — translate to upsert
// Only supports the week_plans pattern (single VALUES tuple, key = employee_id+start_date)
function expandUpsert(sql, params) {
  const m = sql.match(/^\s*INSERT\s+INTO\s+`?(\w+)`?\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)\s*ON\s+DUPLICATE\s+KEY\s+UPDATE\s+(.+)$/is);
  if (!m) return null;
  const [, table, colsStr, valsStr, updateClause] = m;
  const cols = colsStr.split(',').map(c => c.trim().replace(/^`|`$/g, ''));
  const valTokens = valsStr.split(',').map(v => v.trim());
  return { table, cols, valTokens, updateClause: updateClause.trim(), params };
}

// Apply autoFill defaults for missing columns on simple INSERT
function applyInsertDefaults(table, sql, params) {
  const defaults = SCHEMA[table] && SCHEMA[table].autoFill;
  if (!defaults || !Object.keys(defaults).length) return { sql, params };
  const m = sql.match(/^\s*INSERT\s+INTO\s+`?\w+`?\s*\(([^)]+)\)\s*VALUES\s*(\(.+\))\s*$/is);
  if (!m) return { sql, params };
  const cols = m[1].split(',').map(c => c.trim().replace(/^`|`$/g, ''));
  const valuesPart = m[2];
  // Single tuple (a,b,?) -> match
  const isSingleTuple = /^\([^)]*\)\s*$/.test(valuesPart);
  const newCols = [...cols];
  let extraValsSql = '';
  const extraParams = [];
  for (const [col, kind] of Object.entries(defaults)) {
    if (newCols.includes(col)) continue;
    newCols.push(col);
    const v = kind === 'NOW' ? isoDateTime() : null;
    extraValsSql += ',?';
    extraParams.push(v);
  }
  if (!extraValsSql) return { sql, params };
  let newValuesPart;
  if (isSingleTuple) {
    // Append before closing paren
    newValuesPart = valuesPart.replace(/\)\s*$/, extraValsSql + ')');
  } else {
    // Multi-tuple: append same extras to each tuple
    newValuesPart = valuesPart.replace(/\)(?=\s*(?:,|$))/g, extraValsSql + ')');
    // Multiply extra params per tuple
    const tuples = valuesPart.split(/\),\s*\(/).length;
    const repeated = [];
    for (let i = 0; i < tuples; i++) repeated.push(...extraParams);
    return {
      sql: sql.replace(valuesPart, newValuesPart).replace(/\(([^)]+)\)\s*VALUES/, `(${newCols.join(',')}) VALUES`),
      params: insertExtrasIntoMultiTupleParams(params, cols.length, extraParams, tuples)
    };
  }
  return {
    sql: sql.replace(valuesPart, newValuesPart).replace(/\(([^)]+)\)\s*VALUES/, `(${newCols.join(',')}) VALUES`),
    params: [...params, ...extraParams]
  };
}

function insertExtrasIntoMultiTupleParams(params, colsPerTuple, extraParams, tuples) {
  // params is flat array: [t1c1,t1c2,...,t2c1,t2c2,...]
  // After expansion each tuple has colsPerTuple + extraParams.length values
  const out = [];
  for (let t = 0; t < tuples; t++) {
    const start = t * colsPerTuple;
    out.push(...params.slice(start, start + colsPerTuple));
    out.push(...extraParams);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
// QUERY API
// ══════════════════════════════════════════════════════════════════
// Pure-integer string param ko number me coerce karo (Express req.params.id
// hamesha string aati hai, par alasql strict comparison karta hai — number 1
// vs string '1' match nahi karta. Yeh fix WHERE/JOIN comparisons ke liye zaroori hai.)
const INT_STR_RE = /^(?:0|-?[1-9]\d*)$/;
function coerceParams(params) {
  if (!Array.isArray(params)) return params;
  return params.map(p => {
    if (typeof p === 'string' && p.length > 0 && p.length < 16 && INT_STR_RE.test(p)) {
      return parseInt(p, 10);
    }
    return p;
  });
}

async function query(sql, params = []) {
  if (!_initialized) await init();
  if (params == null) params = [];
  if (!Array.isArray(params)) params = [params];
  params = coerceParams(params);

  const sqlTrim = sql.trim();
  // No-ops — schema management calls (CREATE TABLE / ALTER TABLE / DROP)
  if (/^\s*(ALTER|CREATE\s+TABLE|DROP|CREATE\s+INDEX)/i.test(sqlTrim)) {
    return [[], []];
  }
  // Health check
  if (/^\s*SELECT\s+1\s*$/i.test(sqlTrim)) {
    return [[{ '1': 1 }], []];
  }

  // Bulk insert: INSERT ... VALUES ?
  const bulk = expandBulkInsert(sqlTrim, params);
  if (bulk) {
    const withDefaults = applyInsertDefaults(bulk.table, bulk.sql, bulk.params);
    return executeMutation(withDefaults.sql, withDefaults.params, bulk.table);
  }

  // Upsert: ON DUPLICATE KEY UPDATE
  const upsert = expandUpsert(sqlTrim, params);
  if (upsert) {
    return executeUpsert(upsert);
  }

  // Mutation
  const mutationTable = detectMutationTable(sqlTrim);
  if (mutationTable) {
    let processedSql = sqlTrim;
    let processedParams = params;
    if (/^INSERT/i.test(sqlTrim)) {
      const withDefaults = applyInsertDefaults(mutationTable, processedSql, processedParams);
      processedSql = withDefaults.sql;
      processedParams = withDefaults.params;
    }
    return executeMutation(processedSql, processedParams, mutationTable);
  }

  // SELECT (or anything else readable)
  try {
    const safeSql = escapeAliases(sqlTrim);
    const rows = alasql(safeSql, params);
    return [rows, []];
  } catch (err) {
    err.sql = sqlTrim;
    throw err;
  }
}

function executeMutation(sqlIn, params, table) {
  let sql = sqlIn;
  // For INSERT without explicit id, generate one and inject — gives us insertId
  let injectedId = null;
  if (/^\s*INSERT/i.test(sql)) {
    injectedId = injectAutoId(table, sql, params);
    if (injectedId) {
      sql = injectedId.sql;
      params = injectedId.params;
    }
  }
  let affected;
  try {
    affected = alasql(sql, params);
  } catch (err) {
    err.sql = sql;
    throw err;
  }
  // Re-coerce int columns on the affected rows (alasql treats params as strings sometimes)
  if (/^\s*(INSERT|UPDATE)/i.test(sql) && alasql.tables[table]) {
    const data = alasql.tables[table].data;
    if (data && data.length) {
      const lastN = /^\s*INSERT/i.test(sql) ? (injectedId ? injectedId.insertedCount : 1) : data.length;
      const startIdx = Math.max(0, data.length - lastN);
      for (let i = startIdx; i < data.length; i++) {
        const row = data[i];
        for (const c of Object.keys(row)) {
          if (INT_COLS.has(c) && typeof row[c] === 'string' && row[c] !== '') {
            const n = parseInt(row[c], 10);
            if (!Number.isNaN(n)) row[c] = n;
          }
        }
      }
    }
  }
  if (table) markDirty(table);
  const result = {
    affectedRows: typeof affected === 'number' ? affected : 0,
    insertId: injectedId ? injectedId.insertId : null
  };
  return [result, []];
}

// For INSERT statements, if `id` is NOT in the column list, prepend it with auto-generated id.
// Returns { sql, params, insertId, insertedCount } or null if no change needed.
function injectAutoId(table, sql, params) {
  if (!SCHEMA[table]) return null;
  // Match: INSERT INTO table (cols) VALUES (vals)[,(vals)...]
  const m = sql.match(/^(\s*INSERT\s+INTO\s+`?\w+`?\s*\()([^)]+)(\)\s*VALUES\s*)(.+)$/is);
  if (!m) return null;
  const colsList = m[2].split(',').map(c => c.trim().replace(/^`|`$/g, ''));
  if (colsList.includes('id')) {
    // id explicitly given — bump counter if needed
    return null;
  }
  // Parse tuples in VALUES
  const valuesPart = m[4].trim().replace(/;$/, '');
  const tupleStarts = [];
  let depth = 0;
  for (let i = 0; i < valuesPart.length; i++) {
    const ch = valuesPart[i];
    if (ch === '(') { if (depth === 0) tupleStarts.push(i); depth++; }
    else if (ch === ')') depth--;
  }
  const tuples = tupleStarts.length || 1;
  const startId = _nextId[table] || 1;
  const newColsList = ['id', ...colsList];

  // Build new VALUES with id prepended in each tuple
  let newValues = valuesPart;
  let idAdded = 0;
  newValues = newValues.replace(/\(/g, () => {
    if (depth >= 0) {
      const thisId = startId + idAdded;
      idAdded++;
      return `(${thisId},`;
    }
    return '(';
  });
  // Reset depth (just used for replace closure — fine)

  _nextId[table] = startId + tuples;
  const newSql = `${m[1].replace(/\(\s*$/, '(')}${newColsList.join(',')}${m[3]}${newValues}`;
  return {
    sql: newSql,
    params,
    insertId: startId,         // first inserted id (mysql2 returns the first for bulk)
    insertedCount: tuples
  };
}

// ON DUPLICATE KEY UPDATE — manual upsert
// Key detection: known schemas (week_plans: employee_id + start_date)
const UNIQUE_KEYS = {
  week_plans: ['employee_id', 'start_date']
};
function executeUpsert({ table, cols, valTokens, updateClause, params }) {
  const keys = UNIQUE_KEYS[table];
  if (!keys || !keys.length) {
    // Fallback: plain INSERT
    const insertSql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${valTokens.join(',')})`;
    return executeMutation(insertSql, params, table);
  }
  // Build key-WHERE from incoming params (need column->value mapping)
  // Each token is either `?` (positional) or a literal
  const colValMap = {};
  let pIdx = 0;
  for (let i = 0; i < cols.length; i++) {
    if (valTokens[i] === '?') {
      colValMap[cols[i]] = params[pIdx++];
    } else {
      colValMap[cols[i]] = unquoteSqlLiteral(valTokens[i]);
    }
  }
  // Lookup existing row by unique key
  const whereSql = keys.map(k => `${k} = ?`).join(' AND ');
  const whereVals = keys.map(k => colValMap[k]);
  const existing = alasql(`SELECT id FROM ${table} WHERE ${whereSql}`, whereVals);

  if (existing.length === 0) {
    // INSERT
    const insertSql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${valTokens.join(',')})`;
    const [res] = executeMutation(insertSql, params, table);
    return [{ affectedRows: 1, insertId: res.insertId }, []];
  }
  // UPDATE — translate `col = VALUES(col)` into actual values
  const id = existing[0].id;
  // Parse SET clauses
  const setParts = updateClause.split(',').map(s => s.trim());
  const setSql = [];
  const setParams = [];
  for (const part of setParts) {
    const mm = part.match(/^`?(\w+)`?\s*=\s*VALUES\s*\(\s*`?(\w+)`?\s*\)$/i);
    if (mm) {
      const target = mm[1];
      const source = mm[2];
      setSql.push(`${target} = ?`);
      setParams.push(colValMap[source]);
    } else {
      // Literal assignment like `col = ?` or `col = 5`
      const mm2 = part.match(/^`?(\w+)`?\s*=\s*(.+)$/i);
      if (mm2) {
        setSql.push(`${mm2[1]} = ${mm2[2]}`);
      }
    }
  }
  // Also update updated_at if column exists in schema
  if (SCHEMA[table].cols.includes('updated_at')) {
    setSql.push(`updated_at = ?`);
    setParams.push(isoDateTime());
  }
  alasql(`UPDATE ${table} SET ${setSql.join(', ')} WHERE id = ?`, [...setParams, id]);
  markDirty(table);
  // MySQL semantics: affectedRows=2 for an updated row (so caller distinguishes insert vs update)
  return [{ affectedRows: 2, insertId: id }, []];
}

function unquoteSqlLiteral(token) {
  const t = token.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.toUpperCase() === 'NULL') return null;
  return t;
}

// ══════════════════════════════════════════════════════════════════
// CONNECTION (transaction mock — alasql is in-memory, transactions
// are best-effort no-ops; commit/rollback don't truly isolate)
// ══════════════════════════════════════════════════════════════════
function getConnection() {
  return {
    query: (sql, params) => query(sql, params),
    execute: (sql, params) => query(sql, params),
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {}
  };
}

// ══════════════════════════════════════════════════════════════════
// FLUSH — debounced batch write to Sheets
// ══════════════════════════════════════════════════════════════════
function markDirty(table) {
  _dirtyTables.add(table);
  scheduleFlush();
}

function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flushNow().catch(err => console.error('  ❌ Sheets flush error:', err.message));
  }, FLUSH_DEBOUNCE_MS);
}

let _testMode = false;
async function flushNow() {
  if (!_initialized) return;
  if (_testMode) { _dirtyTables.clear(); return; }
  if (_flushInProgress) {
    return new Promise(resolve => _pendingFlushResolvers.push(resolve));
  }
  _flushInProgress = true;
  try {
    while (_dirtyTables.size > 0) {
      const snapshot = Array.from(_dirtyTables);
      _dirtyTables.clear();
      await writeTablesToSheet(snapshot);
    }
  } finally {
    _flushInProgress = false;
    const resolvers = _pendingFlushResolvers.splice(0);
    for (const r of resolvers) r();
  }
}

async function writeTablesToSheet(tables) {
  if (!tables.length) return;
  const api = await getApiClient();

  // Build batchUpdate data — full table overwrite (header + rows)
  const data = [];
  const clearRanges = [];
  for (const table of tables) {
    const cols = SCHEMA[table].cols;
    const derived = SHEET_DERIVED[table] || {};
    const derivedCols = Object.keys(derived);
    const allCols = [...cols, ...derivedCols];
    const rows = alasql.tables[table] ? alasql.tables[table].data : [];
    const dataRows = rows.map(r => {
      const base = cols.map(c => serializeForSheet(r[c]));
      const extra = derivedCols.map(d => derived[d](r));
      return [...base, ...extra];
    });
    const values = [allCols, ...dataRows];
    data.push({ range: `${table}!A1`, values });
    clearRanges.push(`${table}!A${values.length + 1}:ZZ`);
  }

  // Single batchUpdate call
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: _spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data }
  });
  // Clear excess (only if there's any chance of leftover; quick API call)
  try {
    await api.spreadsheets.values.batchClear({
      spreadsheetId: _spreadsheetId,
      requestBody: { ranges: clearRanges }
    });
  } catch (_) { /* non-critical */ }
}

// ══════════════════════════════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════════════════════════════
// Test-only: skip Sheets init and just create tables in-memory
async function _testInit() {
  for (const t of TABLE_NAMES) {
    const colsSql = SCHEMA[t].cols
      .map(c => `\`${c}\` ${c==='id' ? 'INT' : 'STRING'}`)
      .join(', ');
    alasql(`CREATE TABLE IF NOT EXISTS ${t} (${colsSql})`);
    _nextId[t] = 1;
  }
  // Prevent any auto Sheets write attempts
  _testMode = true;
  _initialized = true;
}

module.exports = {
  init,
  query,
  execute: query,
  getConnection,
  flushNow,
  // Test / debug helpers
  _alasql: alasql,
  _schema: SCHEMA,
  _testInit
};
