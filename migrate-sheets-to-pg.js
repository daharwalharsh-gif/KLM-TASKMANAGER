// ══════════════════════════════════════════════════════════════════
// migrate-sheets-to-pg.js — ONE-TIME migration for the hybrid split.
// Copies every NON-FMS table from the Google Sheet into PostgreSQL
// (KLM-DB) so existing users, checklist, delegation, approvals, comments,
// transfers, week-plans and leave data survive the switch to hybrid.
// FMS tables are left untouched (they stay on Google Sheets).
//
// Safe to re-run: it does DELETE + re-INSERT of each migrated table.
//
// Run:  node migrate-sheets-to-pg.js
// ══════════════════════════════════════════════════════════════════
require('dotenv').config();
const sheets = require('./sheets-db');
const { Pool } = require('pg');

const SCHEMA = sheets._schema;
// Migrate everything except the FMS tables (those live on Sheets).
const FMS_TABLES = ['fms_sheets', 'fms_steps', 'fms_step_doers', 'fms_extra_rows'];
const TABLES = Object.keys(SCHEMA).filter(t => !FMS_TABLES.includes(t));

function pgPool() {
  return new Pool({
    host: (process.env.PG_HOST || '').trim(),
    port: parseInt(process.env.PG_PORT || '5432', 10),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
    ssl: (process.env.PG_SSL || '').toLowerCase() === 'require' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15000
  });
}
const qIdent = n => '"' + String(n).replace(/"/g, '""') + '"';

(async () => {
  // 1. Load ONLY these two tables from the Google Sheet into alasql.
  sheets.setManagedTables(TABLES);
  await sheets.init();
  const alasql = sheets._alasql;

  // 2. Push them into Postgres inside a single transaction.
  const pool = pgPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of TABLES) {
      const cols = SCHEMA[table].cols;
      const rows = (alasql.tables[table] && alasql.tables[table].data) || [];

      // Ensure table + columns exist (id INTEGER PK, rest TEXT).
      const colDefs = cols.map(c => c === 'id' ? `${qIdent(c)} INTEGER PRIMARY KEY` : `${qIdent(c)} TEXT`).join(', ');
      await client.query(`CREATE TABLE IF NOT EXISTS ${qIdent(table)} (${colDefs})`);
      for (const c of cols) {
        if (c === 'id') continue;
        await client.query(`ALTER TABLE ${qIdent(table)} ADD COLUMN IF NOT EXISTS ${qIdent(c)} TEXT`);
      }

      // SAFETY: agar PG me is table ka data pehle se hai to use OVERWRITE mat
      // karo (warna deployed app se aaya naya data ud sakta hai). Sirf khaali
      // tables migrate hote hain.
      const existing = (await client.query(`SELECT COUNT(*)::int AS c FROM ${qIdent(table)}`)).rows[0].c;
      if (existing > 0) {
        console.log(`  ⏭️  ${table}: PG me pehle se ${existing} rows — skip (safe)`);
        continue;
      }

      // Replace contents.
      await client.query(`DELETE FROM ${qIdent(table)}`);
      const colSql = cols.map(qIdent).join(', ');
      let inserted = 0;
      // Chunked bulk insert (stay under the 65535 bind-param limit).
      const perChunk = Math.max(1, Math.floor(60000 / cols.length));
      for (let start = 0; start < rows.length; start += perChunk) {
        const chunk = rows.slice(start, start + perChunk);
        const valuesSql = [];
        const flat = [];
        let p = 1;
        for (const r of chunk) {
          valuesSql.push('(' + cols.map(() => `$${p++}`).join(', ') + ')');
          for (const c of cols) {
            const v = r[c];
            flat.push(v === null || v === undefined ? null : String(v));
          }
        }
        if (chunk.length) {
          await client.query(`INSERT INTO ${qIdent(table)} (${colSql}) VALUES ${valuesSql.join(', ')}`, flat);
          inserted += chunk.length;
        }
      }
      console.log(`  ✅ ${table}: ${inserted} rows migrated to Postgres`);
    }
    await client.query('COMMIT');
    console.log('\n  🎉 Migration complete. All non-FMS tables are now in KLM-DB.');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('  ❌ Migration failed (rolled back):', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
  process.exit(process.exitCode || 0);
})().catch(err => { console.error('  ❌ Fatal:', err.message); process.exit(1); });
