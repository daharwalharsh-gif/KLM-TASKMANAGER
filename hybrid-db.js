// ══════════════════════════════════════════════════════════════════
// hybrid-db.js — split backend: FMS in Sheets, everything else in Postgres
// ──────────────────────────────────────────────────────────────────
// • FMS tables (fms_sheets/steps/step_doers/extra_rows) → Google Sheets
//   (they mirror external FMS process sheets — kept on Sheets on purpose)
// • EVERYTHING else (users, checklist_tasks, delegation_tasks, approvals,
//   comments, transfers, week_plans, leave_tracker) → PostgreSQL
//
// Both adapters share the SAME alasql in-memory singleton, so a query
// can freely JOIN a Postgres table with a Sheets table — reads just run
// on the shared memory. Only LOAD (on boot) and FLUSH (on write) are
// scoped per-table to the owning backend.
//
// Routing rule (per SQL statement):
//   • INSERT/UPDATE/DELETE → sent to the adapter that OWNS that table,
//     so the write is flushed to the correct place.
//   • SELECT / read-only   → run on the shared alasql (via pg engine).
//
// Same db.query / db.execute / db.getConnection API as the other two
// adapters — server.js needs no changes (just DB_BACKEND=hybrid).
// ══════════════════════════════════════════════════════════════════

const pg = require('./pg-db');
const sheets = require('./sheets-db');

// FMS tables stay on Google Sheets; everything else lives in PostgreSQL.
const SHEET_TABLES = ['fms_sheets', 'fms_steps', 'fms_step_doers', 'fms_extra_rows'];
const ALL_TABLES = Object.keys(pg._schema);
const PG_TABLES = ALL_TABLES.filter(t => !SHEET_TABLES.includes(t));
const _pgSet = new Set(PG_TABLES);

// Reuse the (identical) mutation-table detector + shared engine from pg-db.
const detectMutationTable = pg.detectMutationTable;
const alasql = pg._alasql;
const SCHEMA = pg._schema;

// Create the given tables in alasql (empty) so a query never throws
// "table not found" while a backend is still loading in the background.
function ensureAlasqlTables(tables) {
  for (const t of tables) {
    const cols = SCHEMA[t].cols.map(c => `\`${c}\` ${c === 'id' ? 'INT' : 'STRING'}`).join(', ');
    alasql(`CREATE TABLE IF NOT EXISTS ${t} (${cols})`);
  }
}

let _initPromise = null;
let _sheetsReady = null;
let _sheetsLoadedAt = 0;
// FMS/Sheets memory kitni der "fresh" maani jaye (SIRF reads ke liye).
// Mutations pe hamesha reload hota hai (TTL ignore) — data-loss se bachne ko.
const SHEETS_TTL_MS = parseInt(process.env.SHEETS_RELOAD_TTL_MS || '15000', 10);

function init() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    // Scope each adapter to the tables it owns BEFORE init runs.
    pg.setManagedTables(PG_TABLES);
    sheets.setManagedTables(SHEET_TABLES);

    // Pre-create ALL alasql tables (empty) so FMS queries return empty instead
    // of erroring while the Sheets side is still loading below.
    ensureAlasqlTables(ALL_TABLES);

    // 1) PostgreSQL loads SYNCHRONOUSLY — the dashboard and every task table
    //    live here and it's fast. This is all the first request waits on, so
    //    it stays well under the Vercel serverless function timeout.
    await pg.init();

    // 2) FMS (Google Sheets) is comparatively slow (~seconds) and rarely
    //    changes. Load it in the BACKGROUND so it never blocks a request or
    //    trips the serverless timeout. The FMS section fills in once ready.
    _sheetsReady = sheets.init()
      .then(() => { _sheetsLoadedAt = Date.now(); })
      .catch(e => console.error('  ⚠️ Sheets (FMS) init failed:', e.message));
    console.log(`  🔗 Hybrid DB ready — PG(${PG_TABLES.length} tables) sync, Sheets/FMS(${SHEET_TABLES.length}) loading in background`);
  })();
  return _initPromise;
}

