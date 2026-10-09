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
    cols: ['id','name','title','email','notification_email','password','role','phone','profile_image','department','week_off','extra_off'],
    autoFill: {}
  },
  delegation_tasks: {
    cols: ['id','description','assigned_to','assigned_by','due_date','status','priority','approval','waiting_approval','remarks','created_at','last_reminder_date','completed_at','completed_by'],
    autoFill: { created_at: 'NOW' }
  },
  checklist_tasks: {
    cols: ['id','description','assigned_to','assigned_by','due_date','status','priority','remarks','frequency','created_at','completed_at','completed_by'],
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
    cols: ['id','fms_id','step_order','step_name','plan_col','actual_col','extra_input','extra_col','show_cols','delay_reason_col','doer_name_col','doer_filter_col','doer_filter_map'],
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
  },
  // Open Challenges — party ki challenge/complaint, responsible person + resolution tracking.
  // files = JSON array [{name, link}] (upload /api/challenges/upload-file se)
  challenges: {
    cols: ['id','party_name','received_date','known_date','description','crm','responsible_to','priority','proposed_resolution','status','files','done_remarks','done_files','done_at','done_by','created_by','created_at','updated_at'],
    autoFill: { created_at: 'NOW', updated_at: 'NOW' }
  },
  // Master Sheet — K L Mahajan & Sons ka process master (Google Sheet ka mirror)
  master_sheet: {
    cols: ['id','process_name','measurable_result','pc','problem_solver','executive','fms','fms_link','pms','pms_link','checklist','checklist_link','row_color','sort_order','created_at','updated_at'],
    autoFill: { created_at: 'NOW', updated_at: 'NOW' }
  },
  // Invincible Catalogues — naam + PDF (PDF fms_files me, link yahan)
  catalogues: {
    cols: ['id','name','file_name','file_link','sort_order','created_by','created_at'],
    autoFill: { created_at: 'NOW' }
  },
  // Legal Case tracking form — case band hone tak "pending", Done par "completed"
  legal_cases: {
    cols: ['id','case_ref','initiated_on','court_forum','case_type','case_status','priority',
           'complainant','defendant','party_address','contact_no','email_id','gst_no',
           'purpose','purpose_other',
           'handled_by','department','handler_contact','handler_email','reporting_to',
           'background','claim_amount','cheque_no','cheque_date','bank_name','due_date',
           'overall_status','strength','risk','remarks',
           'documents','documents_other','files',
           'closed_on','final_outcome','amount_recovered','closure_remarks',
           'decl_name','decl_date',
           'status','created_by','created_at','updated_at','done_at','done_by'],
    autoFill: { created_at: 'NOW', updated_at: 'NOW' }
  },
  // Production Management — sheet se Buyer/PI/Amount aate hain, ye column
  // yahin app me bharte hain (row_key = PI number + order date).
  production_rows: {
    cols: ['id','row_key','pi_no','description','amount','inr_working','planned_otd',
           'planned_production','dispatch_date','dispatched_dates','dispatch_remarks','updated_by','updated_at'],
    autoFill: { updated_at: 'NOW' }
  },
  // Daily PC Report — har FMS ka daily review: PC + doer-wise remarks, owner/PC remarks.
  // doer_remarks = JSON array [{userId, name, remark}]
  pc_reports: {
    cols: ['id','fms_id','fms_name','pc_name','doer_remarks','owner_remarks','pc_remarks',
           'priority','status','created_by','created_at','updated_at',
           'done_remarks','done_at','done_by'],
    autoFill: { created_at: 'NOW', updated_at: 'NOW' }
  },
  // Daily PC Report ke andar jitni baar remark add ho — har ek ki alag row
  pc_report_updates: {
    cols: ['id','report_id','remark','entered_by','entered_by_name','created_at'],
    autoFill: { created_at: 'NOW' }
  },
  // PPC — PMS Garments / Boxing ke order par manual column
  // (row_key = sheetKey + '|' + unique id)
  ppc_rows: {
    cols: ['id','row_key','sheet_key','unique_id','delivery_date','priority','status_text','updated_by','updated_at'],
    autoFill: { updated_at: 'NOW' }
  },
  // Employee to Employee Feedback Form — bharne ke baad Completed me (sirf admin dekhta hai)
  feedback_forms: {
    cols: ['id','your_name','department','feedback_for','employee_department','employee_is',
           'suggestions','rating','submitted_by','submitted_by_name','submitted_by_email','created_at'],
    autoFill: { created_at: 'NOW' }
  },
  // Har hearing / update ki ek row — case ke andar tracker table
  legal_case_updates: {
    cols: ['id','case_id','hearing_date','proceedings','documents_filed','court_order',
           'next_hearing_date','follow_up','files','entered_by','created_at'],
    autoFill: { created_at: 'NOW' }
  },
  // Company ki chhutti list — sabko dikhti hai, add/remove sirf admin
  holidays: {
    cols: ['id','holiday_date','name','created_by','created_at'],
    autoFill: { created_at: 'NOW' }
  },
  // PC Reporting — Sampling FMS ke pending steps par likhe gaye remarks
  pc_report_notes: {
    cols: ['id','row_key','step_no','remark','updated_by','updated_at'],
    autoFill: { updated_at: 'NOW' }
  },
  // FMS step ka Google Drive reference link — ek step ka ek link, sabko dikhta hai
  step_drive_links: {
    cols: ['id','fms_id','step_id','link','updated_by','updated_at'],
    autoFill: { updated_at: 'NOW' }
  },
  // PPC Orders tab me haath se daali gayi date — har order row ke har department ki
  // apni. Google Sheet me kuch nahi likha jaata; ye app ka apna record hai.
  ppc_manual_dates: {
    cols: ['id','sheet','row_key','step_no','manual_date','updated_by','updated_at'],
    autoFill: { updated_at: 'NOW' }
  },
  // Master Rate List — ek style ka operation-wise rate chart. Grid (operations,
  // rate, date-wise pcs/amount) aur attachments JSON me rehte hain, jaise
  // legal_cases.files. "pending" me bante hain, Complete par "completed".
  rate_lists: {
    cols: ['id','list_name','buyer','style','status','date_cols','rows_json','files_json',
           'created_by','created_at','updated_at','completed_at','completed_by',
           'kind','sheet_date','fabric','gsm'],
    autoFill: { created_at: 'NOW', updated_at: 'NOW' }
  },
  // Time Scheduler — roz ka routine (sirf allowed emails)
  time_schedules: {
    cols: ['id','user_id','sch_date','start_time','end_time','title','remarks','status','created_at','completed_at'],
    autoFill: { created_at: 'NOW' }
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
  'total_steps','header_row','from_user','to_user','waiting_approval','created_by','decided_by','sort_order',
  'case_id','report_id'
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
// ── Kaunsi ROWS badli hain ──────────────────────────────────────────
// Pehle flush poori table DELETE karke memory se dobara likhta tha. Serverless
// par kai instance chalte hain: jis instance ki memory purani hai uska flush
// doosre instance ke naye writes MITA deta tha — isliye "Done kiya hua task
// thodi der baad wapas pending" ho jaata tha. Ab flush sirf UNHI rows ko
// chhoota hai jo is instance ne badli hain (upsert) ya hataayi hain (delete).
// Jahan rows ka pata na chale (bina WHERE ka update, ajeeb SQL) wahan purana
// poora-rewrite hi hota hai — taaki kabhi kuch chhoote na.
const _dirtyIds = new Map();      // table -> Set(id) — upsert karni hain
const _deletedIds = new Map();    // table -> Set(id) — hatani hain
const _fullRewrite = new Set();   // table -> poora rewrite (fallback)

function _idSet(map, table) {
  let s = map.get(table);
  if (!s) { s = new Set(); map.set(table, s); }
  return s;
}
function noteRows(table, ids) {
  if (!table || !ids || !ids.length) return;
  const dirty = _idSet(_dirtyIds, table), gone = _idSet(_deletedIds, table);
  for (const id of ids) { const k = String(id); dirty.add(k); gone.delete(k); }
}
function noteDeleted(table, ids) {
  if (!table || !ids || !ids.length) return;
  const dirty = _idSet(_dirtyIds, table), gone = _idSet(_deletedIds, table);
  for (const id of ids) { const k = String(id); gone.add(k); dirty.delete(k); }
}
function noteFull(table) { if (table) _fullRewrite.add(table); }
function clearRowMarks(table) {
  _dirtyIds.delete(table); _deletedIds.delete(table); _fullRewrite.delete(table);
}

// UPDATE/DELETE kis-kis id par lagega — wahi WHERE alasql par chala kar.
// null lauta to matlab "pata nahi" → poora rewrite (safe side).
function idsForWhere(sql, params, table) {
  try {
    if (!table || !alasql.tables[table]) { if (process.env.PGDB_DEBUG) console.error('idsForWhere: table nahi', table); return null; }
    if (/\bSELECT\b/i.test(sql)) return null;          // subquery — risk nahi lena
    const wm = /\bWHERE\b/i.exec(sql);
    if (!wm) { if (process.env.PGDB_DEBUG) console.error('idsForWhere: WHERE nahi |', sql); return null; }
    const before = sql.slice(0, wm.index);
    const where = sql.slice(wm.index + wm[0].length);
    if (/\bWHERE\b/i.test(where)) return null;         // ek se zyada WHERE
    const qBefore = (before.match(/\?/g) || []).length;
    const wParams = (params || []).slice(qBefore);
    const rows = alasql(`SELECT id FROM ${table} WHERE ${where}`, wParams);
    return (rows || []).map(r => String(r.id));
  } catch (e) { if (process.env.PGDB_DEBUG) console.error('idsForWhere fail:', e.message, '|', sql); return null; }
}

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
  // Serverless (Vercel): pool max=8 taaki per-request reload (8 tables Promise.all)
  // ek hi wave me chale — 3 rakhne se queries queue hoti thi aur load par kuch
  // instances ka reload adhoora/slow hota tha (data blink karta tha). 8 tables ke
  // liye 8 connections ideal. idle 10s me release taaki shared PG ke 100 slots free
  // rahein (leftover local test servers band karna is footgun ka asli ilaaj hai).
  const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  return {
    host: (process.env.PG_HOST || '').trim(),
    port: parseInt(process.env.PG_PORT || '5432', 10),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
    ssl: pgSsl(),
    max: parseInt(process.env.PG_POOL_MAX || (isServerless ? '8' : '10'), 10),
    idleTimeoutMillis: isServerless ? 10000 : 30000,
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
// ══ LOAD vs WRITE race ══
// Harsh (30 Sep 2026): "23 tarikh tak ke saare task done kiye, phir se pending me aa gaye".
// Load (saari tables ka SELECT) me aadha-ek second lagta hai. Isi beech is
// instance par kisi aur request ne task Done likha, to load khatam hote hi
// Done se PEHLE ki copy memory par chipak jaati thi — aur flush wahi purani
// (pending) row DB me likh deta tha. Done kho jaata tha, ya screen par wapas
// pending dikhta tha. Ab: load ke beech is instance par kuch bhi likha gaya ho
// (ya flush chal raha ho, ya baad me shuru hua load pehle lag chuka ho), to ye
// load chhod dete hain — memory me jo taaza likha hai wahi rehta hai. Agli
// request phir se load karti hai.
let _writeGen = 0;                 // har write par +1 (markDirty)
let _loadSeq = 0, _appliedLoadSeq = 0;

// ══ TEZ RELOAD — sirf badli hui tables ══
// Harsh (2 Oct 2026): "loading hi dikhta hai bahut der tak". Har request se
// pehle saari tables (~20k rows) dobara padhi jaati thin — 1-2 second har baar,
// jabki dashboard ki apni query 60 ms ki hai. Ab har flush jis table me likhta
// hai uska version (_pg_versions) +1 karta hai; reload pehle EK chhoti query se
// versions dekhta hai aur sirf badli hui tables padhta hai. App ke bahar se
// (script / SQL) badla data bhi pakka aaye, isliye har 60 sec me ek baar poora load.
const VERSIONS_TABLE = '_pg_versions';
// Harsh (8 Oct 2026): "fast working nahi". Ye poora load har baar ~19,000
// checklist rows khinchta hai; har minute chalne par usi waqt ki requests
// connection ke liye line me lagti thin (aur kabhi padhna fail ho jaata tha).
// App ke saare likhe badlav version se turant aate hain — ye sirf app ke BAHAR
// (script / SQL) se badla data pakadne ke liye hai, isliye 5 minute kaafi hai.
const FULL_RELOAD_MS = parseInt(process.env.PG_FULL_RELOAD_MS || '300000', 10);
let _versionsReady = false;
const _loadedVer = {};             // table -> version jo is memory me hai
let _lastFullLoadTs = 0;
let _lastLoadFailed = [];          // pichhle load me jo tables padh nahi paaye

async function ensureVersions(pool) {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${qIdent(VERSIONS_TABLE)} (tbl TEXT PRIMARY KEY, ver BIGINT NOT NULL DEFAULT 0)`);
    _versionsReady = true;
  } catch (e) {
    _versionsReady = false;        // na bani to pehle jaisa — har baar poora load
    console.error('  ⚠️ versions table nahi bani — poora load chalega:', e.message);
  }
}
async function readVersions(pool) {
  if (!_versionsReady) return null;
  try {
    const { rows } = await pool.query(`SELECT tbl, ver FROM ${qIdent(VERSIONS_TABLE)}`);
    const v = {};
    for (const r of rows) v[r.tbl] = String(r.ver);
    return v;
  } catch (e) { return null; }
}
// Flush ke baad — jin tables me likha unka version +1 (doosre instance jaan jaayein)
async function bumpVersions(client, tables) {
  if (!_versionsReady || !tables.length) return;
  try {
    await client.query(
      `INSERT INTO ${qIdent(VERSIONS_TABLE)} (tbl, ver) SELECT unnest($1::text[]), 1
       ON CONFLICT (tbl) DO UPDATE SET ver = ${qIdent(VERSIONS_TABLE)}.ver + 1`, [tables]);
  } catch (e) {
    // Data likh chuka hai; version na badla to doosre instance 60 sec ke poore load me dekh lenge
    console.error('  ⚠️ version bump failed:', e.message);
  }
}

// onlyChanged=true (padhne wali requests): sirf wo tables jinka version badla.
// Warna (init / save se pehle) — poora load, pehle jaisa.
async function loadAllTables(pool, onlyChanged) {
  const mySeq = ++_loadSeq;
  const genAtStart = _writeGen;
  const startTs = performance.now();                // versions isi pal ke baad padhe gaye
  const vers = await readVersions(pool);           // data padhne se PEHLE
  // (60 sec wala poora load reload() peeche se alag chalata hai — yahan nahi)
  const full = !onlyChanged || !vers;
  const tables = full ? _managed
    : _managed.filter(t => (vers[t] || '0') !== _loadedVer[t]);
  if (!tables.length) {            // kuch nahi badla — DB padhne ki zaroorat hi nahi
    _lastReloadTs = Date.now();
    if (startTs > _lastFreshStartTs) _lastFreshStartTs = startTs;
    return 0;
  }
  // PARALLEL load — chuni hui tables ka SELECT ek saath.
  // ══ PADHNA FAIL = PURANI COPY RAKHO (Harsh, 8 Oct 2026) ══
  // "Checklist ka data show kyu nahi ho raha": pehle SELECT me koi bhi error
  // (network ki chhoti gadbad, connection ka intezaar lamba) aata to table ko
  // KHAALI maan kar memory me laga dete the — dashboard par checklist 0 ho
  // jaati thi (sirf delegation ki ginti dikhti), aur version likh dene ki wajah
  // se agle 60 sec tak dobara padhi bhi nahi jaati thi. Ab: 2 baar aur koshish;
  // phir bhi na mile to us table ki purani copy hi rehti hai aur agli request
  // use dobara padhti hai. Khaali sirf tab maante hain jab table bani hi na ho.
  const results = await Promise.all(tables.map(async (table) => {
    const cols = SCHEMA[table].cols;
    const colList = cols.map(qIdent).join(', ');
    let rows = [];
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await pool.query(`SELECT ${colList} FROM ${qIdent(table)}`);
        rows = res.rows || [];
        break;
      } catch (err) {
        if (err && err.code === '42P01') { rows = []; break; }   // naya DB — table abhi bani nahi
        if (attempt >= 2) {
          console.error(`  ⚠️ ${table} padh nahi paaye (${err && err.message}) — purani copy rakhi`);
          return { table, failed: true };
        }
        await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
      }
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
  if (_writeGen !== genAtStart || _dirtyTables.size > 0 || _flushInProgress || mySeq < _appliedLoadSeq) {
    return null;                   // purani copy — mat lagao
  }
  _appliedLoadSeq = mySeq;
  let totalRows = 0;
  const failed = [];
  for (const { table, inserts, maxId, failed: bad } of results) {
    // padh nahi paaye — memory me jo hai wahi rahe, version bhi purana rahe
    // taaki agli request ise phir se padhe
    if (bad) { failed.push(table); delete _loadedVer[table]; continue; }
    if (alasql.tables[table]) alasql.tables[table].data = inserts;
    _nextId[table] = maxId + 1;
    totalRows += inserts.length;
    // Is table ka kaunsa version memory me hai (versions na mile to agli baar phir padho)
    if (vers) _loadedVer[table] = vers[table] || '0'; else delete _loadedVer[table];
  }
  _lastLoadFailed = failed;
  if (full && !failed.length) _lastFullLoadTs = Date.now();
  _lastReloadTs = Date.now();
  if (!failed.length && startTs > _lastFreshStartTs) _lastFreshStartTs = startTs;
  return totalRows;
}

// Per-request reload ko throttle karne ke liye — warm instance pe TTL ke
// andar aayi requests dobara DB nahi dekhti (PG_RELOAD_TTL_MS se tunable).
let _lastReloadTs = 0;
let _inflightRead = null;          // chal raha padhne wala load (saath wali requests isi par)
let _inflightStartTs = 0;          // wo load kab shuru hua
let _lastFreshStartTs = 0;         // aakhri poore lage load ki shuruaat (versions isi ke baad padhe)
let _bgFullLoad = null;            // peeche chal raha 60-sec wala poora load
// ══ JO LIKHA WAHI DIKHE (Harsh, 9 Oct 2026) ══
// "Task delete kiya fir bhi dikh raha, Done kiya fir Pending dikh raha" — database
// sahi tha, par list doosre instance se aati thi jo (a) 1 sec ke andar taaza hua
// tha to bina dekhe purani memory de deta, ya (b) pehle se chal rahe load ke saath
// jud jaata jo user ke Delete/Done se PEHLE shuru hua tha. Ab request sirf usi
// load ka bharosa karti hai jo uske aane ke baad shuru hua — tab tak user ka
// likha database me pakka ho chuka hota hai. Warna versions ki ek chhoti query
// khud chalti hai. Bilkul ek saath aayi requests ab bhi ek hi load share karti
// hain; thoda baad aayi request pehle wale ke baad ek chhoti versions query aur.
// Samay performance.now() se (millisecond se bareek). 5ms ki chhoot: ek saath aayi
// requests ek load share karein. Surakshit hai — user ki agli request uske save ke
// kam se kam ek network chakkar (10ms+) baad hi aati hai.
const READ_SLACK_MS = 5;

// Force a fresh reload from PG. Skips while a flush is mid-flight or there
// are unsaved writes, so we don't clobber pending changes.
// force=true  → TTL ignore (mutations se pehle ZAROORI: flush full-table-rewrite
//   hai, isliye stale memory se overwrite na ho — warna dusre instance ka data
//   mit jaata hai). force=false (reads) → TTL throttle se fast.
async function reload(force) {
  const arrivedAt = performance.now();
  if (!_initialized) return init();
  if (_testMode) return;
  if (_flushInProgress) return;
  // Dirty tables pade hain to pehle unhe likh do. Pehle yahan seedha `return`
  // tha — ek bhi flush fail ho jaaye (network blip) to table hamesha dirty
  // reh jaata tha aur ye instance DOBARA KABHI reload nahi karta tha. Nateeja:
  // done kiya hua task screen par wapas pending dikhta tha, jabki DB me sahi
  // tha. Ab likhne ki koshish karo; ho gaya to fresh data uthao.
  if (_dirtyTables.size > 0) {
    try { await flushNow(); } catch (e) { return; }   // na likh paaye to purana hi sahi
    if (_dirtyTables.size > 0) return;
  }
  if (!force) {
    const fresh = ts => ts >= arrivedAt - READ_SLACK_MS;   // ye load is request ke liye kaafi taaza hai?
    // Is request ke aane ke baad shuru hua load pehle hi lag chuka — dobara mat dekho
    if (fresh(_lastFreshStartTs)) return;
    // Ek saath aayi requests (dashboard ek saath 5-6 bhejta hai) ek hi load ka intezaar
    // karti hain — par sirf tab jab wo load is request ke aas-paas shuru hua ho.
    if (_inflightRead) {
      if (fresh(_inflightStartTs)) return _inflightRead;
      try { await _inflightRead; } catch (e) {}       // purana load — khatam hone do, phir taaza dekho
      if (fresh(_lastFreshStartTs)) return;
      if (_inflightRead && fresh(_inflightStartTs)) return _inflightRead;
      if (_flushInProgress || _dirtyTables.size > 0) return;
    }
    const pool = getPool();
    // 60 sec wala poora load (sirf app ke bahar se badla data pakadne ke liye)
    // PEECHE chalta hai — koi request uska intezaar nahi karti. Live par isi se
    // har minute kuch requests 2-2.5 sec ki ho jaati thin.
    if ((Date.now() - _lastFullLoadTs) > FULL_RELOAD_MS && !_bgFullLoad) {
      _bgFullLoad = loadAllTables(pool)
        .catch(e => console.error('  ⚠️ background full load failed:', e.message))
        .finally(() => { _bgFullLoad = null; });
    }
    // Jo tables sach me badli hain wo abhi (request se pehle) padhi jaati hain
    _inflightStartTs = performance.now();
    const p = loadAllTables(pool, true).finally(() => { if (_inflightRead === p) _inflightRead = null; });
    _inflightRead = p;
    return p;
  }
  const pool = getPool();
  const loaded = await loadAllTables(pool);
  // Mutation se pehle wala load beech ke write ki wajah se chhoot gaya — apna
  // likha DB me bhejo aur ek baar aur taaza lao.
  if (loaded === null && force) {
    if (_dirtyTables.size > 0) { try { await flushNow(); } catch (e) { return; } }
    if (!_flushInProgress && _dirtyTables.size === 0) await loadAllTables(pool);
  }
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
      await ensureVersions(pool);   // tez reload ke liye table-versions
      await ensureIds(pool);        // naye record ki id sab instance me alag

      // 3. Load managed tables into alasql
      const totalRows = (await loadAllTables(pool)) || 0;
      // Koi table padh nahi paaye to shuruaat yahin rok do (agli request phir
      // koshish karegi). Aage badhte to khaali users dekh kar neeche wala
      // "default admin" ban jaata — sabka login band aur admin/admin khula.
      if (_lastLoadFailed.length) {
        throw new Error('PG load adhoora — ye tables padh nahi paaye: ' + _lastLoadFailed.join(', '));
      }
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
    return withReservedIds(bulk.table, withDefaults.sql,
      () => executeMutation(withDefaults.sql, withDefaults.params, bulk.table));
  }

  const upsert = expandUpsert(sqlTrim, params);
  if (upsert) {
    // naya record bana to 1 id chahiye (pehle se ho to update — id bekaar, koi baat nahi)
    return withReservedIds(upsert.table, `INSERT INTO ${upsert.table} (${upsert.cols.join(',')}) VALUES (?)`,
      () => executeUpsert(upsert));
  }

  const mutationTable = detectMutationTable(sqlTrim);
  if (mutationTable) {
    let processedSql = sqlTrim;
    let processedParams = params;
    if (/^INSERT/i.test(sqlTrim)) {
      const withDefaults = applyInsertDefaults(mutationTable, processedSql, processedParams);
      processedSql = withDefaults.sql;
      processedParams = withDefaults.params;
      return withReservedIds(mutationTable, processedSql,
        () => executeMutation(processedSql, processedParams, mutationTable));
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
  // UPDATE/DELETE chalne se PEHLE dekh lo kis-kis id par lagega
  const isUpd = /^\s*UPDATE/i.test(sql);
  const isDel = /^\s*DELETE/i.test(sql);
  const hitIds = (isUpd || isDel) ? idsForWhere(sql, params, table) : null;

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
  if (table) {
    markDirty(table);
    if (/^\s*INSERT/i.test(sql)) {
      if (injectedId) {
        const ids = [];
        for (let i = 0; i < injectedId.insertedCount; i++) ids.push(injectedId.insertId + i);
        noteRows(table, ids);
      } else noteFull(table);       // id ka pata nahi — poora rewrite
    } else if (isUpd) {
      if (hitIds) noteRows(table, hitIds); else noteFull(table);
    } else if (isDel) {
      if (hitIds) noteDeleted(table, hitIds); else noteFull(table);
    } else noteFull(table);
  }
  const result = {
    affectedRows: typeof affected === 'number' ? affected : 0,
    insertId: injectedId ? injectedId.insertId : null
  };
  return [result, []];
}

// ══ NAYI ID — SAB INSTANCE ME ALAG (Harsh, 9 Oct 2026) ══
// Pehle har instance apni memory dekh kar id deta tha (sabse badi + 1). Do
// instance lagbhag ek saath (1-3 sec ke andar) usi table me naya record banate
// to dono ek hi id dete — aur doosra save pehle wale ke UPAR likh deta: task,
// approval request, transfer chupchaap gayab. Ab id Postgres ke ek chhote
// counter (_pg_ids) se lock ke saath aati hai — do instance kabhi ek id nahi
// paate. Counter hamesha table ki asli sabse badi id se aage rehta hai.
const IDS_TABLE = '_pg_ids';
let _idsReady = false;
async function ensureIds(pool) {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${qIdent(IDS_TABLE)} (tbl TEXT PRIMARY KEY, next BIGINT NOT NULL DEFAULT 1)`);
    _idsReady = true;
  } catch (e) {
    _idsReady = false;             // na bani to pehle jaisa (sirf memory se id)
    console.error('  ⚠️ ids table nahi bani — id pehle jaise memory se:', e.message);
  }
}
// INSERT me kitni nayi rows hain jinki id hume deni hai (id khud di ho to 0)
function countAutoIdRows(table, sql) {
  if (!SCHEMA[table] || !_managed.includes(table)) return 0;
  const m = sql.match(/^(\s*INSERT\s+INTO\s+`?\w+`?\s*\()([^)]+)(\)\s*VALUES\s*)(.+)$/is);
  if (!m) return 0;
  if (m[2].split(',').map(c => c.trim().replace(/^`|`$/g, '')).includes('id')) return 0;
  const valuesPart = m[4].trim().replace(/;$/, '');
  let depth = 0, tuples = 0;
  for (const ch of valuesPart) {
    if (ch === '(') { if (depth === 0) tuples++; depth++; }
    else if (ch === ')') depth--;
  }
  return tuples || 1;
}
// Insert se theek pehle: Postgres se n ids ka khaali hissa le lo. Jo hissa mila
// wahi is insert ko milta hai (_reservedId) — ek hi instance par do insert ek
// saath hon tab bhi har ek apne hisse ki id leta hai, kisi aur ka nahi.
let _reservedId = null;            // { table, start } — agla injectAutoId isi se shuru
async function withReservedIds(table, sql, fn) {
  const start = await reserveIds(table, sql);
  _reservedId = start ? { table, start } : null;
  try { return fn(); } finally { _reservedId = null; }
}
async function reserveIds(table, sql) {
  if (!_idsReady || _testMode) return null;
  const n = countAutoIdRows(table, sql);
  if (!n) return null;
  let localMax = 0;
  const rows = alasql.tables[table] && alasql.tables[table].data;
  if (rows) for (const r of rows) { const v = parseInt(r.id, 10); if (v > localMax) localMax = v; }
  const localNext = Math.max(_nextId[table] || 1, localMax + 1);
  const t = qIdent(table), ids = qIdent(IDS_TABLE);
  try {
    const { rows: out } = await getPool().query(
      `INSERT INTO ${ids} (tbl, next) VALUES ($1, GREATEST($2::bigint, (SELECT COALESCE(MAX(id), 0) + 1 FROM ${t})) + $3::bigint)
       ON CONFLICT (tbl) DO UPDATE SET next = GREATEST(${ids}.next, $2::bigint, (SELECT COALESCE(MAX(id), 0) + 1 FROM ${t})) + $3::bigint
       RETURNING next - $3::bigint AS start`, [table, localNext, n]);
    const start = parseInt(out && out[0] && out[0].start, 10);
    return Number.isFinite(start) && start > 0 ? start : null;
  } catch (e) {
    // counter tak na pahunche to pehle jaisa memory wala tareeka (save phir bhi DB me jaata hai)
    console.error(`  ⚠️ ${table} ke liye id counter nahi mila:`, e.message);
    return null;
  }
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
  let startId = Math.max(_nextId[table] || 1, actualMax + 1);
  // Postgres counter se mila hissa — wahi id (sab instance me alag)
  if (_reservedId && _reservedId.table === table) { startId = _reservedId.start; _reservedId = null; }
  const newColsList = ['id', ...colsList];

  let newValues = valuesPart;
  let idAdded = 0;
  newValues = newValues.replace(/\(/g, () => {
    const thisId = startId + idAdded;
    idAdded++;
    return `(${thisId},`;
  });

  _nextId[table] = Math.max(_nextId[table] || 1, startId + tuples);
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
  noteRows(table, [id]);
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
  _writeGen++;
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
      // Kya-kya likhna hai, wo ABHI (bina await ke) tay kar lo — warna IO ke
      // beech aayi nayi writes galti se "likh di gayi" maan li jaatin.
      const plan = snapshot.map(t => ({
        table: t,
        full: _fullRewrite.has(t),
        upsert: Array.from(_dirtyIds.get(t) || []),
        remove: Array.from(_deletedIds.get(t) || [])
      }));
      snapshot.forEach(t => clearRowMarks(t));
      // Write first; only clear dirty on SUCCESS. If a write fails
      // (network/auth) tables stay dirty so the next flush retries and no
      // data is lost.
      try {
        await writeTablesToPg(plan);
      } catch (err) {
        // Naakaam — nishaan wapas lagao taaki agli baar dobara koshish ho
        for (const p of plan) {
          if (p.full) noteFull(p.table);
          noteRows(p.table, p.upsert);
          noteDeleted(p.table, p.remove);
        }
        throw err;
      }
      snapshot.forEach(t => _dirtyTables.delete(t));
    }
  } finally {
    _flushInProgress = false;
    const resolvers = _pendingFlushResolvers.splice(0);
    for (const r of resolvers) r();
  }
}

