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

// Reuse the (identical) mutation-table detector from pg-db.
const detectMutationTable = pg.detectMutationTable;

let _initPromise = null;
function init() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    // Scope each adapter to the tables it owns BEFORE init runs.
    pg.setManagedTables(PG_TABLES);
    sheets.setManagedTables(SHEET_TABLES);
    // Order matters only cosmetically; tables are disjoint. Run pg first so
    // the admin-seed check (users) happens on the Postgres side.
    await pg.init();
    await sheets.init();
    console.log(`  🔗 Hybrid DB ready — PG: [${PG_TABLES.join(', ')}]  Sheets: [${SHEET_TABLES.length} tables]`);
  })();
  return _initPromise;
}

async function reload() {
  await Promise.all([pg.reload(), sheets.reload()]);
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
    return _pgSet.has(table) ? pg.query(sql, params) : sheets.query(sql, params);
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
