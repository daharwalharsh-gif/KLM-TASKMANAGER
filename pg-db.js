// ══════════════════════════════════════════════════════════════════
// pg-db.js — PostgreSQL backed in-memory database adapter
// ──────────────────────────────────────────────────────────────────
// • Drop-in replacement for sheets-db.js AND mysql2/promise pool:
//   db.query / db.execute / db.getConnection() — server.js me koi
//   change nahi chahiye (bas require ./pg-db).
// • Internally alasql (in-memory SQL engine) use karta hai — saari
//   reads MEMORY se aati hain (microseconds). server.js ki saari
//   MySQL-flavored SQL waise hi chalti hai jaise Sheets version me.
// • Writes pehle memory me (instant response), phir background me ek
//   debounced flush PostgreSQL pe (1.5 sec baad) — poori table ka
//   snapshot DELETE + bulk INSERT ek transaction me.
// • Connection `.env` se: PG_HOST, PG_PORT, PG_USER, PG_PASSWORD,
//   PG_DATABASE (ya ek single DATABASE_URL). Pehli baar tables auto
//   create hoti hain + default admin seed (admin@admin.com / admin).
// ══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const alasql = require('alasql');
const { Pool } = require('pg');

// ── Config ─────────────────────────────────────────────────────────
const FLUSH_DEBOUNCE_MS = 1500;
const MAX_CELL_CHARS = 45000;       // keep parity with sheets blob behaviour
const BLOB_DIR = path.join(__dirname, 'data', 'blobs');

// ── Schema (same as sheets-db.js — authoritative column order) ──────
// `cols` = column order ki authoritative list
// `autoFill` = INSERT pe agar column miss hai to ye default fill hoga
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
  },
  // Leave Tracker — user leave/WFH/extra-working applications. Admin approves.
  leave_tracker: {
    cols: ['id','user_id','type','reason','start_date','end_date','hours','status','applied_at','decided_by','decided_at','decision_note'],
    autoFill: { applied_at: 'NOW' }
  }
};

const TABLE_NAMES = Object.keys(SCHEMA);

// Which tables THIS adapter owns (loads from + flushes to Postgres). Default
// = all. In hybrid mode (hybrid-db.js) this is narrowed to e.g.
// ['users','checklist_tasks'] so the rest can live on Google Sheets. The
// alasql in-memory engine is a shared singleton, so cross-backend JOINs still
// work — only load/flush is scoped to these tables.
let _managed = TABLE_NAMES.slice();
function setManagedTables(list) {
  if (Array.isArray(list) && list.length) _managed = list.filter(t => SCHEMA[t]);
}

// Integer columns — DB se text/numeric aa sakti hain, alasql me daalne se
// pehle parse karte hain taaki SQL me arithmetic/IN comparisons sahi chalein.
const INT_COLS = new Set([
  'id','assigned_to','assigned_by','user_id','task_id','requested_by','requested_to',
  'employee_id','hod_id','target_count','improvement_pct','fms_id','step_id','step_order',
  'total_steps','header_row','from_user','to_user','waiting_approval','created_by','decided_by'
]);

// ══════════════════════════════════════════════════════════════════
// ALASQL CUSTOM FUNCTIONS (MySQL compatibility) — identical to sheets-db
// ══════════════════════════════════════════════════════════════════
function isoDate() { return new Date().toISOString().slice(0,10); }
function isoDateTime() { return new Date().toISOString().slice(0,19).replace('T',' '); }