// Har dirty table ke liye: aam taur par sirf BADLI HUI rows ka upsert +
// hataayi hui rows ka delete. Sirf jab rows ka pata na chale (full=true) tab
// purana tareeka — poori table DELETE + dobara INSERT. Sab ek transaction me,
// taaki beech me kuch toote to table adhoora na rahe.
// ══ TASK DATA KA PAKKA GUARD ══════════════════════════════════════
// Do niyam jo har haal me lagte hain, chahe code kahin se bhi likhe:
//  1. In tables ko kabhi poora mita kar dobara nahi likha jaata. Agar kisi
//     wajah se pata na chale ki kaun si row badli, tab bhi sirf upsert hota
//     hai — delete kabhi nahi. Isse kisi ka task gayab nahi ho sakta.
//  2. Jo row database me 'completed' hai, use koi bhi flush wapas 'pending'
//     nahi bana sakta. Purani memory wale instance ka likha hua bhi nahi.
//     (Revise / Not Applicable pehle jaise chalte hain — sirf pending rokna hai.)
const TASK_TABLES_NEVER_WIPE = new Set(['checklist_tasks', 'delegation_tasks']);
function keepDoneGuard(table) {
  if (!TASK_TABLES_NEVER_WIPE.has(table)) return '';
  return ` WHERE NOT (${qIdent(table)}.status = 'completed' AND EXCLUDED.status = 'pending')`;
}