// Per-request refresh (used on Vercel before each /api call). Postgres reload
// fast hai (parallel). FMS (Sheets) pehle SIRF ek baar load hota tha aur uske
// baad us instance pe kabhi refresh nahi hota tha — isse do bug the:
//   1. Warm instance apni PURANI FMS memory serve karta tha → admin ka naya
//      Row-Filter mapping/steps doer ko dikhte hi nahi the (filter lagta hi nahi).
//   2. Flush = full-table rewrite THIS instance ki memory se. Stale memory se
//      flush hone par dusre instance ka abhi-abhi kiya save MIT jaata tha
//      ("save karne pe mapping hat gaya" wala bug).
// Ab (perf-tuned): Sheets/FMS reload READS pe TTL-based hota hai (15s). Pehle har
// mutation (login, task-done, sab) pe bhi force-reload hota tha → har POST/PUT/DELETE
// me ~0.5s extra. Ye zaroorat sirf FMS-TABLE write ke liye hai (stale-wipe se bachne
// ko), jo ab query() me us write se theek pehle hota hai. Isliye yahan `force` par
// Sheets reload NAHI karte — sirf TTL. PG force waisa hi (uska data-loss guard).
async function reload(force) {
  await pg.reload(force); // mutations pe force=true → hamesha fresh (PG data-loss se bacho)
  if (!_sheetsReady) {
    _sheetsReady = sheets.init()
      .then(() => { _sheetsLoadedAt = Date.now(); })
      .catch(e => console.error('  ⚠️ Sheets (FMS) init failed:', e.message));
  }
  await _sheetsReady; // resolved promise = turant; pehli baar hi wait hota hai

  const stale = (Date.now() - _sheetsLoadedAt) > SHEETS_TTL_MS;
  if (stale) {
    try {
      // reload() true tabhi deta hai jab wo sach me fresh load kar paya
      // (pending writes ke waqt skip karta hai — unhe clobber nahi karna).
      if (await sheets.reload()) _sheetsLoadedAt = Date.now();
    } catch (e) {
      console.error('  ⚠️ Sheets (FMS) reload failed:', e.message);
    }
  }
}

async function flushNow() {
  await Promise.all([pg.flushNow(), sheets.flushNow()]);
}

// The core router. A write goes to whichever backend owns the target table;
// a read runs on the shared alasql memory (pg engine — same result either way).
async function query(sql, params = []) {
  if (!_initPromise) await init();
  const table = detectMutationTable(sql);
  if (table) {
    if (_pgSet.has(table)) return pg.query(sql, params);
    // FMS/Sheets-table WRITE: is write se theek pehle fresh reload (stale-wipe se bacho).
    // sheets.reload() dirty-state me skip karta hai — isliye ek multi-statement FMS save
    // ki PEHLI query fresh se shuru hoti hai, baaki mid-transaction skip (correct).
    try { if (await sheets.reload()) _sheetsLoadedAt = Date.now(); } catch (e) { /* reload fail → write phir bhi try */ }
    return sheets.query(sql, params);
  }
  return pg.query(sql, params);
}

function getConnection() {
  return {
    query: (sql, p) => query(sql, p),
    execute: (sql, p) => query(sql, p),
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {}
  };
}

// MIS "export to sheet" — this is FMS/Sheets-side, so write to Google Sheets.
function writeReportTab(title, rows) {
  return sheets.writeReportTab(title, rows);
}

module.exports = {
  init,
  reload,
  query,
  execute: query,
  getConnection,
  flushNow,
  writeReportTab,
  end: () => pg.end(),
  // Debug helpers
  _alasql: pg._alasql,
  _schema: pg._schema,
  _pgTables: PG_TABLES,
  _sheetTables: SHEET_TABLES
};