alasql.fn.DATE_FORMAT = function (d, fmt) {
  if (d == null || d === '') return null;
  let s = String(d);
  if (fmt === '%Y-%m-%d') return s.length >= 10 ? s.slice(0,10) : s;
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
let _pool = null;
let _initialized = false;
let _initPromise = null;

const _dirtyTables = new Set();
let _flushTimer = null;
let _flushInProgress = false;
let _pendingFlushResolvers = [];

const _nextId = {};

// ══════════════════════════════════════════════════════════════════
// BLOB STORAGE (for large cells like profile images) — parity w/ sheets
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
function serializeForDb(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (s.length > MAX_CELL_CHARS) return blobStore(s);
  return s;
}
function deserializeFromDb(v) {
  if (typeof v === 'string' && v.startsWith('blob:')) return blobLoad(v);
  return v;
}
function parseCellValue(col, raw) {
  let v = deserializeFromDb(raw);
  if (v === undefined || v === null || v === '') {
    return INT_COLS.has(col) ? null : '';
  }
  if (INT_COLS.has(col)) {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  }
  return String(v);
}

// ══════════════════════════════════════════════════════════════════
// POSTGRES CLIENT
// ══════════════════════════════════════════════════════════════════
function buildPoolConfig() {
  // Prefer a single connection string if provided (DATABASE_URL / PG_URL).
  const url = (process.env.DATABASE_URL || process.env.PG_URL || '').trim();
  if (url) {
    return { connectionString: url, ssl: pgSsl() };
  }
  // Discrete config — robust for usernames/db-names with special chars
  // (e.g. "KLM-KLM" / "KLM -DB") that are painful to URL-encode.
  return {
    host: (process.env.PG_HOST || '').trim(),
    port: parseInt(process.env.PG_PORT || '5432', 10),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
    ssl: pgSsl(),
    max: parseInt(process.env.PG_POOL_MAX || '10', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000
  };
}
function pgSsl() {
  const mode = (process.env.PG_SSL || '').toLowerCase();
  if (mode === 'require' || mode === 'true' || mode === '1') {
    return { rejectUnauthorized: false };
  }
  return false;
}
function getPool() {
  if (_pool) return _pool;
  _pool = new Pool(buildPoolConfig());
  _pool.on('error', (err) => console.error('  ❌ PG pool error:', err.message));
  return _pool;
}
function qIdent(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

// ══════════════════════════════════════════════════════════════════
// LOAD — read every table from PG and (re)populate alasql.
// ══════════════════════════════════════════════════════════════════
async function loadAllTables(pool) {
  // PARALLEL load — saari managed tables ka SELECT ek saath. Serverless pe
  // har request se pehle reload hota hai, isliye 8 sequential round-trips ki
  // jagah ~1 round-trip = har request bahut fast.
  const results = await Promise.all(_managed.map(async (table) => {
    const cols = SCHEMA[table].cols;
    const colList = cols.map(qIdent).join(', ');
    let rows = [];
    try {
      const res = await pool.query(`SELECT ${colList} FROM ${qIdent(table)}`);
      rows = res.rows || [];
    } catch (err) {
      // Table might not exist yet on a fresh DB — treat as empty.
      rows = [];
    }
    const inserts = [];
    let maxId = 0;
    for (const raw of rows) {
      const obj = {};
      for (const col of cols) obj[col] = parseCellValue(col, raw[col]);
      if (obj.id && typeof obj.id === 'number' && obj.id > maxId) maxId = obj.id;
      inserts.push(obj);
    }
    return { table, inserts, maxId };
  }));
  let totalRows = 0;
  for (const { table, inserts, maxId } of results) {
    if (alasql.tables[table]) alasql.tables[table].data = inserts;
    _nextId[table] = maxId + 1;
    totalRows += inserts.length;
  }
  _lastReloadTs = Date.now();
  return totalRows;
}

// Per-request reload ko throttle karne ke liye — warm instance pe 3 sec ke
// andar aayi requests dobara DB load nahi karti (PG_RELOAD_TTL_MS se tunable).
let _lastReloadTs = 0;

// Force a fresh reload from PG. Skips while a flush is mid-flight or there
// are unsaved writes, so we don't clobber pending changes.
// force=true  → TTL ignore (mutations se pehle ZAROORI: flush full-table-rewrite
//   hai, isliye stale memory se overwrite na ho — warna dusre instance ka data
//   mit jaata hai). force=false (reads) → TTL throttle se fast.
async function reload(force) {
  if (!_initialized) return init();
  if (_testMode) return;
  if (_flushInProgress || _dirtyTables.size > 0) return;
  if (!force) {
    const ttl = parseInt(process.env.PG_RELOAD_TTL_MS || '3000', 10);
    if (ttl > 0 && (Date.now() - _lastReloadTs) < ttl) return;
  }
  const pool = getPool();
  await loadAllTables(pool);
}

// ══════════════════════════════════════════════════════════════════
// INIT — ensure tables exist in PG, then load into alasql
// ══════════════════════════════════════════════════════════════════
async function ensureSchema(pool) {
  // FAST PATH: ek hi query se check karo kaunsi tables pehle se hain. Sab maujood
  // ho (aur PG_MIGRATE nahi) to koi DDL nahi — cold start pe ~80 ALTER round-trips
  // bach jaate hain. DDL sirf tab jab table missing ho ya PG_MIGRATE=1 diya ho.
  const wantMigrate = /^(1|true|yes)$/i.test(process.env.PG_MIGRATE || '');
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name = ANY($1)`, [_managed]);
  const have = new Set(rows.map(r => r.table_name));
  const missing = _managed.filter(t => !have.has(t));
  if (!missing.length && !wantMigrate) return; // sab maujood — turant nikal jao

  for (const table of (wantMigrate ? _managed : missing)) {
    const cols = SCHEMA[table].cols;
    const colDefs = cols.map(c => {
      if (c === 'id') return `${qIdent(c)} INTEGER PRIMARY KEY`;
      return `${qIdent(c)} TEXT`;
    }).join(', ');
    await pool.query(`CREATE TABLE IF NOT EXISTS ${qIdent(table)} (${colDefs})`);
    if (wantMigrate) {
      // Missing columns add karo — sirf explicit migrate pe (schema evolve hua ho).
      for (const c of cols) {
        if (c === 'id') continue;
        await pool.query(`ALTER TABLE ${qIdent(table)} ADD COLUMN IF NOT EXISTS ${qIdent(c)} TEXT`);
      }
    }
  }
}

async function init() {
  if (_initialized) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const pool = getPool();

      // 1. Create alasql in-memory tables (id INT, rest STRING) — same as
      //    sheets-db: bulk load bypasses the PK index so `id` stays plain INT
      //    and uniqueness is managed via the _nextId counter.
      for (const t of _managed) {
        const colsSql = SCHEMA[t].cols
          .map(c => `\`${c}\` ${c==='id' ? 'INT' : 'STRING'}`)
          .join(', ');
        alasql(`CREATE TABLE IF NOT EXISTS ${t} (${colsSql})`);
      }

      // 2. Ensure PG tables + columns exist
      await ensureSchema(pool);

      // 3. Load managed tables into alasql
      const totalRows = await loadAllTables(pool);
      console.log(`  ✅ PostgreSQL DB loaded: ${totalRows} rows across ${_managed.length} tables (${_managed.join(', ')})`);

      // 4. Seed default admin if users table is empty (PLAIN TEXT password)
      //    Only when THIS adapter owns the users table.
      const userCount = _managed.includes('users') ? alasql('SELECT COUNT(*) AS c FROM users')[0].c : 1;
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

      // 5. Flush-on-exit — best-effort save before process exits
      const flushAndExit = async () => {
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
// SQL PREPROCESSING — identical to sheets-db.js (alasql runs the query)
// ══════════════════════════════════════════════════════════════════
function escapeAliases(sql) {
  return sql.replace(/'(?:[^'\\]|\\.)*'|\bAS\s+(\w+)\b/gi, (match, alias) => {
    if (!alias) return match;
    return `AS \`${alias}\``;
  });
}

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