async function writeTablesToPg(plan) {
  if (!plan.length) return;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let item of plan) {
      const table = item.table;
      const cols = SCHEMA[table].cols;
      const data = alasql.tables[table] ? alasql.tables[table].data : [];
      // Niyam 1 — task tables ka poora rewrite kabhi nahi. Rows ka pata na ho
      // to bhi sirf upsert, delete kuch nahi.
      if (item.full && TASK_TABLES_NEVER_WIPE.has(table)) {
        item = { table, full: false, upsert: data.map(r => String(r.id)), remove: item.remove || [] };
      }
      if (!item.full) {
        // ── sirf badli hui rows ──
        if (item.remove.length) {
          await client.query(`DELETE FROM ${qIdent(table)} WHERE id = ANY($1::int[])`,
            [item.remove.map(x => parseInt(x, 10)).filter(n => Number.isFinite(n))]);
        }
        if (item.upsert.length) {
          const byId = new Map(data.map(r => [String(r.id), r]));
          const rows = item.upsert.map(id => byId.get(String(id))).filter(Boolean);
          const colSql = cols.map(qIdent).join(', ');
          const setSql = cols.filter(c => c !== 'id')
            .map(c => `${qIdent(c)} = EXCLUDED.${qIdent(c)}`).join(', ');
          const maxParams = 60000;
          const rowsPerChunk = Math.max(1, Math.floor(maxParams / cols.length));
          for (let start = 0; start < rows.length; start += rowsPerChunk) {
            const chunk = rows.slice(start, start + rowsPerChunk);
            const valuesSql = []; const flat = []; let p = 1;
            for (const r of chunk) {
              valuesSql.push(`(${cols.map(() => `$${p++}`).join(', ')})`);
              for (const c of cols) flat.push(serializeForDb(r[c]));
            }
            await client.query(
              `INSERT INTO ${qIdent(table)} (${colSql}) VALUES ${valuesSql.join(', ')}` +
              // Niyam 2 — completed row wapas pending nahi ban sakti
              (setSql ? ` ON CONFLICT (id) DO UPDATE SET ${setSql}${keepDoneGuard(table)}` : ''),
              flat
            );
          }
        }
        continue;
      }
      // ── fallback: poora rewrite ──
      const rows = data;
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
    // Data pakka ho gaya — ab in tables ka version +1, taaki doosre instance dobara padhein
    await bumpVersions(client, plan.map(p => p.table));
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
  // Kaunsi rows badli hui hain — jaanchne ke liye
  _marks: () => ({
    tables: [..._dirtyTables],
    full: [..._fullRewrite],
    dirty: Object.fromEntries([..._dirtyIds].map(([k, v]) => [k, [...v]])),
    deleted: Object.fromEntries([..._deletedIds].map(([k, v]) => [k, [...v]]))
  }),
  _getPool: getPool,
  _loadAllTables: loadAllTables
};