function expandUpsert(sql, params) {
  const m = sql.match(/^\s*INSERT\s+INTO\s+`?(\w+)`?\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)\s*ON\s+DUPLICATE\s+KEY\s+UPDATE\s+(.+)$/is);
  if (!m) return null;
  const [, table, colsStr, valsStr, updateClause] = m;
  const cols = colsStr.split(',').map(c => c.trim().replace(/^`|`$/g, ''));
  const valTokens = valsStr.split(',').map(v => v.trim());
  return { table, cols, valTokens, updateClause: updateClause.trim(), params };
}

function applyInsertDefaults(table, sql, params) {
  const defaults = SCHEMA[table] && SCHEMA[table].autoFill;
  if (!defaults || !Object.keys(defaults).length) return { sql, params };
  const m = sql.match(/^\s*INSERT\s+INTO\s+`?\w+`?\s*\(([^)]+)\)\s*VALUES\s*(\(.+\))\s*$/is);
  if (!m) return { sql, params };
  const cols = m[1].split(',').map(c => c.trim().replace(/^`|`$/g, ''));
  const valuesPart = m[2];
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
    newValuesPart = valuesPart.replace(/\)\s*$/, extraValsSql + ')');
  } else {
    newValuesPart = valuesPart.replace(/\)(?=\s*(?:,|$))/g, extraValsSql + ')');
    const tuples = valuesPart.split(/\),\s*\(/).length;
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
  const out = [];
  for (let t = 0; t < tuples; t++) {
    const start = t * colsPerTuple;
    out.push(...params.slice(start, start + colsPerTuple));
    out.push(...extraParams);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
// QUERY API — identical translation layer to sheets-db.js
// ══════════════════════════════════════════════════════════════════
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
  if (/^\s*(ALTER|CREATE\s+TABLE|DROP|CREATE\s+INDEX)/i.test(sqlTrim)) {
    return [[], []];
  }
  if (/^\s*SELECT\s+1\s*$/i.test(sqlTrim)) {
    return [[{ '1': 1 }], []];
  }

  const bulk = expandBulkInsert(sqlTrim, params);
  if (bulk) {
    const withDefaults = applyInsertDefaults(bulk.table, bulk.sql, bulk.params);
    return executeMutation(withDefaults.sql, withDefaults.params, bulk.table);
  }

  const upsert = expandUpsert(sqlTrim, params);
  if (upsert) {
    return executeUpsert(upsert);
  }

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

function injectAutoId(table, sql, params) {
  if (!SCHEMA[table]) return null;
  const m = sql.match(/^(\s*INSERT\s+INTO\s+`?\w+`?\s*\()([^)]+)(\)\s*VALUES\s*)(.+)$/is);
  if (!m) return null;
  const colsList = m[2].split(',').map(c => c.trim().replace(/^`|`$/g, ''));
  if (colsList.includes('id')) {
    return null;
  }
  const valuesPart = m[4].trim().replace(/;$/, '');
  const tupleStarts = [];
  let depth = 0;
  for (let i = 0; i < valuesPart.length; i++) {
    const ch = valuesPart[i];
    if (ch === '(') { if (depth === 0) tupleStarts.push(i); depth++; }
    else if (ch === ')') depth--;
  }
  const tuples = tupleStarts.length || 1;
  let actualMax = 0;
  const _rows = alasql.tables[table] && alasql.tables[table].data;
  if (_rows && _rows.length) {
    for (const r of _rows) { const v = parseInt(r.id, 10); if (v > actualMax) actualMax = v; }
  }
  const startId = Math.max(_nextId[table] || 1, actualMax + 1);
  const newColsList = ['id', ...colsList];

  let newValues = valuesPart;
  let idAdded = 0;
  newValues = newValues.replace(/\(/g, () => {
    const thisId = startId + idAdded;
    idAdded++;
    return `(${thisId},`;
  });

  _nextId[table] = startId + tuples;
  const newSql = `${m[1].replace(/\(\s*$/, '(')}${newColsList.join(',')}${m[3]}${newValues}`;
  return {
    sql: newSql,
    params,
    insertId: startId,
    insertedCount: tuples
  };
}

const UNIQUE_KEYS = {
  week_plans: ['employee_id', 'start_date']
};
function executeUpsert({ table, cols, valTokens, updateClause, params }) {
  const keys = UNIQUE_KEYS[table];
  if (!keys || !keys.length) {
    const insertSql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${valTokens.join(',')})`;
    return executeMutation(insertSql, params, table);
  }
  const colValMap = {};
  let pIdx = 0;
  for (let i = 0; i < cols.length; i++) {
    if (valTokens[i] === '?') {
      colValMap[cols[i]] = params[pIdx++];
    } else {
      colValMap[cols[i]] = unquoteSqlLiteral(valTokens[i]);
    }
  }
  const whereSql = keys.map(k => `${k} = ?`).join(' AND ');
  const whereVals = keys.map(k => colValMap[k]);
  const existing = alasql(`SELECT id FROM ${table} WHERE ${whereSql}`, whereVals);

  if (existing.length === 0) {
    const insertSql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${valTokens.join(',')})`;
    const [res] = executeMutation(insertSql, params, table);
    return [{ affectedRows: 1, insertId: res.insertId }, []];
  }
  const id = existing[0].id;
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
      const mm2 = part.match(/^`?(\w+)`?\s*=\s*(.+)$/i);
      if (mm2) {
        setSql.push(`${mm2[1]} = ${mm2[2]}`);
      }
    }
  }
  if (SCHEMA[table].cols.includes('updated_at')) {
    setSql.push(`updated_at = ?`);
    setParams.push(isoDateTime());
  }
  alasql(`UPDATE ${table} SET ${setSql.join(', ')} WHERE id = ?`, [...setParams, id]);
  markDirty(table);
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
// CONNECTION (transaction mock — alasql is in-memory; commit/rollback
// are best-effort no-ops, same as sheets-db.js)
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
// FLUSH — debounced snapshot write to PostgreSQL
// ══════════════════════════════════════════════════════════════════
function markDirty(table) {
  _dirtyTables.add(table);
  scheduleFlush();
}

function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flushNow().catch(err => console.error('  ❌ PG flush error:', err.message));
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
      // Write first; only clear dirty on SUCCESS. If a write fails
      // (network/auth) tables stay dirty so the next flush retries and no
      // data is lost.
      await writeTablesToPg(snapshot);
      snapshot.forEach(t => _dirtyTables.delete(t));
    }
  } finally {
    _flushInProgress = false;
    const resolvers = _pendingFlushResolvers.splice(0);
    for (const r of resolvers) r();
  }
}

// Full snapshot per dirty table: DELETE all + bulk INSERT current rows,
// inside a transaction so a crash never leaves a half-written table.
async function writeTablesToPg(tables) {
  if (!tables.length) return;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of tables) {
      const cols = SCHEMA[table].cols;
      const rows = alasql.tables[table] ? alasql.tables[table].data : [];
      await client.query(`DELETE FROM ${qIdent(table)}`);
      if (rows.length) {
        const colSql = cols.map(qIdent).join(', ');
        // Chunk inserts to stay well under the 65535 bind-param limit.
        const maxParams = 60000;
        const rowsPerChunk = Math.max(1, Math.floor(maxParams / cols.length));
        for (let start = 0; start < rows.length; start += rowsPerChunk) {
          const chunk = rows.slice(start, start + rowsPerChunk);
          const valuesSql = [];
          const flat = [];
          let p = 1;
          for (const r of chunk) {
            const ph = cols.map(() => `$${p++}`);
            valuesSql.push(`(${ph.join(', ')})`);
            for (const c of cols) flat.push(serializeForDb(r[c]));
          }
          await client.query(
            `INSERT INTO ${qIdent(table)} (${colSql}) VALUES ${valuesSql.join(', ')}`,
            flat
          );
        }
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

// ══════════════════════════════════════════════════════════════════
// WRITE REPORT TAB — parity shim for the MIS "export to sheet" feature.
// PG has no "tabs"; we persist the 2D report into a standalone table
// `report_<slug>` (dropped + recreated each call) so the data is still
// stored and queryable. This table is NOT part of TABLE_NAMES, so
// init()/reload()/flush() never touch it.
// ══════════════════════════════════════════════════════════════════
async function writeReportTab(title, rows) {
  if (!_initialized) await init();
  const pool = getPool();
  const safe = (rows || []).map(row => (Array.isArray(row) ? row : [row]).map(cell => {
    if (cell === null || cell === undefined) return '';
    let s = String(cell);
    if (s.length > MAX_CELL_CHARS) s = s.slice(0, MAX_CELL_CHARS);
    return s;
  }));
  const slug = 'report_' + String(title).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const width = safe.reduce((w, r) => Math.max(w, r.length), 1);
  const colNames = Array.from({ length: width }, (_, i) => `c${i + 1}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DROP TABLE IF EXISTS ${qIdent(slug)}`);
    await client.query(
      `CREATE TABLE ${qIdent(slug)} (row_no INTEGER, ${colNames.map(c => `${qIdent(c)} TEXT`).join(', ')})`
    );
    for (let i = 0; i < safe.length; i++) {
      const r = safe[i];
      const vals = colNames.map((_, j) => (j < r.length ? r[j] : ''));
      const ph = vals.map((_, j) => `$${j + 2}`).join(', ');
      await client.query(
        `INSERT INTO ${qIdent(slug)} (row_no, ${colNames.map(qIdent).join(', ')}) VALUES ($1, ${ph})`,
        [i, ...vals]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
  return { rows: safe.length, table: slug };
}

// ══════════════════════════════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════════════════════════════
async function _testInit() {
  for (const t of TABLE_NAMES) {
    const colsSql = SCHEMA[t].cols
      .map(c => `\`${c}\` ${c==='id' ? 'INT' : 'STRING'}`)
      .join(', ');
    alasql(`CREATE TABLE IF NOT EXISTS ${t} (${colsSql})`);
    _nextId[t] = 1;
  }
  _testMode = true;
  _initialized = true;
}

// Close the pool (used by migration scripts / graceful shutdown)
async function end() {
  if (_pool) { await _pool.end(); _pool = null; }
}

module.exports = {
  init,
  reload,
  query,
  execute: query,
  getConnection,
  flushNow,
  writeReportTab,
  end,
  setManagedTables,
  detectMutationTable,
  // Test / debug helpers
  _alasql: alasql,
  _schema: SCHEMA,
  _testInit,
  _getPool: getPool,
  _loadAllTables: loadAllTables
};
