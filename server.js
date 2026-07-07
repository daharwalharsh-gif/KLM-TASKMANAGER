// ══════════════════════════════════════════════════════
// 🚀 AUTO-INSTALL BOOTSTRAP
// Agar koi dependency missing hai to automatic npm install chala dega
// (Hostinger pe pehli baar SSH terminal kholne ki zaroorat nahi)
// ══════════════════════════════════════════════════════
(function autoInstallDependencies() {
  // Vercel / serverless: filesystem is read-only at runtime and dependencies
  // are already installed during the build step. Skip entirely.
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) return;

  const fs = require('fs');
  const path = require('path');
  const { execSync } = require('child_process');

  const pkgPath = path.join(__dirname, 'package.json');
  const nodeModulesPath = path.join(__dirname, 'node_modules');

  if (!fs.existsSync(pkgPath)) return; // safety guard

  let needsInstall = false;
  let missingPkg = '';

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = Object.keys(pkg.dependencies || {});

    // Check 1: node_modules folder exists?
    if (!fs.existsSync(nodeModulesPath)) {
      needsInstall = true;
    } else {
      // Check 2: Saari dependencies node_modules me hain?
      for (const dep of deps) {
        if (!fs.existsSync(path.join(nodeModulesPath, dep))) {
          needsInstall = true;
          missingPkg = dep;
          break;
        }
      }
    }
  } catch (err) {
    console.error('  ⚠️  package.json read error:', err.message);
    return;
  }

  if (needsInstall) {
    console.log('  📦 Dependencies missing' + (missingPkg ? ` (${missingPkg})` : '') + ' — installing...');
    console.log('  ⏳ Ye 1-2 minute le sakta hai, please wait...');
    try {
      execSync('npm install --production --no-audit --no-fund', {
        stdio: 'inherit',
        cwd: __dirname
      });
      console.log('  ✅ Dependencies installed successfully!');
    } catch (err) {
      console.error('  ❌ npm install failed:', err.message);
      console.error('  ⚠️  Please run "npm install" manually via SSH/Terminal');
      process.exit(1);
    }
  }
})();

require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs'); // sirf legacy bcrypt hashes ko compare karne ke liye (auto-migrate)
const jwt = require('jsonwebtoken');
const path = require('path');
const nodemailer = require('nodemailer');

// Plain text password storage + legacy bcrypt migration.
// User ne explicitly maanga hai ki sheet me password as-is (plain) dikhe taaki admin
// dekh sake. Trade-off: sheet ko trusted logon ke saath hi share rakhna.
function checkPassword(plain, stored) {
  if (!stored || plain == null) return false;
  if (plain === stored) return { ok: true, legacy: false };
  if (/^\$2[aby]\$/.test(stored)) {
    try {
      if (bcrypt.compareSync(plain, stored)) return { ok: true, legacy: true };
    } catch(_) {}
  }
  return { ok: false };
}

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.SESSION_SECRET || 'taskmanager_secret_2026';

const cookieParser = require('cookie-parser');
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════
// DATABASE — in-memory alasql engine backed by a persistence layer.
// DB_BACKEND options:
//   'hybrid' (default) — users + checklist_tasks in PostgreSQL, everything
//                        else (FMS, delegation, approvals, …) in Google Sheets
//   'pg'               — all tables in PostgreSQL
//   'sheets'           — all tables in Google Sheets (original)
// All three expose the SAME db.query / db.execute / db.getConnection API —
// server code below is identical regardless of backend.
// ══════════════════════════════════════════════════════
const DB_BACKEND = (process.env.DB_BACKEND || 'hybrid').toLowerCase();
const db = DB_BACKEND === 'sheets' ? require('./sheets-db')
         : DB_BACKEND === 'pg'     ? require('./pg-db')
         :                           require('./hybrid-db');
// Schema is defined in the adapter — no runtime migrations needed.
// init() loads all tables into the in-memory store on boot.
const _dbReady = db.init()
  .then(() => console.log(`  ✅ Database ready (backend: ${DB_BACKEND})`))
  .catch(err => {
    console.error(`  ❌ Database init failed (backend: ${DB_BACKEND}):`, err.message);
    if (DB_BACKEND === 'sheets') {
      console.error('  💡 Set GOOGLE_SHEET_ID in .env and share the sheet with the service account.');
    } else {
      console.error('  💡 Set PG_HOST / PG_PORT / PG_USER / PG_PASSWORD / PG_DATABASE in .env.');
    }
  });

// ══════════════════════════════════════════════════════
// SERVERLESS CONSISTENCY (Vercel / Lambda)
// The in-memory alasql store is designed for ONE long-lived process. On
// serverless, many short-lived instances each hold their own frozen
// snapshot: writes from instance A never reach instance B, and the
// debounced 1.5 s flush is killed before it runs. Result: deleted/edited
// data reappears, new rows vanish, "step not found", etc.
// Fix: make every /api request behave statelessly —
//   1. reload fresh data from the sheet BEFORE the handler runs, and
//   2. flush pending writes to the sheet BEFORE the response is sent.
// Costs one extra Sheets round-trip per request; acceptable for an
// internal tool, and the only way in-memory caching can stay correct
// across serverless instances.
// ══════════════════════════════════════════════════════
if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
  // 1. Reload-before — only for data routes (skip static assets).
  //    Mutations (POST/PUT/DELETE/PATCH) pe force=true → TTL ignore, hamesha
  //    fresh PG state se shuru ho (warna stale memory ka full-rewrite flush
  //    dusre instance ka data mita deta — CSV bulk upload adhoora reh jaata tha).
  app.use('/api', async (req, res, next) => {
    const isMutation = req.method !== 'GET' && req.method !== 'HEAD';
    try { await db.reload(isMutation); }
    catch (err) { console.error('  ❌ Pre-request reload failed:', err.message); }
    next();
  });

  // 2. Flush-after — wrap res.json so pending writes hit the sheet
  //    before the response is sent and the instance is reaped.
  app.use((req, res, next) => {
    const origJson = res.json.bind(res);
    res.json = function (body) {
      db.flushNow()
        .catch(err => console.error('  ❌ Pre-response flush failed:', err.message))
        .finally(() => origJson(body));
      return res;
    };
    next();
  });
}

// ══════════════════════════════════════════════════════
// EMAIL CONFIGURATION (Gmail SMTP via Nodemailer)
// ══════════════════════════════════════════════════════
const mailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

(async () => {
  try {
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      await mailTransporter.verify();
      console.log('  ✅ Gmail SMTP Ready');
    } else {
      console.log('  ⚠️  SMTP credentials missing — emails disabled');
    }
  } catch (err) {
    console.error('  ❌ SMTP verification failed:', err.message);
  }
})();

// Reusable email sender — never throws (failures are logged only)
async function sendMail(to, subject, html) {
  if (!to || !process.env.SMTP_USER) return;
  try {
    await mailTransporter.sendMail({
      from: `"${process.env.SMTP_FROM_NAME || 'Task Manager'}" <${process.env.SMTP_USER}>`,
      to, subject, html
    });
    console.log(`  📧 Email sent to ${to} — ${subject}`);
  } catch (err) {
    console.error(`  ❌ Email failed (${to}):`, err.message);
  }
}

// Helper: get user's notification email + name
async function getNotifyTarget(userId) {
  try {
    const [rows] = await db.query(
      'SELECT name, notification_email FROM users WHERE id=? LIMIT 1',
      [userId]
    );
    if (!rows[0] || !rows[0].notification_email) return null;
    return { name: rows[0].name, email: rows[0].notification_email };
  } catch { return null; }
}

// Email template for delegation task
function delegationEmailHtml({ assigneeName, assignerName, desc, dueDate, priority, approval, remarks }) {
  const appUrl = process.env.APP_URL || '#';
  return `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f6f9fc;padding:20px;">
    <div style="background:#fff;border-radius:8px;padding:30px;box-shadow:0 2px 8px rgba(0,0,0,0.05);">
      <h2 style="color:#1976d2;margin-top:0;">📋 New Task Assigned to You</h2>
      <p>Hi <b>${assigneeName || 'there'}</b>,</p>
      <p><b>${assignerName || 'Someone'}</b> ne aapko ek naya delegation task assign kiya hai:</p>
      <table style="width:100%;border-collapse:collapse;margin:20px 0;">
        <tr><td style="padding:8px;background:#f0f4f8;width:140px;"><b>Task</b></td><td style="padding:8px;">${desc}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;"><b>Due Date</b></td><td style="padding:8px;">${dueDate}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;"><b>Priority</b></td><td style="padding:8px;text-transform:capitalize;">${priority}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;"><b>Approval Required</b></td><td style="padding:8px;text-transform:capitalize;">${approval}</td></tr>
        ${remarks ? `<tr><td style="padding:8px;background:#f0f4f8;"><b>Remarks</b></td><td style="padding:8px;">${remarks}</td></tr>` : ''}
      </table>
      <a href="${appUrl}" style="display:inline-block;background:#1976d2;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;">Open Task Manager</a>
      <p style="color:#777;font-size:12px;margin-top:30px;">Ye automated email hai — Sohan Healthcare Task Manager se.</p>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════
// v16: DELEGATION REMINDER EMAILS (daily at 12:00 PM)
// Ek hi mail address ko 3-4 employees use karte hain — isliye user-wise
// section banakar ek hi mail me sab tasks bhejte hain. Reminder window:
// due_date <= today+2 AND status='pending'. Task complete ya delete hone
// par reminders bandh ho jaate hain. Same task ek din me 2 baar reminder
// nahi bhejti (last_reminder_date column tracking).
// ══════════════════════════════════════════════════════

// Build the combined reminder email HTML for a single notification_email
// `byUser` = { "User Name": [task, task, ...], ... }
function reminderEmailHtml(byUser, todayStr) {
  const appUrl = process.env.APP_URL || '#';
  const userNames = Object.keys(byUser);
  const totalTasks = userNames.reduce((s, n) => s + byUser[n].length, 0);

  // Per-user blocks — user ka naam clearly upar, neeche uski tasks ki table
  const sections = userNames.map(name => {
    const tasks = byUser[name];
    const rows = tasks.map(t => {
      const isOverdue = t.due_date < todayStr;
      const dueLabel = isOverdue
        ? `<span style="color:#dc2626;font-weight:700">${t.due_date} ⏰ Overdue</span>`
        : (t.due_date === todayStr
            ? `<span style="color:#d97706;font-weight:700">${t.due_date} (Today)</span>`
            : `<b>${t.due_date}</b>`);
      return `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid #eef2f7;font-size:13px">${t.description||'—'}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eef2f7;font-size:13px;white-space:nowrap">${dueLabel}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eef2f7;font-size:12px;text-transform:capitalize;color:#64748b">${t.priority||'low'}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eef2f7;font-size:12px;color:#64748b">${t.assignerName||'—'}</td>
      </tr>`;
    }).join('');
    return `
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
        <span style="background:#1976d2;color:#fff;width:34px;height:34px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:14px">${(name||'?').charAt(0).toUpperCase()}</span>
        <div>
          <div style="font-weight:700;font-size:15px;color:#1e293b">${name||'Unknown'}</div>
          <div style="font-size:12px;color:#64748b">${tasks.length} pending task${tasks.length>1?'s':''}</div>
        </div>
      </div>
      <table style="width:100%;border-collapse:collapse;background:#fafbfc;border-radius:8px;overflow:hidden">
        <thead>
          <tr style="background:#f1f5f9">
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.4px">Task</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.4px">Due Date</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.4px">Priority</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.4px">Assigned By</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  return `
  <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;background:#f6f9fc;padding:20px;">
    <div style="background:#fff;border-radius:10px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,0.05)">
      <h2 style="color:#dc2626;margin:0 0 4px 0">⏰ Pending Task Reminder</h2>
      <p style="margin:0 0 18px 0;color:#475569;font-size:14px">
        Aaj <b>${todayStr}</b> — neeche di gayi tasks 2 din ya usse kam me due hain. Please complete on time.
        ${userNames.length > 1 ? `<br><span style="font-size:12px;color:#64748b">Ye mail <b>${userNames.length} user${userNames.length>1?'s':''}</b> ke liye hai (same email account): ${userNames.join(', ')}</span>` : ''}
      </p>
      ${sections}
      <a href="${appUrl}" style="display:inline-block;background:#1976d2;color:#fff;text-decoration:none;padding:11px 22px;border-radius:6px;font-weight:600;margin-top:6px">Open Task Manager</a>
      <p style="color:#94a3b8;font-size:11px;margin-top:18px;border-top:1px solid #eef2f7;padding-top:12px">
        Total <b>${totalTasks}</b> pending task${totalTasks>1?'s':''}. Reminders task complete hone tak roz 12:00 PM par jaayengi.
        Stop karne ke liye task ko complete/delete kar do.
      </p>
    </div>
  </div>`;
}

// Run the daily delegation reminder pass.
// Filter: status='pending' AND due_date <= (today + 2 days) AND last_reminder_date != today
async function runDelegationReminders() {
  try {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const cutoff = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0];

    const [tasks] = await db.query(`
      SELECT t.id, t.description, t.assigned_to, t.assigned_by, t.priority,
             COALESCE(t.approval,'no') AS approval, t.remarks,
             DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,
             u1.name AS assigneeName, u1.notification_email AS assigneeEmail,
             u2.name AS assignerName
      FROM delegation_tasks t
      JOIN users u1 ON t.assigned_to = u1.id
      JOIN users u2 ON t.assigned_by = u2.id
      WHERE t.status = 'pending'
        AND t.due_date <= ?
        AND (t.last_reminder_date IS NULL OR t.last_reminder_date < ?)
      ORDER BY u1.notification_email, t.due_date ASC
    `, [cutoff, todayStr]);

    if (!tasks.length) {
      console.log(`  🔔 Reminder pass @ ${todayStr}: 0 pending tasks in window`);
      return { sent: 0, skipped: 0 };
    }

    // Group by notification_email — ek email pe ek hi mail jaayegi
    const groups = {};
    for (const t of tasks) {
      const email = (t.assigneeEmail || '').trim().toLowerCase();
      if (!email) continue; // skip users without notification_email
      if (!groups[email]) groups[email] = { byUser: {}, taskIds: [] };
      if (!groups[email].byUser[t.assigneeName]) groups[email].byUser[t.assigneeName] = [];
      groups[email].byUser[t.assigneeName].push(t);
      groups[email].taskIds.push(t.id);
    }

    let sent = 0, failed = 0;
    for (const email of Object.keys(groups)) {
      const { byUser, taskIds } = groups[email];
      const totalForEmail = taskIds.length;
      const userNames = Object.keys(byUser);
      const subject = userNames.length === 1
        ? `⏰ ${totalForEmail} pending task${totalForEmail>1?'s':''} for ${userNames[0]}`
        : `⏰ ${totalForEmail} pending task${totalForEmail>1?'s':''} (${userNames.length} users)`;
      try {
        await sendMail(email, subject, reminderEmailHtml(byUser, todayStr));
        // Mark all included tasks as reminded today (prevents same-day duplicates if pass re-runs)
        if (taskIds.length) {
          await db.query(
            `UPDATE delegation_tasks SET last_reminder_date=? WHERE id IN (${taskIds.map(()=>'?').join(',')})`,
            [todayStr, ...taskIds]
          );
        }
        sent++;
      } catch (e) {
        console.error('  ❌ Reminder failed for', email, e.message);
        failed++;
      }
    }
    console.log(`  🔔 Reminder pass @ ${todayStr}: ${sent} email(s) sent, ${failed} failed, ${tasks.length} tasks covered, ${Object.keys(groups).length} unique inbox(es)`);
    return { sent, failed };
  } catch (err) {
    console.error('  ❌ runDelegationReminders error:', err.message);
    return { error: err.message };
  }
}

// Scheduler — checks every minute, fires once at the first 12:00 onwards each day.
// Server restart-safe: agar 12 PM ke baad start hua aur aaj abhi tak run nahi hua,
// to seedha fire ho jaata hai (taaki Hostinger restart pe miss na ho).
let _lastReminderRunDate = ''; // YYYY-MM-DD of last successful run
function reminderScheduler() {
  setInterval(async () => {
    try {
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];
      const hour = now.getHours();
      // Fire any time at/after 12:00 PM — ek din me ek hi baar
      if (hour >= 12 && _lastReminderRunDate !== todayStr) {
        _lastReminderRunDate = todayStr;
        console.log(`  🔔 Triggering daily delegation reminders (${now.toLocaleString()})`);
        await runDelegationReminders();
      }
    } catch(e) { console.error('  ❌ Scheduler tick error:', e.message); }
  }, 60 * 1000); // tick every 60 seconds
  console.log('  ✅ Delegation reminder scheduler started (fires daily at 12:00 PM)');
}

// Manual trigger endpoint for testing / catch-up (admin only)
app.post('/api/admin/run-reminders', requireAuth, requireAdmin, async (req, res) => {
  const r = await runDelegationReminders();
  res.json(r);
});

// Kick off scheduler after SMTP verify (deferred 5s so verify can finish first)
setTimeout(() => {
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    reminderScheduler();
  } else {
    console.log('  ⚠️  Reminder scheduler skipped — SMTP credentials missing');
  }
}, 5000);

// ══════════════════════════════════════════════════════
// MIDDLEWARE
// ══════════════════════════════════════════════════════
// Sirf YYYY-MM-DD format ki valid date return karta hai, warna null.
// Iska use SQL me date interpolate karne se pehle hota hai taaki SQL
// injection na ho (alasql ko raw string milti hai).
function safeDate(v) {
  if (typeof v !== 'string') return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers['authorization']?.replace('Bearer ','');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.session = { userId: decoded.userId, role: decoded.role, name: decoded.name };
    next();
  } catch(e) { res.status(401).json({ error: 'Invalid token' }); }
}
function requireAdmin(req, res, next) {
  if (req.session.role === 'admin') return next();
  res.status(403).json({ error: 'Admin only' });
}
function requireAdminOrHod(req, res, next) {
  if (req.session.role === 'admin' || req.session.role === 'hod' || req.session.role === 'pc') return next();
  res.status(403).json({ error: 'Admin or HOD only' });
}
function requireAdminOrPC(req, res, next) {
  if (req.session.role === 'admin' || req.session.role === 'pc') return next();
  res.status(403).json({ error: 'Admin or PC only' });
}
function getTable(type) {
  return type === 'delegation' ? 'delegation_tasks' : 'checklist_tasks';
}

// ══════════════════════════════════════════════════════
// GOOGLE SHEETS HELPERS
// ══════════════════════════════════════════════════════
let _sheetsReadClient = null;
let _sheetsWriteClient = null;

async function getSheetsClient(scopes) {
  const { google } = require('googleapis');
  const creds = process.env.GOOGLE_CREDENTIALS
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS)
    : require('./credentials.json');
  const isWrite = scopes.some(s => !s.includes('readonly'));
  if (isWrite) {
    if (_sheetsWriteClient) return _sheetsWriteClient;
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    _sheetsWriteClient = google.sheets({ version: 'v4', auth: await auth.getClient() });
    return _sheetsWriteClient;
  } else {
    if (_sheetsReadClient) return _sheetsReadClient;
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    _sheetsReadClient = google.sheets({ version: 'v4', auth: await auth.getClient() });
    return _sheetsReadClient;
  }
}

// Pre-warm Google auth on startup (reduces cold start time)
(async () => {
  try {
    await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
    console.log('  ✅ Google Auth pre-warmed');
  } catch(e) { console.log('  ⚠️ Google Auth pre-warm failed:', e.message); }
})();

function extractSpreadsheetId(raw) {
  const s = (raw || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : s;
}

function colToIdx(col) {
  if (!col) return -1;
  col = col.toUpperCase().trim();
  let idx = 0;
  for (let i = 0; i < col.length; i++) idx = idx * 26 + (col.charCodeAt(i) - 64);
  return idx - 1;
}

function idxToCol(idx) {
  let s = '', n = idx + 1;
  while (n > 0) { const r = (n-1) % 26; s = String.fromCharCode(65+r) + s; n = Math.floor((n-1)/26); }
  return s;
}

// ══════════════════════════════════════════════════════
// SHARED FMS STATS ENGINE  (single source of truth)
// ══════════════════════════════════════════════════════
// Pehle /api/mis/all aur /api/mis/fms dono apne-apne tareeke se Google Sheets
// padhte the — alag filtering, alag aggregation, silent error swallow. Isi se
// "kabhi kya dikhata hai" aur "HOD ko alag total" wale bugs aate the.
//
// Ab dono ek hi function se data lete hain:
//   • Har sheet ek hi baar padhi jaati hai (request ke andar) + 60s ka cache
//     => refresh karne par numbers STABLE rehte hain (deterministic).
//   • Step-level pending/done ek hi jagah count hota hai => per-FMS overview aur
//     per-user attribution kabhi disagree nahi karte.
//   • Read fail ho to sheet ka naam `errors[]` me aata hai (silently 0 nahi hota)
//     => total achanak change nahi hota; UI warning dikha sakta hai.
//   • HOD ke liye department filter dono jagah EK jaisa lagta hai.

const _fmsSheetCache = new Map(); // key: spreadsheetId|range  -> { rows, ts }
const FMS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — FMS sheets slowly change; kam baar heavy read

async function fetchSheetRows(sheet) {
  const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
  const tabName = sheet.sheet_name || 'Sheet1';
  const headerRowIdx = (sheet.header_row || 1) - 1;

  // Range plan/actual columns ke hisaab se
  const [steps] = await db.query('SELECT plan_col, actual_col FROM fms_steps WHERE fms_id=?', [sheet.id]);
  const allCols = steps.flatMap(s => [colToIdx(s.plan_col), colToIdx(s.actual_col)]).filter(x => x >= 0);
  if (!allCols.length) return [];
  const lastCol = idxToCol(Math.max(...allCols));
  const range = `${tabName}!A:${lastCol}`;

  const cacheKey = `${spreadsheetId}|${range}`;
  const hit = _fmsSheetCache.get(cacheKey);
  if (hit && (Date.now() - hit.ts) < FMS_CACHE_TTL_MS) return hit.rows;

  const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const response = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range });
  const allRowsData = response.data.values || [];
  const rows = allRowsData.slice(headerRowIdx + 1);
  _fmsSheetCache.set(cacheKey, { rows, ts: Date.now() });
  return rows;
}

// Returns { perFms: [...], perUser: { uid: {pending,done,total} }, errors: [name] }
// hodDept '' => admin/pc (sab kuch). hodDept set => sirf un steps jinme us dept ka doer hai.
async function computeFmsStats(hodDept = '', collectPending = false) {
  const result = { perFms: [], perUser: {}, errors: [] };
  if (collectPending) result.perUserPending = {}; // uid -> [ {fmsName, stepName, planValue, planDate, isLate} ]
  const _today = new Date().toISOString().split('T')[0];
  const [sheets] = await db.query('SELECT * FROM fms_sheets ORDER BY fms_name ASC');
  if (!sheets.length) return result;

  // ── Har FMS sheet ke rows ko PARALLEL me pre-fetch karo ──
  // Pehle ye loop ke andar ek-ek karke (sequentially) hota tha => 10-15
  // sheets par 30+ sec lagta tha aur UI "Loading..." par atak jaati thi.
  // Ab saari reads ek saath chalti hain (har read 60s cache me rehti hai).
  // Calculation logic NEECHE bilkul same hai — sirf fetch parallel hua.
  const rowsBySheet = new Map(); // sheet.id -> { rows } | { error: true }
  await Promise.all(sheets.map(async sheet => {
    try {
      rowsBySheet.set(sheet.id, { rows: await fetchSheetRows(sheet) });
    } catch (e) {
      rowsBySheet.set(sheet.id, { error: true });
    }
  }));

  for (const sheet of sheets) {
    const fmsName = sheet.fms_name || sheet.sheet_name;
    const [steps] = await db.query('SELECT * FROM fms_steps WHERE fms_id=? ORDER BY step_order ASC', [sheet.id]);

    // Doers per step (id + dept)
    for (const step of steps) {
      const [doers] = await db.query(
        `SELECT u.id, u.name, u.department FROM fms_step_doers fsd
         JOIN users u ON fsd.user_id=u.id WHERE fsd.step_id=?`, [step.id]);
      step.doers = doers;
    }

    // HOD filter: sirf woh steps jahan us dept ka koi doer hai
    const activeSteps = hodDept
      ? steps.filter(s => s.doers.some(d => (d.department || '') === hodDept))
      : steps;
    if (!activeSteps.length) continue;

    // Pre-fetched rows uthao (upar parallel me fetch ho chuke).
    const fetched = rowsBySheet.get(sheet.id);
    if (!fetched || fetched.error) {
      // Silent 0 NAHI — error report karo taaki total achanak na badle
      result.errors.push(fmsName);
      result.perFms.push({ fmsId: sheet.id, fmsName, pending: 0, done: 0, total: 0, steps: [], error: 'Sheet read failed (try again)' });
      continue;
    }
    const rows = fetched.rows;

    let fmsPending = 0, fmsDone = 0;
    const perStep = [];

    for (const step of activeSteps) {
      const planIdx = colToIdx(step.plan_col);
      const actualIdx = colToIdx(step.actual_col);
      if (planIdx < 0 || actualIdx < 0) continue;

      let stepPending = 0, stepDone = 0;
      const stepPendingRows = []; // collectPending ke liye — pending row ka detail
      for (const row of rows) {
        const planVal = (row[planIdx] || '').trim();
        const actualVal = (row[actualIdx] || '').trim();
        if (planVal && !actualVal) {
          stepPending++;
          if (collectPending) {
            // plan date parse (same logic as /api/fms-dashboard)
            let planDate = '';
            const dateMatch = planVal.match(/(\d{4}-\d{2}-\d{2})|(\d{2}[\/\-]\d{2}[\/\-]\d{4})/);
            if (dateMatch) {
              const raw = dateMatch[0];
              if (raw.includes('-') && raw.length === 10 && raw[4] === '-') planDate = raw;
              else { const parts = raw.split(/[\/\-]/); if (parts.length === 3) planDate = `${parts[2]}-${parts[1]}-${parts[0]}`; }
            }
            stepPendingRows.push({
              fmsName, stepName: step.step_name, planValue: planVal,
              planDate, isLate: !!(planDate && planDate < _today)
            });
          }
        }
        else if (planVal && actualVal) stepDone++;
      }

      fmsPending += stepPending;
      fmsDone += stepDone;

      // Per-user attribution: HOD view me sirf dept-doers ko credit (consistency)
      const creditDoers = hodDept ? step.doers.filter(d => (d.department || '') === hodDept) : step.doers;
      for (const d of creditDoers) {
        if (!result.perUser[d.id]) result.perUser[d.id] = { pending: 0, done: 0, total: 0 };
        result.perUser[d.id].pending += stepPending;
        result.perUser[d.id].done    += stepDone;
        result.perUser[d.id].total   += stepPending + stepDone;
        if (collectPending && stepPendingRows.length) {
          if (!result.perUserPending[d.id]) result.perUserPending[d.id] = [];
          for (const pr of stepPendingRows) result.perUserPending[d.id].push(pr);
        }
      }

      perStep.push({
        stepName: step.step_name,
        stepOrder: step.step_order,
        doers: step.doers.map(d => d.name).join(', ') || '—',
        pending: stepPending,
        done: stepDone,
        total: stepPending + stepDone
      });
    }

    result.perFms.push({
      fmsId: sheet.id,
      fmsName,
      pending: fmsPending,
      done: fmsDone,
      total: fmsPending + fmsDone,
      steps: perStep
    });
  }

  return result;
}

// ══════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    const user = rows[0];
    const check = user ? checkPassword(password, user.password) : { ok: false };
    if (!check.ok) return res.status(401).json({ error: 'Invalid email or password' });
    // Legacy bcrypt hash → migrate to plain text (admin can now see in sheet)
    if (check.legacy) {
      try { await db.query('UPDATE users SET password=? WHERE id=?', [password, user.id]); } catch(_) {}
    }

    // Issue JWT token
    const token = jwt.sign(
      { userId: user.id, role: user.role, name: user.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie('token', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id,name,email,notification_email,role,phone,profile_image,department,week_off FROM users WHERE id=?', [req.session.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    // extra_off fetch separately — safe if column not yet added
    try {
      const [ex] = await db.query('SELECT extra_off FROM users WHERE id=?', [req.session.userId]);
      rows[0].extra_off = ex[0]?.extra_off || '';
    } catch(e) { rows[0].extra_off = ''; }
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.role;
    const isAdmin = role === 'admin' || role === 'pc';
    const isHod = role === 'hod';
    const isPC = role === 'pc';
    const filterEmployee = req.query.employee;
    const hodDept = req.query.hodDept || '';
    // PC date range filter — default to today if not provided
    const dateFrom = req.query.dateFrom || '';
    const dateTo   = req.query.dateTo   || '';

    let userFilter, params;

    if (isAdmin && filterEmployee && filterEmployee !== 'all') {
      userFilter = 'AND t.assigned_to = ?'; params = [filterEmployee];
    } else if (isAdmin) {
      userFilter = ''; params = [];
    } else if (isHod) {
      if (filterEmployee && filterEmployee !== 'all') {
        userFilter = 'AND t.assigned_to = ?'; params = [filterEmployee];
      } else {
        // HOD ka department DB se fetch karo — query param pe depend mat karo
        let resolvedDept = hodDept;
        if (!resolvedDept) {
          const [meRow] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
          resolvedDept = meRow[0]?.department || '';
        }
        if (!resolvedDept) {
          // Department set nahi hai — sirf apni tasks dikhao
          userFilter = 'AND t.assigned_to = ?'; params = [uid];
        } else {
          const [deptUsers] = await db.query('SELECT id FROM users WHERE department=? AND role NOT IN (?,?)', [resolvedDept, 'admin','hod']);
          if (!deptUsers.length) {
            // Dept mein koi user nahi — apni tasks dikhao
            userFilter = 'AND t.assigned_to = ?'; params = [uid];
          } else {
            const ids = deptUsers.map(u=>u.id);
            // HOD khud bhi include karo
            if (!ids.includes(uid)) ids.push(uid);
            userFilter = `AND t.assigned_to IN (${ids.map(()=>'?').join(',')})`;
            params = ids;
          }
        }
      }
    } else {
      userFilter = 'AND t.assigned_to = ?'; params = [uid];
    }

    // Stats + Table: aaj aur usse pehle ki pending tasks (due_date <= CURDATE())
    // PC: agar date range diya hai toh woh use karo
    const df = safeDate(dateFrom), dt = safeDate(dateTo);
    const dateClause = isPC && df && dt
      ? `AND t.due_date BETWEEN '${df}' AND '${dt}'`
      : `AND t.due_date <= CURDATE()`;

    const taskType = req.query.taskType || 'both';
    let pending = 0, revised = 0, completed = 0;

    if (taskType === 'delegation' || taskType === 'both') {
      const [d] = await db.query(`SELECT SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN status='revised' THEN 1 ELSE 0 END) AS revised,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed FROM delegation_tasks t WHERE 1=1 ${userFilter} ${dateClause}`, params);
      pending += parseInt(d[0].pending)||0; revised += parseInt(d[0].revised)||0; completed += parseInt(d[0].completed)||0;
    }
    if (taskType === 'checklist' || taskType === 'both') {
      const [d] = await db.query(`SELECT SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN status='revised' THEN 1 ELSE 0 END) AS revised,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed FROM checklist_tasks t WHERE 1=1 ${userFilter} ${dateClause}`, params);
      pending += parseInt(d[0].pending)||0; revised += parseInt(d[0].revised)||0; completed += parseInt(d[0].completed)||0;
    }

    let delegationPending = [], checklistPending = [];
    if (taskType === 'delegation' || taskType === 'both') {
      const [rows] = await db.query(`SELECT t.id,'delegation' AS type,t.description,t.status,t.assigned_to,COALESCE(t.priority,'low') AS priority,COALESCE(t.approval,'no') AS approval,COALESCE(t.waiting_approval,0) AS waiting_approval,t.remarks,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,u1.name AS assignedToName,u2.name AS assignedByName FROM delegation_tasks t JOIN users u1 ON t.assigned_to=u1.id JOIN users u2 ON t.assigned_by=u2.id WHERE t.status='pending' ${dateClause} ${userFilter} ORDER BY t.due_date ASC LIMIT 500`, params);
      delegationPending = rows;
    }
    if (taskType === 'checklist' || taskType === 'both') {
      const [rows] = await db.query(`SELECT t.id,'checklist' AS type,t.description,t.status,t.assigned_to,COALESCE(t.priority,'low') AS priority,'no' AS approval,0 AS waiting_approval,t.remarks,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,u1.name AS assignedToName,u2.name AS assignedByName FROM checklist_tasks t JOIN users u1 ON t.assigned_to=u1.id JOIN users u2 ON t.assigned_by=u2.id WHERE t.status='pending' ${dateClause} ${userFilter} ORDER BY t.due_date ASC LIMIT 500`, params);
      checklistPending = rows;
    }
    res.json({ pending, revised, completed, todayPending: [...delegationPending, ...checklistPending] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// TASKS
// ══════════════════════════════════════════════════════
app.get('/api/tasks', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.role;
    const isAdmin = role === 'admin';
    const isHod = role === 'hod';
    const { type, mine } = req.query;
    const isMine = (mine === '1' || mine === 'true');
    const table = getTable(type || 'delegation');
    const isDeleg = (type || 'delegation') === 'delegation';
    let where = 'WHERE 1=1';
    const params = [];

    if (isMine) {
      // "Delegate by Me" mode — sirf woh tasks jinhe MAINE assign kiya hai.
      // Role-based scoping skip — koi bhi role apne assign kiye tasks dekh sakta hai.
      where += ' AND t.assigned_by = ?';
      params.push(uid);
    } else if (isAdmin || role === 'pc') {
      // Admin/PC — sab dikhta hai
    } else if (isHod) {
      // HOD — apne department ke users ki tasks
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      const dept = me[0]?.department || '';
      const [deptUsers] = await db.query('SELECT id FROM users WHERE department=?', [dept]);
      if (!deptUsers.length) {
        return res.json({ grouped: [] });
      }
      const ids = deptUsers.map(u=>u.id);
      where += ` AND t.assigned_to IN (${ids.map(()=>'?').join(',')})`;
      params.push(...ids);
    } else {
      // Regular user — sirf apni tasks
      where += ' AND t.assigned_to = ?';
      params.push(uid);
    }

    // All Tasks — Delegation me upcoming/future tasks bhi dikhao (taaki kal/parso ke task pehle se visible ho aur transfer ho sakein).
    // Checklist: by default future wale chhupao, BUT if includeFuture=1 query param diya hai (Transfer modal use karta hai)
    // to upcoming bhi dikhao taaki future checklist tasks bhi transfer ho sake.
    const includeFuture = req.query.includeFuture === '1' || req.query.includeFuture === 'true';
    if (!isDeleg && !includeFuture) {
      where += ' AND t.due_date <= CURDATE()';
    }

    const [tasks] = await db.query(`SELECT t.id,'${type||'delegation'}' AS type,t.description,t.status,t.assigned_to,t.assigned_by,COALESCE(t.priority,'low') AS priority,${isDeleg?"COALESCE(t.approval,'no') AS approval,COALESCE(t.waiting_approval,0) AS waiting_approval,t.remarks,":"'no' AS approval,0 AS waiting_approval,t.remarks,"}DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,DATE_FORMAT(t.created_at,'%Y-%m-%d') AS assigned_on,u1.name AS assignedToName,u2.name AS assignedByName FROM ${table} t JOIN users u1 ON t.assigned_to=u1.id JOIN users u2 ON t.assigned_by=u2.id ${where} ORDER BY t.due_date ASC`, params);

    // mine=1 mode me hamesha flat tasks return karte hain (grouped nahi)
    if (isMine) {
      return res.json({ tasks });
    }
    if (isAdmin || isHod || role === 'pc') {
      const grouped = {};
      tasks.forEach(t => {
        if (!grouped[t.assigned_to]) grouped[t.assigned_to] = { userId: t.assigned_to, name: t.assignedToName, tasks: [] };
        grouped[t.assigned_to].tasks.push(t);
      });
      return res.json({ grouped: Object.values(grouped) });
    }
    res.json({ tasks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks', requireAuth, async (req, res) => {
  try {
    const { type, desc, assignedTo, approverEmail, date, priority, approval, remarks } = req.body;
    const isAdmin = req.session.role === 'admin';
    const isHod   = req.session.role === 'hod';
    const isUser  = req.session.role === 'user';
    // Admin, HOD and regular users can all assign to others; fallback to self if not specified
    const targetUser = (isAdmin || isHod || isUser) && assignedTo ? parseInt(assignedTo) : req.session.userId;
    if (!desc || !date) return res.status(400).json({ error: 'Description and date required' });
    // Delegation tasks SIRF admin create kar sakta hai (checklist sab ke liye open).
    if ((type||'checklist') === 'delegation' && !isAdmin) {
      return res.status(403).json({ error: 'Only admin can delegate tasks' });
    }
    if ((type||'checklist') === 'delegation') {
      // Approver: agar approverEmail diya hai to usse dhundo, warna logged-in user
      let assignedBy = req.session.userId;
      if (approverEmail) {
        const [aprRows] = await db.query('SELECT id FROM users WHERE email=? LIMIT 1', [approverEmail]);
        if (aprRows.length) assignedBy = aprRows[0].id;
      }
      // created_at = user ka chuna hua assigned DATE (timestamp nahi).
      // Modal ke date-picker se aata hai; valid na ho to aaj ki date.
      const assignedDate = safeDate(req.body.assignedDate) || new Date().toISOString().slice(0,10);
      await db.query(`INSERT INTO delegation_tasks (description,assigned_to,assigned_by,due_date,status,priority,approval,remarks,created_at) VALUES (?,?,?,?,?,?,?,?,?)`, [desc, targetUser, assignedBy, date, 'pending', priority||'low', approval||'no', remarks||'', assignedDate]);
      // 📧 Send delegation email (non-blocking — fire and forget)
      (async () => {
        const target = await getNotifyTarget(targetUser);
        if (!target) return;
        const [aprRows] = await db.query('SELECT name FROM users WHERE id=? LIMIT 1', [assignedBy]);
        const assignerName = aprRows[0]?.name || 'Admin';
        await sendMail(
          target.email,
          `📋 New Task Assigned: ${(desc||'').slice(0,60)}`,
          delegationEmailHtml({
            assigneeName: target.name,
            assignerName,
            desc, dueDate: date,
            priority: priority||'low',
            approval: approval||'no',
            remarks: remarks||''
          })
        );
      })();
    } else {
      await db.query(`INSERT INTO checklist_tasks (description,assigned_to,assigned_by,due_date,status,priority,remarks) VALUES (?,?,?,?,?,?,?)`, [desc, targetUser, req.session.userId, date, 'pending', priority||'low', remarks||'']);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks/bulk-checklist', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { desc, assignedTo, priority, remarks, dates, frequency } = req.body;
    if (!desc || !assignedTo || !dates || !dates.length) return res.status(400).json({ error: 'Missing fields' });
    const freq = (frequency || '').toLowerCase().trim();
    const values = dates.map(date => [desc, parseInt(assignedTo), req.session.userId, date, 'pending', priority||'low', remarks||'', freq]);
    await db.query(`INSERT INTO checklist_tasks (description,assigned_to,assigned_by,due_date,status,priority,remarks,frequency) VALUES ?`, [values]);
    res.json({ success: true, count: dates.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tasks/:id/status', requireAuth, async (req, res) => {
  try {
    const { status, type, newDate, reason } = req.body;
    const table = getTable(type||'delegation');
    const isAdmin = req.session.role === 'admin';
    const isPC = req.session.role === 'pc';
    const uid = req.session.userId;
    // Delegation task ko Done/Revise (koi bhi status change) SIRF admin kar sakta hai.
    if ((type||'delegation') === 'delegation' && !isAdmin) {
      return res.status(403).json({ error: 'Only admin can manage delegation tasks' });
    }
    const [rows] = await db.query(`SELECT * FROM ${table} WHERE id=?`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Task not found' });
    const task = rows[0];
    if (!isAdmin && !isPC && task.assigned_to !== uid) return res.status(403).json({ error: 'Not allowed' });
    // Timestamp: status='completed' pe NOW(); warna NULL (un-complete pe clear).
    const nowTs = new Date().toISOString().slice(0,19).replace('T',' ');
    const completedAt = status === 'completed' ? nowTs : null;
    if (status === 'completed' && task.waiting_approval) {
      await db.query(`DELETE FROM task_approvals WHERE task_id=? AND task_type=? AND status='pending'`, [req.params.id, type]);
      if (type === 'checklist') await db.query(`UPDATE ${table} SET status='completed',completed_at=? WHERE id=?`, [nowTs, req.params.id]);
      else await db.query(`UPDATE ${table} SET status='completed',waiting_approval=0,completed_at=? WHERE id=?`, [nowTs, req.params.id]);
      return res.json({ success: true, needsApproval: false });
    }
    const needsApproval = type === 'delegation' && task.approval === 'yes';
    if (needsApproval && !isAdmin && !isPC) {
      const [existing] = await db.query(`SELECT id FROM task_approvals WHERE task_id=? AND task_type=? AND status='pending'`, [req.params.id, type]);
      if (existing[0]) return res.status(400).json({ error: 'Approval already pending' });
      await db.query(`INSERT INTO task_approvals (task_id,task_type,requested_by,requested_to,action_type,status,note) VALUES (?,?,?,?,?,'pending',?)`, [req.params.id, type, uid, task.assigned_by, status, reason||'']);
      if (newDate && status === 'revised') await db.query(`UPDATE ${table} SET waiting_approval=1,due_date=? WHERE id=?`, [newDate, req.params.id]);
      else await db.query(`UPDATE ${table} SET waiting_approval=1 WHERE id=?`, [req.params.id]);
      return res.json({ success: true, needsApproval: true });
    }
    if (newDate && status === 'revised') await db.query(`UPDATE ${table} SET status=?,waiting_approval=0,due_date=?,completed_at=? WHERE id=?`, [status, newDate, completedAt, req.params.id]);
    else {
      // checklist_tasks mein waiting_approval column nahi hota
      if (type === 'checklist') await db.query(`UPDATE ${table} SET status=?,completed_at=? WHERE id=?`, [status, completedAt, req.params.id]);
      else await db.query(`UPDATE ${table} SET status=?,waiting_approval=0,completed_at=? WHERE id=?`, [status, completedAt, req.params.id]);
    }
    res.json({ success: true, needsApproval: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tasks/:id/detail', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type } = req.query;
    const table = getTable(type||'delegation');
    const [rows] = await db.query(`SELECT t.*,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date FROM ${table} t WHERE t.id=?`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Task not found' });
    res.json({ task: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tasks/:id/edit', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type, desc, date, priority, approval, remarks } = req.body;
    const table = getTable(type||'delegation');
    if (type === 'delegation') await db.query(`UPDATE ${table} SET description=?,due_date=?,priority=?,approval=?,remarks=? WHERE id=?`, [desc, date, priority||'low', approval||'no', remarks||'', req.params.id]);
    else await db.query(`UPDATE ${table} SET description=?,due_date=?,remarks=? WHERE id=?`, [desc, date, remarks||'', req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tasks/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type, skipCompleted } = req.query;
    const table = getTable(type||'delegation');
    // v16: bulk-delete flows pass skipCompleted=1 — refuse to delete completed tasks
    if (skipCompleted === '1' || skipCompleted === 'true') {
      const [rows] = await db.query(`SELECT status FROM ${table} WHERE id=?`, [req.params.id]);
      if (rows[0] && rows[0].status === 'completed') {
        return res.status(400).json({ error: 'Completed tasks cannot be deleted in bulk', skipped: true });
      }
    }
    await db.query(`DELETE FROM ${table} WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk delete by user — v16: completed tasks excluded
app.delete('/api/tasks/user/:userId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type } = req.query;
    const table = getTable(type || 'delegation');
    await db.query(`DELETE FROM ${table} WHERE assigned_to = ? AND status != 'completed'`, [req.params.userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Transfer pending tasks to today
app.put('/api/tasks/user/:userId/transfer-today', requireAuth, requireAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { type } = req.query;
    const table = getTable(type || 'delegation');
    await db.query(`UPDATE ${table} SET due_date=? WHERE assigned_to=? AND status='pending'`,
      [today, req.params.userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tasks/delete-by-date', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: 'Date required' });
    const [result] = await db.query('DELETE FROM checklist_tasks WHERE due_date=?', [date]);
    res.json({ success: true, deleted: result.affectedRows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Count checklist tasks for a user (all time or by year, optionally filtered by frequency).
// v16: completed tasks are EXCLUDED — bulk delete sirf pending/revised pe lagti hai.
app.get('/api/tasks/checklist-year-count', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId, year, frequency } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const where = ['assigned_to=?', "status!='completed'"];
    const params = [userId];
    if (year && year !== 'all') { where.push('YEAR(due_date)=?'); params.push(year); }
    if (frequency && frequency !== 'all') { where.push('frequency=?'); params.push(frequency); }
    const [rows] = await db.query(
      `SELECT COUNT(*) AS count FROM checklist_tasks WHERE ${where.join(' AND ')}`, params);
    res.json({ count: rows[0].count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete checklist tasks for a user — optionally filtered by frequency.
// v16: completed tasks NEVER deleted in bulk; frequency filter respected.
app.post('/api/tasks/checklist-year-delete', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId, frequency } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const where = ['assigned_to=?', "status!='completed'"];
    const params = [userId];
    if (frequency && frequency !== 'all') { where.push('frequency=?'); params.push(frequency); }
    const [result] = await db.query(
      `DELETE FROM checklist_tasks WHERE ${where.join(' AND ')}`, params);
    res.json({ success: true, deleted: result.affectedRows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// APPROVALS
// ══════════════════════════════════════════════════════
app.get('/api/approvals', requireAuth, async (req, res) => {
  try {
    const role = req.session.role;
    const isAdminOrPC = role === 'admin' || role === 'pc';
    // Admin/PC sees all pending approvals; others see only theirs
    const whereClause = isAdminOrPC
      ? `WHERE ta.status='pending'`
      : `WHERE ta.requested_to=? AND ta.status='pending'`;
    const params = isAdminOrPC ? [] : [req.session.userId];
    const [rows] = await db.query(`SELECT ta.*,u1.name AS requestedByName,u2.name AS requestedToName,dt.description,dt.approval AS taskApproval FROM task_approvals ta JOIN users u1 ON ta.requested_by=u1.id JOIN users u2 ON ta.requested_to=u2.id LEFT JOIN delegation_tasks dt ON ta.task_id=dt.id AND ta.task_type='delegation' ${whereClause} ORDER BY ta.created_at DESC`, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/approvals/count', requireAuth, async (req, res) => {
  try {
    const role = req.session.role;
    const isAdminOrPC = role === 'admin' || role === 'pc';
    const [rows] = isAdminOrPC
      ? await db.query(`SELECT COUNT(*) AS count FROM task_approvals WHERE status='pending'`)
      : await db.query(`SELECT COUNT(*) AS count FROM task_approvals WHERE requested_to=? AND status='pending'`, [req.session.userId]);
    res.json({ count: rows[0].count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/approvals/:id', requireAuth, async (req, res) => {
  try {
    const { action, note } = req.body;
    const role = req.session.role;
    const [rows] = await db.query('SELECT * FROM task_approvals WHERE id=?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Approval not found' });
    const appr = rows[0];
    // PC and admin can approve any; others only their own
    const canApprove = role === 'admin' || role === 'pc' || appr.requested_to === req.session.userId;
    if (!canApprove) return res.status(403).json({ error: 'Not allowed' });
    await db.query('UPDATE task_approvals SET status=?,note=? WHERE id=?', [action, note||'', req.params.id]);
    const table = getTable(appr.task_type);
    if (action === 'approved') {
      const completedAt = appr.action_type === 'completed' ? new Date().toISOString().slice(0,19).replace('T',' ') : null;
      await db.query(`UPDATE ${table} SET status=?,waiting_approval=0,completed_at=? WHERE id=?`, [appr.action_type, completedAt, appr.task_id]);
    } else await db.query(`UPDATE ${table} SET waiting_approval=0 WHERE id=?`, [appr.task_id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// MIS
// ══════════════════════════════════════════════════════
app.get('/api/mis', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'Dates required' });
    const isHod = req.session.role === 'hod';
    // HOD ke liye apne department ka filter
    let deptFilter = '';
    let deptParams = [start, end];
    if (isHod) {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [req.session.userId]);
      const dept = me[0]?.department || '';
      deptFilter = 'AND u.department=?';
      deptParams = [start, end, dept];
    }

    const calc = rows => rows.map(r => {
      const total=parseInt(r.total)||0, pending=parseInt(r.pending)||0, overdue=parseInt(r.overdue)||0, revised=parseInt(r.revised)||0;
      let score = total > 0 ? Math.max(-100, Math.round((0-(pending/total)*100-(overdue/total)*50-(revised/total)*25)*10)/10) : 0;
      return { ...r, delayed: overdue, score };
    });
    const [delRows] = await db.query(`SELECT u.id AS userId,u.name,COUNT(*) AS total,SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,SUM(CASE WHEN t.status='revised' THEN 1 ELSE 0 END) AS revised,SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue FROM delegation_tasks t JOIN users u ON t.assigned_to=u.id WHERE t.due_date BETWEEN ? AND ? ${deptFilter} GROUP BY u.id,u.name ORDER BY u.name`, deptParams);
    const [chlRows] = await db.query(`SELECT u.id AS userId,u.name,COUNT(*) AS total,SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,0 AS revised,SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue FROM checklist_tasks t JOIN users u ON t.assigned_to=u.id WHERE t.due_date BETWEEN ? AND ? ${deptFilter} GROUP BY u.id,u.name ORDER BY u.name`, deptParams);
    res.json({ delegation: calc(delRows), checklist: calc(chlRows) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// OWNER DASHBOARD — company-wide aggregate report
// FMS + Delegation + Checklist + Leave, ek hi call me.
// Filters: start, end (due_date range), department.
// SIRF in emails ko access (owner-only):
// ══════════════════════════════════════════════════════
const OWNER_EMAILS = ['daharwal.harsh@e-marketing.io', 'owner@gmail.com'];
async function isOwnerUser(req) {
  try {
    const [u] = await db.query('SELECT email FROM users WHERE id=?', [req.session.userId]);
    return OWNER_EMAILS.includes(String(u[0]?.email || '').trim().toLowerCase());
  } catch { return false; }
}

app.get('/api/owner-dashboard', requireAuth, async (req, res) => {
  try {
    if (!(await isOwnerUser(req))) return res.status(403).json({ error: 'Owner access only' });
    const { start, end, department } = req.query;
    const s = start || '2000-01-01';
    const e = end || '2100-01-01';
    const useDept = department && department !== 'all';
    const dC = useDept ? 'AND u.department = ?' : '';
    const dP = useDept ? [department] : [];
    const num = v => parseInt(v) || 0;
    // Frequency filter — SIRF checklist_tasks pe (delegation me frequency column nahi).
    const freq = req.query.frequency;
    const useFreq = freq && freq !== 'all';
    const fC = (table) => (useFreq && table === 'checklist_tasks') ? 'AND t.frequency = ?' : '';
    const fP = (table) => (useFreq && table === 'checklist_tasks') ? [freq] : [];

    // ── Per-table aggregate (delegation / checklist) ──
    const taskTotals = async (table) => {
      const [r] = await db.query(
        `SELECT COUNT(*) AS total,
           SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN t.status='revised' THEN 1 ELSE 0 END) AS revised,
           SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
         FROM ${table} t JOIN users u ON t.assigned_to=u.id
         WHERE t.due_date BETWEEN ? AND ? ${dC} ${fC(table)}`, [s, e, ...dP, ...fP(table)]);
      const x = r[0] || {};
      return { total:num(x.total), pending:num(x.pending), completed:num(x.completed), revised:num(x.revised), overdue:num(x.overdue) };
    };
    const delegation = await taskTotals('delegation_tasks');
    const checklist  = await taskTotals('checklist_tasks');

    // ── By department (merge del + chl) ──
    const deptAgg = async (table) => {
      const [r] = await db.query(
        `SELECT u.department AS dept, COUNT(*) AS total,
           SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
         FROM ${table} t JOIN users u ON t.assigned_to=u.id
         WHERE t.due_date BETWEEN ? AND ? ${dC} ${fC(table)} GROUP BY u.department`, [s, e, ...dP, ...fP(table)]);
      return r;
    };
    const deptMap = {};
    for (const src of [await deptAgg('delegation_tasks'), await deptAgg('checklist_tasks')]) {
      for (const row of src) {
        const d = row.dept || '(none)';
        deptMap[d] = deptMap[d] || { department:d, total:0, pending:0, completed:0, overdue:0 };
        deptMap[d].total+=num(row.total); deptMap[d].pending+=num(row.pending);
        deptMap[d].completed+=num(row.completed); deptMap[d].overdue+=num(row.overdue);
      }
    }
    const byDepartment = Object.values(deptMap).sort((a,b)=>b.total-a.total);

    // ── Monthly trend (merge del + chl) ──
    const trendAgg = async (table) => {
      const [r] = await db.query(
        `SELECT DATE_FORMAT(t.due_date,'%Y-%m') AS ym,
           SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending
         FROM ${table} t JOIN users u ON t.assigned_to=u.id
         WHERE t.due_date BETWEEN ? AND ? ${dC} ${fC(table)} GROUP BY DATE_FORMAT(t.due_date,'%Y-%m')`, [s, e, ...dP, ...fP(table)]);
      return r;
    };
    const trendMap = {};
    for (const src of [await trendAgg('delegation_tasks'), await trendAgg('checklist_tasks')]) {
      for (const row of src) {
        const m = row.ym; if (!m) continue;
        trendMap[m] = trendMap[m] || { month:m, completed:0, pending:0 };
        trendMap[m].completed+=num(row.completed); trendMap[m].pending+=num(row.pending);
      }
    }
    const trend = Object.values(trendMap).sort((a,b)=>a.month.localeCompare(b.month)).slice(-12);

    // ── Top users (merge del + chl) ──
    const userAgg = async (table) => {
      const [r] = await db.query(
        `SELECT u.id, u.name, u.department AS dept, COUNT(*) AS total,
           SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
         FROM ${table} t JOIN users u ON t.assigned_to=u.id
         WHERE t.due_date BETWEEN ? AND ? ${dC} ${fC(table)} GROUP BY u.id, u.name, u.department`, [s, e, ...dP, ...fP(table)]);
      return r;
    };
    const uMap = {};
    for (const src of [await userAgg('delegation_tasks'), await userAgg('checklist_tasks')]) {
      for (const row of src) {
        const id = row.id;
        uMap[id] = uMap[id] || { id, name:row.name, department:row.dept||'(none)', total:0, pending:0, completed:0, overdue:0 };
        uMap[id].total+=num(row.total); uMap[id].pending+=num(row.pending);
        uMap[id].completed+=num(row.completed); uMap[id].overdue+=num(row.overdue);
      }
    }
    const topUsers = Object.values(uMap).map(u => ({
      ...u, score: u.total > 0 ? Math.round((u.completed / u.total) * 100) : 0
    })).sort((a,b)=>b.total-a.total).slice(0, 20);

    // ── Leave ──
    const leaveDeptC = useDept ? 'AND u.department = ?' : '';
    const [lvR] = await db.query(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN l.status='pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN l.status='approved' THEN 1 ELSE 0 END) AS approved,
         SUM(CASE WHEN l.status='rejected' THEN 1 ELSE 0 END) AS rejected
       FROM leave_tracker l JOIN users u ON l.user_id=u.id WHERE 1=1 ${leaveDeptC}`, dP);
    const lv = lvR[0] || {};
    const leave = { total:num(lv.total), pending:num(lv.pending), approved:num(lv.approved), rejected:num(lv.rejected) };
    const [lvTypeR] = await db.query(
      `SELECT l.type AS type, COUNT(*) AS n FROM leave_tracker l JOIN users u ON l.user_id=u.id WHERE 1=1 ${leaveDeptC} GROUP BY l.type`, dP);
    const leaveByType = {};
    for (const row of lvTypeR) leaveByType[row.type || 'other'] = num(row.n);

    // ── FMS (Google Sheets — SLOW: 10 sheets read hoti hain). Isliye default me
    //    SKIP karte hain (loading:true) taaki dashboard turant render ho; frontend
    //    alag se ?fms=1 se ise background me maangta hai. ──
    let fms = { total:0, pending:0, done:0, sheets:0, error:null, loading:true };
    if (req.query.fms === '1') {
      fms.loading = false;
      try {
        const stats = await computeFmsStats(useDept ? department : '');
        const perFms = stats.perFms || [];
        fms.sheets = perFms.length;
        for (const f of perFms) { fms.pending += num(f.pending); fms.done += num(f.done); fms.total += num(f.total); }
        if (stats.errors && stats.errors.length) fms.error = stats.errors.join(', ');
      } catch (e) { fms.error = 'FMS data unavailable'; }
    }

    // ── Department list for the filter dropdown ──
    const [deptList] = await db.query(`SELECT DISTINCT department FROM users WHERE department IS NOT NULL AND department != '' ORDER BY department`);

    res.json({
      totals: { delegation, checklist, fms, leave },
      byDepartment, trend, topUsers, leaveByType,
      departments: deptList.map(d => d.department),
      generatedAt: new Date().toISOString()
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── OWNER DASHBOARD DETAILS — ek module ke pending items + doer ka naam ──
// module = delegation | checklist | fms | leave. Card click par popup me dikhta hai.
app.get('/api/owner-dashboard/details', requireAuth, async (req, res) => {
  try {
    if (!(await isOwnerUser(req))) return res.status(403).json({ error: 'Owner access only' });
    const { module, start, end, department, frequency } = req.query;
    const s = start || '2000-01-01';
    const e = end || '2100-01-01';
    const useDept = department && department !== 'all';
    const dC = useDept ? 'AND u.department = ?' : '';
    const dP = useDept ? [department] : [];
    const today = new Date().toISOString().slice(0, 10);

    if (module === 'delegation' || module === 'checklist') {
      const table = module === 'delegation' ? 'delegation_tasks' : 'checklist_tasks';
      const isChl = module === 'checklist';
      const useFreq = isChl && frequency && frequency !== 'all';
      const fC = useFreq ? 'AND t.frequency = ?' : '';
      const fP = useFreq ? [frequency] : [];
      const [rows] = await db.query(
        `SELECT t.description, u.name AS doer, u.department AS dept,
           DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date, t.status${isChl ? ', t.frequency' : ''}
         FROM ${table} t JOIN users u ON t.assigned_to=u.id
         WHERE t.status='pending' AND t.due_date BETWEEN ? AND ? ${dC} ${fC}
         ORDER BY t.due_date ASC`, [s, e, ...dP, ...fP]);
      rows.forEach(r => { r.overdue = (r.due_date || '') < today; });
      return res.json({ module, count: rows.length, rows });
    }

    if (module === 'leave') {
      const [rows] = await db.query(
        `SELECT u.name AS doer, u.department AS dept, l.type, l.status,
           DATE_FORMAT(l.start_date,'%Y-%m-%d') AS start_date,
           DATE_FORMAT(l.end_date,'%Y-%m-%d') AS end_date, l.reason
         FROM leave_tracker l JOIN users u ON l.user_id=u.id
         WHERE 1=1 ${dC} ORDER BY l.applied_at DESC`, dP);
      return res.json({ module, count: rows.length, rows });
    }

    if (module === 'fms') {
      const stats = await computeFmsStats(useDept ? department : '', true);
      const perUserPending = stats.perUserPending || {};
      const uids = Object.keys(perUserPending).map(x => parseInt(x)).filter(Boolean);
      const nameMap = {};
      if (uids.length) {
        const [us] = await db.query(`SELECT id,name,department FROM users WHERE id IN (${uids.map(() => '?').join(',')})`, uids);
        us.forEach(u => { nameMap[u.id] = u; });
      }
      const rows = [];
      for (const uid of Object.keys(perUserPending)) {
        const u = nameMap[uid] || { name: '(unknown)', department: '' };
        for (const item of perUserPending[uid]) {
          rows.push({ doer: u.name, dept: u.department, fmsName: item.fmsName, stepName: item.stepName, planValue: item.planValue, overdue: !!item.isLate });
        }
      }
      rows.sort((a, b) => (b.overdue - a.overdue) || String(a.doer).localeCompare(String(b.doer)));
      return res.json({ module, count: rows.length, rows, error: (stats.errors && stats.errors.length) ? stats.errors.join(', ') : null });
    }

    return res.status(400).json({ error: 'Unknown module' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── FMS Dashboard — row-level pending tasks (like delegation/checklist) ──
app.get('/api/fms-dashboard', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.role;
    const isAdmin = role === 'admin' || role === 'pc';
    const isHod = role === 'hod';
    const filterEmployee = req.query.employee;

    const today = new Date().toISOString().split('T')[0];

    // Determine which user IDs to show
    let targetUserIds = null; // null = all (admin)
    if (isAdmin && filterEmployee && filterEmployee !== 'all') {
      targetUserIds = [parseInt(filterEmployee)];
    } else if (isHod) {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      const dept = me[0]?.department || '';
      if (filterEmployee && filterEmployee !== 'all') {
        targetUserIds = [parseInt(filterEmployee)];
      } else {
        const [deptUsers] = await db.query('SELECT id FROM users WHERE department=? AND role NOT IN (?,?)', [dept, 'admin', 'hod']);
        targetUserIds = deptUsers.map(u => u.id);
        if (!targetUserIds.length) return res.json({ rows: [], pendingCount: 0 });
      }
    } else {
      // Regular employee — only their own steps
      targetUserIds = [uid];
    }

    // Get FMS sheets
    let fmsList;
    if (isAdmin && !filterEmployee || (isAdmin && filterEmployee === 'all')) {
      [fmsList] = await db.query('SELECT * FROM fms_sheets ORDER BY fms_name ASC');
    } else {
      // Get FMS where targetUserIds are doers
      [fmsList] = await db.query(
        `SELECT DISTINCT fs.* FROM fms_sheets fs
         JOIN fms_steps fst ON fst.fms_id=fs.id
         JOIN fms_step_doers fsd ON fsd.step_id=fst.id
         WHERE fsd.user_id IN (${targetUserIds.map(()=>'?').join(',')})
         ORDER BY fs.fms_name ASC`, targetUserIds);
    }

    if (!fmsList.length) return res.json({ rows: [], pendingCount: 0 });

    const allRows = [];

    for (const sheet of fmsList) {
      const fmsName = sheet.fms_name || sheet.sheet_name;

      // Get steps for this FMS that are assigned to targetUserIds
      let steps;
      if (isAdmin && (!filterEmployee || filterEmployee === 'all')) {
        [steps] = await db.query('SELECT * FROM fms_steps WHERE fms_id=? ORDER BY step_order ASC', [sheet.id]);
      } else {
        [steps] = await db.query(
          `SELECT DISTINCT fst.* FROM fms_steps fst
           JOIN fms_step_doers fsd ON fsd.step_id=fst.id
           WHERE fst.fms_id=? AND fsd.user_id IN (${targetUserIds.map(()=>'?').join(',')})
           ORDER BY fst.step_order ASC`, [sheet.id, ...targetUserIds]);
      }
      if (!steps.length) continue;

      // Get doer names for each step
      for (const step of steps) {
        const [doers] = await db.query(
          `SELECT u.id, u.name FROM fms_step_doers fsd JOIN users u ON fsd.user_id=u.id WHERE fsd.step_id=?`, [step.id]);
        step.doerNames = doers.map(d => d.name).join(', ');
        step.doerIds = doers.map(d => d.id);
      }

      try {
        const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
        const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
        const tabName = sheet.sheet_name || 'Sheet1';
        const headerRowIdx = (sheet.header_row || 1) - 1;

        const filteredSteps = steps; // fix: was undefined, use steps array
        const allCols = filteredSteps.flatMap(s => [colToIdx(s.plan_col), colToIdx(s.actual_col)]).filter(x => x >= 0);
        if (!allCols.length) continue;
        const maxCol = Math.max(...allCols);
        const lastCol = idxToCol(maxCol);
        const range = `${tabName}!A:${lastCol}`;

        const response = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range });
        const sheetData = response.data.values || [];
        const headers = sheetData[headerRowIdx] || [];
        const dataRows = sheetData.slice(headerRowIdx + 1);

        for (const step of steps) {
          const planIdx = colToIdx(step.plan_col);
          const actualIdx = colToIdx(step.actual_col);
          if (planIdx < 0 || actualIdx < 0) continue;

          dataRows.forEach((row, i) => {
            const planVal = (row[planIdx] || '').trim();
            const actualVal = (row[actualIdx] || '').trim();
            if (!planVal || actualVal) return; // skip if no plan or already done

            // Parse plan date — try to extract date from value
            // planVal might be a date string like "2026-04-07" or "07/04/2026" or just text
            let planDate = '';
            const dateMatch = planVal.match(/(\d{4}-\d{2}-\d{2})|(\d{2}[\/\-]\d{2}[\/\-]\d{4})/);
            if (dateMatch) {
              const raw = dateMatch[0];
              if (raw.includes('-') && raw.length === 10 && raw[4] === '-') {
                planDate = raw; // already YYYY-MM-DD
              } else {
                // DD/MM/YYYY → YYYY-MM-DD
                const parts = raw.split(/[\/\-]/);
                if (parts.length === 3) planDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
              }
            }

            // isLate: plan date is in the past and still pending
            const isLate = planDate && planDate < today;

            allRows.push({
              fmsName,
              fmsId: sheet.id,
              stepName: step.step_name,
              stepId: step.id,
              doer: step.doerNames || '—',
              planValue: planVal,
              planDate: planDate || '',
              isLate,
              rowNumber: headerRowIdx + 1 + i + 1
            });
          });
        }
      } catch(e) {
        // Skip sheet on error, don't fail whole request
      }
    }

    res.json({ rows: allRows, pendingCount: allRows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/mis/detail', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { userId, type, start, end } = req.query;
    if (!userId || !start || !end) return res.status(400).json({ error: 'Missing params' });
    const table = type === 'delegation' ? 'delegation_tasks' : 'checklist_tasks';
    const [tasks] = await db.query(`SELECT t.id,t.description,t.status,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,u2.name AS assigned_by_name FROM ${table} t JOIN users u2 ON t.assigned_by=u2.id WHERE t.assigned_to=? AND t.due_date BETWEEN ? AND ? ORDER BY t.due_date ASC`, [userId, start, end]);
    res.json({ tasks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── All MIS — per employee combined score ──
app.get('/api/mis/all', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'Dates required' });
    const isHod = req.session.role === 'hod';
    const uid = req.session.userId;

    // HOD ka department ek hi baar nikaal lo (FMS aur task filter dono me use hoga)
    let hodDept = '';
    if (isHod) {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      hodDept = me[0]?.department || '';
    }

    // Same deptFilter logic as /api/mis — tasks JOIN users se filter
    let deptFilter = '';
    let deptParams = [start, end];
    if (isHod) {
      deptFilter = 'AND u.department=?';
      deptParams = [start, end, hodDept];
    }

    const calc = (total, pending, overdue, revised) => {
      total = parseInt(total)||0; pending = parseInt(pending)||0;
      overdue = parseInt(overdue)||0; revised = parseInt(revised)||0;
      const score = total > 0 ? Math.max(-100, Math.round((0-(pending/total)*100-(overdue/total)*50-(revised/total)*25)*10)/10) : 0;
      return { total, pending, overdue, revised, score };
    };

    // Fetch delegation + checklist stats per user (same style as /api/mis)
    const [delRows] = await db.query(
      `SELECT u.id AS userId, u.name, u.department,
        COUNT(*) AS total,
        SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN t.status='revised' THEN 1 ELSE 0 END) AS revised,
        SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
       FROM delegation_tasks t JOIN users u ON t.assigned_to=u.id
       WHERE t.due_date BETWEEN ? AND ? ${deptFilter}
       GROUP BY u.id, u.name, u.department ORDER BY u.name`, deptParams);

    const [chlRows] = await db.query(
      `SELECT u.id AS userId, u.name, u.department,
        COUNT(*) AS total,
        SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,
        0 AS revised,
        SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
       FROM checklist_tasks t JOIN users u ON t.assigned_to=u.id
       WHERE t.due_date BETWEEN ? AND ? ${deptFilter}
       GROUP BY u.id, u.name, u.department ORDER BY u.name`, deptParams);

    // Merge by userId
    const userMap = {};
    for (const r of delRows) {
      userMap[r.userId] = { userId: r.userId, name: r.name, department: r.department||'',
        delegation: calc(r.total, r.pending, r.overdue, r.revised),
        delegationCompleted: parseInt(r.completed)||0,
        checklist: calc(0,0,0,0), checklistCompleted: 0 };
      userMap[r.userId].delegation.completed = parseInt(r.completed)||0;
    }
    for (const r of chlRows) {
      if (!userMap[r.userId]) {
        userMap[r.userId] = { userId: r.userId, name: r.name, department: r.department||'',
          delegation: calc(0,0,0,0), delegationCompleted: 0,
          checklist: calc(0,0,0,0), checklistCompleted: 0 };
        userMap[r.userId].delegation.completed = 0;
      }
      userMap[r.userId].checklist = calc(r.total, r.pending, r.overdue, 0);
      userMap[r.userId].checklist.completed = parseInt(r.completed)||0;
      userMap[r.userId].checklistCompleted = parseInt(r.completed)||0;
    }

    // Fetch week plan for each user — DATE_FORMAT taaki frontend ko clean YYYY-MM-DD mile (ISO timestamp nahi)
    let planMap = {};
    try {
      const [plans] = await db.query(
        `SELECT employee_id, target_count, DATE_FORMAT(start_date,'%Y-%m-%d') AS start_date, improvement_pct FROM week_plans WHERE start_date BETWEEN ? AND ? ORDER BY start_date DESC`, [start, end]);
      for (const p of plans) {
        if (!planMap[p.employee_id]) planMap[p.employee_id] = p;
      }
    } catch(e) { /* week_plans table may not exist yet */ }

    // ── FMS contribution per user (shared engine — deterministic + cached) ──
    // computeFmsStats() se hi /api/mis/fms bhi data leta hai, isliye per-employee
    // FMS aur FMS Overview ke numbers ab HAMESHA match karte hain. HOD/admin dono
    // par EK jaisa dept-filter lagta hai. Read fail ho to fmsErrors me naam aata hai.
    let fmsUserMap = {};
    let fmsErrors = [];
    try {
      // ROLE-INDEPENDENT: hamesha all-doers crediting (hodDept='') taaki ek hi employee ka
      // FMS total/score admin aur HOD dono ko BILKUL EK JAISA dikhe. Dept ka filter sirf
      // niche rows (kaun-kaun employee dikhega) par lagta hai — numbers par nahi.
      const fmsStats = await computeFmsStats('');
      fmsUserMap = fmsStats.perUser || {};
      fmsErrors = fmsStats.errors || [];
    } catch (e) { fmsErrors = ['FMS data unavailable']; }

    // Agar koi user sirf FMS me kaam karta hai (del/chl me 0 tasks) to use bhi userMap me daalo.
    if (Object.keys(fmsUserMap).length) {
      const fmsUserIds = Object.keys(fmsUserMap).map(x => parseInt(x)).filter(x => !userMap[x]);
      if (fmsUserIds.length) {
        let userQ = `SELECT id, name, department FROM users WHERE id IN (${fmsUserIds.map(()=>'?').join(',')})`;
        const userQParams = [...fmsUserIds];
        if (isHod) { userQ += ' AND department=?'; userQParams.push(hodDept); }
        const [extraUsers] = await db.query(userQ, userQParams);
        for (const u of extraUsers) {
          userMap[u.id] = { userId: u.id, name: u.name, department: u.department||'',
            delegation: calc(0,0,0,0), delegationCompleted: 0,
            checklist: calc(0,0,0,0), checklistCompleted: 0 };
          userMap[u.id].delegation.completed = 0;
        }
      }
    }

    const rows = Object.values(userMap).map(u => {
      const d = u.delegation, c = u.checklist;
      const fms = fmsUserMap[u.userId] || { total: 0, pending: 0, done: 0 };
      // FMS total = done + pending (dono Total column me count hone chahiye)
      const fmsRealTotal = fms.done + fms.pending;
      const totalAll = d.total + c.total + fmsRealTotal;
      const pendingAll = d.pending + c.pending + fms.pending;
      const overdueAll = d.overdue + c.overdue;
      const revisedAll = d.revised;
      const completedAll = (d.completed||0) + (c.completed||0) + fms.done;
      const overallScore = totalAll > 0
        ? Math.max(-100, Math.round((0-(pendingAll/totalAll)*100-(overdueAll/totalAll)*50-(revisedAll/totalAll)*25)*10)/10)
        : null;
      const plan = planMap[u.userId] || null;
      const fmsScore = fmsRealTotal > 0
        ? Math.round((fms.done / fmsRealTotal) * 100 * 10) / 10  // 0-100% completion
        : null;
      return { ...u, fms: { total: fmsRealTotal, pending: fms.pending, done: fms.done, score: fmsScore },
        totalAll, pendingAll, overdueAll, revisedAll, completedAll, overallScore, plan };
    }).filter(u => u.totalAll > 0).sort((a,b) => a.name.localeCompare(b.name));

    // Backward compatible: agar koi error nahi to seedha array bhejte hain (jaise pehle).
    // Error hone par object bhejte hain taaki frontend warning dikha sake.
    if (fmsErrors.length) return res.json({ rows, fmsErrors });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── FMS MIS ──
app.get('/api/mis/fms', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'Dates required' });
    const isHod = req.session.role === 'hod';
    const uid = req.session.userId;

    // HOD ka department (FMS dept-filter ke liye)
    let hodDept = '';
    if (isHod) {
      const [meRow] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      hodDept = meRow[0]?.department || '';
    }

    // Same shared engine jo /api/mis/all use karta hai => numbers HAMESHA match honge
    const fmsStats = await computeFmsStats(hodDept);
    res.json(fmsStats.perFms);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Export full MIS report into a Google Sheet tab ──
// Frontend builds the report rows (reusing the same /api/mis* data the
// page already renders) and sends them here. The tab name is FIXED
// server-side ('MIS Report') so this endpoint can NEVER overwrite a DB
// tab (users, tasks, fms_*, etc.). Admin/HOD/PC only.
app.post('/api/mis/export-sheet', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { rows } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ error: 'No report rows provided' });
    }
    const TAB = 'MIS Report';
    const result = await db.writeReportTab(TAB, rows);
    res.json({ ok: true, tab: TAB, rows: result.rows });
  } catch (err) {
    console.error('MIS export-sheet error:', err);
    res.status(500).json({ error: err.message || 'Sheet write failed' });
  }
});

// ══════════════════════════════════════════════════════
// EMPLOYEE RECORDS  (Admin / HOD / PC) — Plan vs Done
// ──────────────────────────────────────────────────────
// Ek hi CANONICAL source. Kisi bhi employee ke numbers (total / done / pending /
// score / committed plan) viewer ke role par DEPEND NAHI karte. Role sirf ye
// decide karta hai ki KAUN-KAUN employee dikhega:
//   • admin / pc  → sabhi employees
//   • hod         → sirf apne department ke employees
// Isi liye admin aur HOD dono ko ek hi employee ka EXACT same total/score dikhega.
// Har employee ke saath uska committed plan inline aata hai, aur pending tasks ki
// poori list (delegation + checklist + FMS) bhi.
// ══════════════════════════════════════════════════════
app.get('/api/employee-records', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'Dates required' });
    const isHod = req.session.role === 'hod';
    const uid = req.session.userId;

    // HOD ka department (sirf visibility ke liye)
    let hodDept = '';
    if (isHod) {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      hodDept = me[0]?.department || '';
    }

    // Score formula — bilkul wahi jo MIS me use hota hai (consistency)
    const calcScore = (total, pending, overdue, revised) => {
      total = parseInt(total)||0; pending = parseInt(pending)||0;
      overdue = parseInt(overdue)||0; revised = parseInt(revised)||0;
      return total > 0
        ? Math.max(-100, Math.round((0-(pending/total)*100-(overdue/total)*50-(revised/total)*25)*10)/10)
        : null;
    };

    // Dept filter sirf visibility ke liye (numbers par nahi)
    let deptFilter = '';
    let deptParams = [start, end];
    if (isHod) { deptFilter = 'AND u.department=?'; deptParams = [start, end, hodDept]; }

    // ── Delegation + Checklist aggregate per user ──
    const [delRows] = await db.query(
      `SELECT u.id AS userId, u.name, u.department,
        COUNT(*) AS total,
        SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN t.status='revised' THEN 1 ELSE 0 END) AS revised,
        SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
       FROM delegation_tasks t JOIN users u ON t.assigned_to=u.id
       WHERE t.due_date BETWEEN ? AND ? ${deptFilter}
       GROUP BY u.id, u.name, u.department`, deptParams);

    const [chlRows] = await db.query(
      `SELECT u.id AS userId, u.name, u.department,
        COUNT(*) AS total,
        SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
       FROM checklist_tasks t JOIN users u ON t.assigned_to=u.id
       WHERE t.due_date BETWEEN ? AND ? ${deptFilter}
       GROUP BY u.id, u.name, u.department`, deptParams);

    const map = {};
    const ensure = (r) => {
      if (!map[r.userId]) map[r.userId] = {
        userId: r.userId, name: r.name, department: r.department || '',
        del: { total:0, pending:0, completed:0, revised:0, overdue:0 },
        chl: { total:0, pending:0, completed:0, overdue:0 },
        fms: { total:0, pending:0, done:0 }
      };
      return map[r.userId];
    };
    for (const r of delRows) {
      const e = ensure(r);
      e.del = { total:+r.total||0, pending:+r.pending||0, completed:+r.completed||0, revised:+r.revised||0, overdue:+r.overdue||0 };
    }
    for (const r of chlRows) {
      const e = ensure(r);
      e.chl = { total:+r.total||0, pending:+r.pending||0, completed:+r.completed||0, overdue:+r.overdue||0 };
    }

    // ── FMS (ROLE-INDEPENDENT: hamesha all-doers crediting) + pending detail ──
    let fmsPerUser = {}, fmsPerUserPending = {}, fmsErrors = [];
    try {
      const fmsStats = await computeFmsStats('', true);
      fmsPerUser = fmsStats.perUser || {};
      fmsPerUserPending = fmsStats.perUserPending || {};
      fmsErrors = fmsStats.errors || [];
    } catch (e) { fmsErrors = ['FMS data unavailable']; }

    // Sirf-FMS-walon ko bhi list me daalo (dept visibility ke saath)
    const fmsOnlyIds = Object.keys(fmsPerUser).map(x => parseInt(x)).filter(x => !map[x]);
    if (fmsOnlyIds.length) {
      let q = `SELECT id, name, department FROM users WHERE id IN (${fmsOnlyIds.map(()=>'?').join(',')})`;
      const qp = [...fmsOnlyIds];
      if (isHod) { q += ' AND department=?'; qp.push(hodDept); }
      const [extra] = await db.query(q, qp);
      for (const u of extra) ensure({ userId: u.id, name: u.name, department: u.department });
    }
    for (const e of Object.values(map)) {
      const f = fmsPerUser[e.userId] || { pending:0, done:0 };
      e.fms = { pending: f.pending||0, done: f.done||0, total: (f.pending||0)+(f.done||0) };
    }

    // ── Committed plans (week_plans) for range ──
    let planMap = {};
    try {
      const [plans] = await db.query(
        `SELECT employee_id, target_count, DATE_FORMAT(start_date,'%Y-%m-%d') AS start_date, improvement_pct
         FROM week_plans WHERE start_date BETWEEN ? AND ? ORDER BY start_date DESC`, [start, end]);
      for (const p of plans) if (!planMap[p.employee_id]) planMap[p.employee_id] = p;
    } catch (e) { /* table may not exist */ }

    // Jis employee ka plan committed hai par koi task/FMS nahi — usse bhi list me laao
    // (taaki "har employee ke saamne plan" dikhe). HOD ke liye dept visibility respect hoti hai.
    const planOnlyIds = Object.keys(planMap).map(x => parseInt(x)).filter(x => !map[x]);
    if (planOnlyIds.length) {
      let pq = `SELECT id, name, department FROM users WHERE id IN (${planOnlyIds.map(()=>'?').join(',')})`;
      const pqp = [...planOnlyIds];
      if (isHod) { pq += ' AND department=?'; pqp.push(hodDept); }
      const [pu] = await db.query(pq, pqp);
      for (const u of pu) ensure({ userId: u.id, name: u.name, department: u.department });
    }

    // ── Pending task lists (delegation + checklist) for visible users ──
    const visibleIds = Object.keys(map).map(x => parseInt(x));
    let delPending = {}, chlPending = {};
    if (visibleIds.length) {
      const ph = visibleIds.map(()=>'?').join(',');
      const [dp] = await db.query(
        `SELECT t.assigned_to AS uid, t.description, t.status,
                DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date
         FROM delegation_tasks t
         WHERE t.assigned_to IN (${ph}) AND t.due_date BETWEEN ? AND ?
           AND t.status IN ('pending','revised')
         ORDER BY t.due_date ASC`, [...visibleIds, start, end]);
      for (const r of dp) { (delPending[r.uid] = delPending[r.uid] || []).push(r); }
      const [cp] = await db.query(
        `SELECT t.assigned_to AS uid, t.description, t.status,
                DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date
         FROM checklist_tasks t
         WHERE t.assigned_to IN (${ph}) AND t.due_date BETWEEN ? AND ?
           AND t.status='pending'
         ORDER BY t.due_date ASC`, [...visibleIds, start, end]);
      for (const r of cp) { (chlPending[r.uid] = chlPending[r.uid] || []).push(r); }
    }

    // ── Assemble canonical rows ──
    const rows = Object.values(map).map(e => {
      const total   = e.del.total + e.chl.total + e.fms.total;
      const pending = e.del.pending + e.chl.pending + e.fms.pending;
      const done    = e.del.completed + e.chl.completed + e.fms.done;
      const overdue = e.del.overdue + e.chl.overdue;
      const revised = e.del.revised;
      const score   = calcScore(total, pending, overdue, revised);
      const plan    = planMap[e.userId] || null;
      return {
        userId: e.userId, name: e.name, department: e.department,
        committed: plan ? {
          start_date: plan.start_date,
          target_count: plan.target_count,
          improvement_pct: (plan.improvement_pct === null || plan.improvement_pct === undefined) ? null : plan.improvement_pct
        } : null,
        total, done, pending, overdue, revised, score,
        breakdown: {
          delegation: { total: e.del.total, done: e.del.completed, pending: e.del.pending },
          checklist:  { total: e.chl.total, done: e.chl.completed, pending: e.chl.pending },
          fms:        { total: e.fms.total, done: e.fms.done,       pending: e.fms.pending }
        },
        pendingTasks: {
          delegation: delPending[e.userId] || [],
          checklist:  chlPending[e.userId] || [],
          fms:        fmsPerUserPending[e.userId] || []
        }
      };
    }).filter(r => r.total > 0 || r.committed)
      .sort((a,b) => a.name.localeCompare(b.name));

    res.json({ rows, fmsErrors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PC: Users with pending tasks (for smart dropdown) ──
app.get('/api/users/with-pending-tasks', requireAuth, async (req, res) => {
  try {
    const df = safeDate(req.query.dateFrom), dt = safeDate(req.query.dateTo);
    let dateFilter = 'AND t.due_date <= CURDATE()';
    if (df && dt) dateFilter = `AND t.due_date BETWEEN '${df}' AND '${dt}'`;
    const [rows] = await db.query(`
      SELECT DISTINCT u.id, u.name FROM users u
      WHERE u.id IN (
        SELECT DISTINCT assigned_to FROM delegation_tasks t WHERE status='pending' ${dateFilter}
        UNION
        SELECT DISTINCT assigned_to FROM checklist_tasks t WHERE status='pending' ${dateFilter}
      ) AND u.role NOT IN ('admin','pc')
      ORDER BY u.name ASC`);
    res.json(rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// USERS
// ══════════════════════════════════════════════════════
app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id,name,email,notification_email,role,phone,department,week_off,extra_off FROM users ORDER BY role DESC,name ASC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, email, notification_email, password, role, phone, department, week_off, extra_off } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    const [ex] = await db.query('SELECT id FROM users WHERE email=?', [email]);
    if (ex[0]) return res.status(400).json({ error: 'Email already exists' });
    await db.query('INSERT INTO users (name,email,notification_email,password,role,phone,department,week_off,extra_off) VALUES (?,?,?,?,?,?,?,?,?)',
      [name, email, notification_email||'', password, role||'user', phone||null, department||'', week_off||'', extra_off||'']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, email, notification_email, role, password, phone, department, week_off, extra_off } = req.body;
    if (password) await db.query('UPDATE users SET name=?,email=?,notification_email=?,role=?,password=?,phone=?,department=?,week_off=?,extra_off=? WHERE id=?',
      [name,email,notification_email||'',role,password,phone||null,department||'',week_off||'',extra_off||'',req.params.id]);
    else await db.query('UPDATE users SET name=?,email=?,notification_email=?,role=?,phone=?,department=?,week_off=?,extra_off=? WHERE id=?',
      [name,email,notification_email||'',role,phone||null,department||'',week_off||'',extra_off||'',req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.session.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
    await db.query('DELETE FROM users WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk add users via CSV
app.post('/api/users/bulk', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { users } = req.body;
    if (!users || !users.length) return res.status(400).json({ error: 'No users provided' });
    let added = 0, skipped = 0, errors = [];
    for (const u of users) {
      if (!u.name || !u.email || !u.password) { errors.push(`${u.email||'?'}: missing fields`); continue; }
      const [ex] = await db.query('SELECT id FROM users WHERE email=?', [u.email]);
      if (ex[0]) { skipped++; continue; }
      await db.query('INSERT INTO users (name,email,password,role,phone,department,week_off,extra_off) VALUES (?,?,?,?,?,?,?,?)',
        [u.name, u.email, u.password, u.role||'user', u.phone||null, u.department||'', u.week_off||'', u.extra_off||'']);
      added++;
    }
    res.json({ success: true, added, skipped, errors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// PROFILE
// ══════════════════════════════════════════════════════
app.put('/api/profile', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const { name, email, notification_email, phone, currentPassword, newPassword, profileImage } = req.body;
    if (currentPassword) {
      const [rows] = await db.query('SELECT password FROM users WHERE id=?', [uid]);
      const check = rows[0] ? checkPassword(currentPassword, rows[0].password) : { ok: false };
      if (!check.ok) return res.status(400).json({ error: 'Current password is incorrect' });
      if (newPassword) await db.query('UPDATE users SET name=?,email=?,notification_email=?,phone=?,password=? WHERE id=?', [name,email,notification_email||'',phone||null,newPassword,uid]);
      else await db.query('UPDATE users SET name=?,email=?,notification_email=?,phone=? WHERE id=?', [name,email,notification_email||'',phone||null,uid]);
    } else {
      await db.query('UPDATE users SET name=?,email=?,notification_email=?,phone=? WHERE id=?', [name,email,notification_email||'',phone||null,uid]);
    }
    if (profileImage !== undefined) await db.query('UPDATE users SET profile_image=? WHERE id=?', [profileImage||null, uid]);
    req.session.name = name;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/profile/image', requireAuth, async (req, res) => {
  try {
    await db.query('UPDATE users SET profile_image=? WHERE id=?', [req.body.image||null, req.session.userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// COMMENTS
// ══════════════════════════════════════════════════════
app.get('/api/comments/:type/:taskId', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT tc.id,tc.comment,tc.created_at,u.name AS userName FROM task_comments tc JOIN users u ON tc.user_id=u.id WHERE tc.task_id=? AND tc.task_type=? ORDER BY tc.created_at ASC`, [req.params.taskId, req.params.type]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/comments', requireAuth, async (req, res) => {
  try {
    const { taskId, taskType, comment } = req.body;
    if (!comment || !taskId || !taskType) return res.status(400).json({ error: 'All fields required' });
    await db.query('INSERT INTO task_comments (task_id,task_type,user_id,comment) VALUES (?,?,?,?)', [taskId, taskType, req.session.userId, comment]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/comments/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM task_comments WHERE id=?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    if (rows[0].user_id !== req.session.userId && req.session.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
    await db.query('DELETE FROM task_comments WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// FMS ADMIN APIs
// ══════════════════════════════════════════════════════

app.get('/api/fms', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [sheets] = await db.query(`SELECT f.*,u.name AS createdByName FROM fms_sheets f JOIN users u ON f.created_by=u.id ORDER BY f.created_at DESC`);
    res.json(sheets);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fms/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [sheets] = await db.query('SELECT * FROM fms_sheets WHERE id=?', [req.params.id]);
    if (!sheets[0]) return res.status(404).json({ error: 'FMS not found' });
    const [steps] = await db.query('SELECT * FROM fms_steps WHERE fms_id=? ORDER BY step_order ASC', [req.params.id]);
    for (const step of steps) {
      const [doers] = await db.query(`SELECT fsd.user_id,u.name FROM fms_step_doers fsd JOIN users u ON fsd.user_id=u.id WHERE fsd.step_id=?`, [step.id]);
      step.doers = doers;
      const [extraRows] = await db.query('SELECT * FROM fms_extra_rows WHERE step_id=? ORDER BY id ASC', [step.id]);
      step.extraRows = extraRows;
      try { step.show_cols_parsed = JSON.parse(step.show_cols || '[]'); } catch(e) { step.show_cols_parsed = []; }
    }
    res.json({ sheet: sheets[0], steps });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fms', requireAuth, requireAdmin, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { fmsName, sheetName, sheetId, headerRow, totalSteps, steps } = req.body;
    const [result] = await conn.query(
      `INSERT INTO fms_sheets (fms_name,sheet_name,sheet_id,header_row,total_steps,created_by) VALUES (?,?,?,?,?,?)`,
      [fmsName||sheetName, sheetName, sheetId, headerRow||1, totalSteps||1, req.session.userId]
    );
    const fmsId = result.insertId;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const [sr] = await conn.query(
        `INSERT INTO fms_steps (fms_id,step_order,step_name,plan_col,actual_col,extra_input,extra_col,show_cols,delay_reason_col,doer_name_col) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [fmsId,i+1,s.stepName,s.planCol||'',s.actualCol||'',s.extraInput||'no',s.extraCol||'',JSON.stringify(s.showCols||[]),s.delayReasonCol||'',s.doerNameCol||'']
      );
      const stepId = sr.insertId;
      if (s.doers?.length) for (const uid of s.doers) await conn.query('INSERT INTO fms_step_doers (step_id,user_id) VALUES (?,?)', [stepId, uid]);
      if (s.extraInput==='yes' && s.extraRows?.length) for (const row of s.extraRows) await conn.query('INSERT INTO fms_extra_rows (step_id,row_label,col_letter,field_type,dropdown_options) VALUES (?,?,?,?,?)', [stepId, row.label||row.col_letter||'', row.col_letter||'', row.field_type||'text', row.dropdown_options||'']);
    }
    await conn.commit();
    res.json({ success: true, id: fmsId });
  } catch (err) { await conn.rollback(); res.status(500).json({ error: err.message }); } finally { conn.release(); }
});

app.put('/api/fms/:id', requireAuth, requireAdmin, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { fmsName, sheetName, sheetId, headerRow, steps } = req.body;
    await conn.query(`UPDATE fms_sheets SET fms_name=?,sheet_name=?,sheet_id=?,header_row=?,total_steps=? WHERE id=?`, [fmsName||sheetName, sheetName, sheetId, headerRow||1, steps.length, req.params.id]);
    const [oldSteps] = await conn.query('SELECT id FROM fms_steps WHERE fms_id=?', [req.params.id]);
    for (const os of oldSteps) {
      await conn.query('DELETE FROM fms_step_doers WHERE step_id=?', [os.id]);
      await conn.query('DELETE FROM fms_extra_rows WHERE step_id=?', [os.id]);
    }
    await conn.query('DELETE FROM fms_steps WHERE fms_id=?', [req.params.id]);
    for (let i=0; i<steps.length; i++) {
      const s = steps[i];
      const [sr] = await conn.query(
        `INSERT INTO fms_steps (fms_id,step_order,step_name,plan_col,actual_col,extra_input,extra_col,show_cols,delay_reason_col,doer_name_col) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [req.params.id,i+1,s.stepName,s.planCol||'',s.actualCol||'',s.extraInput||'no',s.extraCol||'',JSON.stringify(s.showCols||[]),s.delayReasonCol||'',s.doerNameCol||'']
      );
      const stepId = sr.insertId;
      if (s.doers?.length) for (const uid of s.doers) await conn.query('INSERT INTO fms_step_doers (step_id,user_id) VALUES (?,?)', [stepId, uid]);
      if (s.extraInput==='yes' && s.extraRows?.length) for (const row of s.extraRows) await conn.query('INSERT INTO fms_extra_rows (step_id,row_label,col_letter,field_type,dropdown_options) VALUES (?,?,?,?,?)', [stepId, row.label||row.col_letter||'', row.col_letter||'', row.field_type||'text', row.dropdown_options||'']);
    }
    await conn.commit();
    res.json({ success: true });
  } catch (err) { await conn.rollback(); res.status(500).json({ error: err.message }); } finally { conn.release(); }
});

app.delete('/api/fms/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM fms_sheets WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Fetch headers ONLY (fast — just one row from sheet) ──
app.post('/api/fms/fetch-headers', requireAuth, async (req, res) => {
  try {
    const { sheetId, sheetName, headerRow } = req.body;
    if (!sheetId) return res.status(400).json({ error: 'sheetId required' });
    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
    const spreadsheetId = extractSpreadsheetId(sheetId);
    const hRow = parseInt(headerRow) || 1;
    // Fetch ONLY the header row — very fast even for 10000-row sheets
    const range = sheetName ? `${sheetName}!${hRow}:${hRow}` : `${hRow}:${hRow}`;
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId, range,
      majorDimension: 'ROWS',
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const rawHeaders = (response.data.values || [[]])[0] || [];
    const headers = rawHeaders
      .map((h, i) => ({
        name: String(h ?? '').trim() || `COL_${idxToCol(i)}`,
        col: idxToCol(i),
        index: i
      }))
      .filter(h => String(h.name).trim().length > 0);
    res.json({ headers });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied. Share sheet with service account.' });
    if (err.code === 404) return res.status(400).json({ error: 'Sheet not found. Check Sheet ID.' });
    res.status(500).json({ error: err.message });
  }
});

// ── Sync data (full) — FIX: now uses sheet.sheet_name as tab name ──
app.get('/api/fms/:id/sync', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [sheets] = await db.query('SELECT * FROM fms_sheets WHERE id=?', [req.params.id]);
    if (!sheets[0]) return res.status(404).json({ error: 'FMS not found' });
    const sheet = sheets[0];
    const headerRowIdx = (sheet.header_row || 1) - 1;
    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
    const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
    // ✅ FIXED: use sheet.sheet_name (actual tab name) instead of hardcoded 'Sheet1'
    const tabName = sheet.sheet_name || 'Sheet1';
    const response = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range: tabName });
    const allRows = response.data.values || [];
    if (allRows.length <= headerRowIdx) {
      return res.status(400).json({ error: `Sheet has only ${allRows.length} rows but header row is set to ${sheet.header_row}` });
    }
    const headers = allRows[headerRowIdx].filter(h => h && h.trim());
    const dataRows = allRows.slice(headerRowIdx + 1);
    // Return ALL data rows
    res.json({ success: true, headers, totalRows: dataRows.length, headerRow: sheet.header_row, sample: dataRows });
  } catch (err) {
    if (err.message?.includes('ENOENT') || err.message?.includes('credentials')) return res.status(500).json({ error: 'credentials.json not found.' });
    if (err.code === 403) return res.status(400).json({ error: 'Access denied. Share sheet with service account.' });
    if (err.code === 404) return res.status(400).json({ error: 'Sheet not found. Check Sheet ID.' });
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// FMS TASKS APIs (all users)
// ══════════════════════════════════════════════════════

// List FMS visible to user
app.get('/api/fms-tasks', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const isAdmin = req.session.role === 'admin';
    let list;
    if (isAdmin) {
      [list] = await db.query('SELECT * FROM fms_sheets ORDER BY created_at DESC');
    } else {
      [list] = await db.query(`SELECT DISTINCT fs.* FROM fms_sheets fs JOIN fms_steps fst ON fst.fms_id=fs.id JOIN fms_step_doers fsd ON fsd.step_id=fst.id WHERE fsd.user_id=? ORDER BY fs.created_at DESC`, [uid]);
    }
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get FMS steps for tasks view
app.get('/api/fms-tasks/:id', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const isAdmin = req.session.role === 'admin';
    const [sheets] = await db.query('SELECT * FROM fms_sheets WHERE id=?', [req.params.id]);
    if (!sheets[0]) return res.status(404).json({ error: 'FMS not found' });
    const [steps] = await db.query('SELECT * FROM fms_steps WHERE fms_id=? ORDER BY step_order ASC', [req.params.id]);
    for (const step of steps) {
      const [doers] = await db.query(`SELECT fsd.user_id,u.name FROM fms_step_doers fsd JOIN users u ON fsd.user_id=u.id WHERE fsd.step_id=?`, [step.id]);
      step.doers = doers;
      step.isMyStep = isAdmin || doers.some(d => d.user_id === uid);
      try { step.show_cols_parsed = JSON.parse(step.show_cols||'[]'); } catch(e) { step.show_cols_parsed = []; }
      const [extraRows] = await db.query('SELECT * FROM fms_extra_rows WHERE step_id=? ORDER BY id ASC', [step.id]);
      step.extraRows = extraRows;
    }
    res.json({ sheet: sheets[0], steps });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get pending rows for a step (plan filled, actual empty)
app.get('/api/fms-tasks/:fmsId/steps/:stepId/rows', requireAuth, async (req, res) => {
  try {
    const [sheets] = await db.query('SELECT * FROM fms_sheets WHERE id=?', [req.params.fmsId]);
    if (!sheets[0]) return res.status(404).json({ error: 'FMS not found' });
    const sheet = sheets[0];
    const [steps] = await db.query('SELECT * FROM fms_steps WHERE id=? AND fms_id=?', [req.params.stepId, req.params.fmsId]);
    if (!steps[0]) return res.status(404).json({ error: 'Step not found' });
    const step = steps[0];

    const planIdx = colToIdx(step.plan_col);
    const actualIdx = colToIdx(step.actual_col);
    let showCols = [];
    try { showCols = JSON.parse(step.show_cols||'[]'); } catch(e) {}

    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
    const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
    const tabName = sheet.sheet_name || 'Sheet1';

    // Optimized: fetch only up to the furthest needed column
    const maxIdx = Math.max(planIdx, actualIdx, ...(showCols.length ? showCols : [0]));
    const lastCol = maxIdx >= 0 ? idxToCol(maxIdx) : 'Z';
    const range = `${tabName}!A:${lastCol}`;

    const response = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range });
    const allRows = response.data.values || [];
    const headerRowIdx = (sheet.header_row || 1) - 1;
    const headers = allRows[headerRowIdx] || [];
    const dataRows = allRows.slice(headerRowIdx + 1);

    const matchedRows = [];
    dataRows.forEach((row, i) => {
      const planVal = planIdx >= 0 ? (row[planIdx]||'').trim() : '';
      const actualVal = actualIdx >= 0 ? (row[actualIdx]||'').trim() : '';
      if (planVal && !actualVal) {
        const rowData = {};
        let colsToShow = showCols.length ? showCols : headers.map((_,hi) => hi);
        // Plan column always show karo — mandatory
        if (planIdx >= 0 && !colsToShow.includes(planIdx)) colsToShow = [planIdx, ...colsToShow];
        colsToShow.forEach(ci => {
          const h = headers[ci] || `COL ${idxToCol(ci)}`;
          rowData[h] = row[ci] || '';
        });
        matchedRows.push({
          sheetRowNumber: headerRowIdx + 1 + i + 1,
          planValue: planVal,
          actualValue: actualVal,
          data: rowData
        });
      }
    });

    res.json({ rows: matchedRows, headers, total: matchedRows.length });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied.' });
    if (err.code === 404) return res.status(400).json({ error: 'Sheet not found.' });
    res.status(500).json({ error: err.message });
  }
});

// Mark row as done — writes actual (date only) + delay reason to sheet
app.post('/api/fms-tasks/:fmsId/steps/:stepId/done', requireAuth, async (req, res) => {
  try {
    const { rowNumber, actualValue, delayReason, extraInputs } = req.body;
    if (!rowNumber || !actualValue) return res.status(400).json({ error: 'rowNumber and actualValue required' });
    // Full timestamp (date + time) save karte hain — user ne explicitly maanga hai
    const dateOnlyValue = actualValue;

    const [sheets] = await db.query('SELECT * FROM fms_sheets WHERE id=?', [req.params.fmsId]);
    if (!sheets[0]) return res.status(404).json({ error: 'FMS not found' });
    const sheet = sheets[0];
    const [steps] = await db.query('SELECT * FROM fms_steps WHERE id=? AND fms_id=?', [req.params.stepId, req.params.fmsId]);
    if (!steps[0]) return res.status(404).json({ error: 'Step not found' });
    const step = steps[0];

    const actualCol = (step.actual_col||'').toUpperCase();
    if (!actualCol) return res.status(400).json({ error: 'Actual column not configured for this step' });

    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);
    const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
    const tabName = sheet.sheet_name || 'Sheet1';

    // ── BATCH WRITE: sab columns ek hi API call mein likhte hain ──
    // Pehle doer name fetch karo (DB call) taaki sheet call sirf ek ho
    let doerName = '';
    if (step.doer_name_col) {
      const [userRows] = await db.query('SELECT name FROM users WHERE id=? LIMIT 1', [req.session.userId]);
      doerName = userRows[0]?.name || '';
    }

    // Sabhi ranges build karo
    const batchData = [];

    // 1. Actual date column (mandatory)
    batchData.push({ range: `${tabName}!${actualCol}${rowNumber}`, values: [[dateOnlyValue]] });

    // 2. Delay reason column (optional)
    if (delayReason && step.delay_reason_col) {
      batchData.push({ range: `${tabName}!${step.delay_reason_col.toUpperCase()}${rowNumber}`, values: [[delayReason]] });
    }

    // 3. Extra input columns (optional)
    if (extraInputs && extraInputs.length) {
      for (const ei of extraInputs) {
        if (ei.colLetter && ei.value !== undefined && ei.value !== '') {
          batchData.push({ range: `${tabName}!${ei.colLetter.toUpperCase()}${rowNumber}`, values: [[ei.value]] });
        }
      }
    }

    // 4. Doer name column (optional)
    if (doerName && step.doer_name_col) {
      batchData.push({ range: `${tabName}!${step.doer_name_col.toUpperCase()}${rowNumber}`, values: [[doerName]] });
    }

    // Single batchUpdate API call — replaces N sequential calls
    const writeResp = await sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: batchData
      }
    });

    const updated = writeResp.data || {};
    console.log('FMS done write →', JSON.stringify({
      spreadsheetId,
      tabName,
      actualCol,
      rowNumber,
      ranges: batchData.map(d => d.range),
      totalUpdatedCells: updated.totalUpdatedCells || 0,
      responses: (updated.responses || []).map(r => r.updatedRange)
    }));

    res.json({
      success: true,
      updatedCells: updated.totalUpdatedCells || 0,
      wroteTo: batchData.map(d => d.range),
      spreadsheetId,
      tabName
    });
  } catch (err) {
    console.error('FMS done write FAILED:', err.code, err.message);
    if (err.code === 403) return res.status(400).json({ error: 'Access denied. Sheet write permission needed.' });
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// TASK TRANSFERS
// ══════════════════════════════════════════════════════

// POST — Create transfer request (user/hod/admin)
app.post('/api/transfers', requireAuth, async (req, res) => {
  try {
    const { tasks, toUserId } = req.body;
    // tasks = [{taskId, taskType}]
    if (!tasks || !tasks.length || !toUserId)
      return res.status(400).json({ error: 'Tasks and target user required' });

    const uid = req.session.userId;
    const role = req.session.role;

    // Validate each task — user can only transfer their own, HOD dept, admin any
    for (const t of tasks) {
      const table = getTable(t.taskType);
      const [rows] = await db.query(`SELECT * FROM ${table} WHERE id=?`, [t.taskId]);
      if (!rows[0]) return res.status(404).json({ error: `Task ${t.taskId} not found` });
      const task = rows[0];

      if (role === 'user' && task.assigned_to !== uid)
        return res.status(403).json({ error: 'You can only transfer your own tasks' });

      if (role === 'hod') {
        const [taskUser] = await db.query('SELECT department FROM users WHERE id=?', [task.assigned_to]);
        const [hodUser] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
        if (taskUser[0]?.department !== hodUser[0]?.department)
          return res.status(403).json({ error: 'HOD can only transfer tasks of their department' });
      }
    }

    // Insert transfer requests — skip if already pending
    let inserted = 0, skipped = 0;
    for (const t of tasks) {
      const table = getTable(t.taskType);
      const [rows] = await db.query(`SELECT assigned_to FROM ${table} WHERE id=?`, [t.taskId]);
      const fromUser = rows[0].assigned_to;
      const [existing] = await db.query(
        `SELECT id FROM task_transfers WHERE task_id=? AND task_type=? AND status='pending'`,
        [t.taskId, t.taskType]
      );
      if (existing[0]) { skipped++; continue; }
      await db.query(
        `INSERT INTO task_transfers (task_id, task_type, from_user, to_user, requested_by, status) VALUES (?,?,?,?,?,'pending')`,
        [t.taskId, t.taskType, fromUser, toUserId, uid]
      );
      inserted++;
    }

    res.json({ success: true, count: inserted, skipped });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET — Task IDs that already have a pending transfer (for current user's tasks)
app.get('/api/transfers/pending-tasks', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT task_id, task_type FROM task_transfers WHERE status='pending' AND requested_by=?`,
      [req.session.userId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET — Pending transfers for approval (admin sees all, HOD sees dept)
app.get('/api/transfers', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.role;
    let deptFilter = '';
    let params = [];

    if (role === 'hod') {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      const dept = me[0]?.department || '';
      // HOD sees transfers of users in their department
      const [deptUsers] = await db.query('SELECT id FROM users WHERE department=?', [dept]);
      if (!deptUsers.length) return res.json([]);
      const ids = deptUsers.map(u=>u.id);
      deptFilter = `AND (tt.from_user IN (${ids.map(()=>'?').join(',')}) OR tt.to_user IN (${ids.map(()=>'?').join(',')}))`;
      params = [...ids, ...ids];
    }

    const [rows] = await db.query(`
      SELECT tt.*,
        uf.name AS fromUserName, ut.name AS toUserName,
        ur.name AS requestedByName,
        u_from.department AS fromDept
      FROM task_transfers tt
      JOIN users uf ON tt.from_user = uf.id
      JOIN users ut ON tt.to_user = ut.id
      JOIN users ur ON tt.requested_by = ur.id
      JOIN users u_from ON tt.from_user = u_from.id
      WHERE tt.status = 'pending' ${deptFilter}
      ORDER BY tt.created_at DESC`, params);

    // Attach task description
    for (const r of rows) {
      const table = getTable(r.task_type);
      const [t] = await db.query(`SELECT description, DATE_FORMAT(due_date,'%Y-%m-%d') AS due_date FROM ${table} WHERE id=?`, [r.task_id]);
      r.description = t[0]?.description || '—';
      r.due_date = t[0]?.due_date || '—';
    }

    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET — Transfer count for badge
app.get('/api/transfers/count', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.role;
    let count = 0;
    if (role === 'admin') {
      const [r] = await db.query(`SELECT COUNT(*) AS c FROM task_transfers WHERE status='pending'`);
      count = r[0].c;
    } else {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      const dept = me[0]?.department || '';
      const [deptUsers] = await db.query('SELECT id FROM users WHERE department=?', [dept]);
      if (deptUsers.length) {
        const ids = deptUsers.map(u=>u.id);
        const [r] = await db.query(`SELECT COUNT(*) AS c FROM task_transfers WHERE status='pending' AND (from_user IN (${ids.map(()=>'?').join(',')}) OR to_user IN (${ids.map(()=>'?').join(',')}))`, [...ids,...ids]);
        count = r[0].c;
      }
    }
    res.json({ count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT — Approve or reject transfer
app.put('/api/transfers/:id', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { action, note } = req.body; // action: 'approved' | 'rejected'
    const [rows] = await db.query('SELECT * FROM task_transfers WHERE id=?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Transfer not found' });
    const tr = rows[0];

    await db.query('UPDATE task_transfers SET status=?, note=? WHERE id=?', [action, note||'', req.params.id]);

    if (action === 'approved') {
      const table = getTable(tr.task_type);
      await db.query(`UPDATE ${table} SET assigned_to=? WHERE id=?`, [tr.to_user, tr.task_id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET — My sent transfer requests (for users to track)
app.get('/api/transfers/my', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT tt.*, uf.name AS fromUserName, ut.name AS toUserName
      FROM task_transfers tt
      JOIN users uf ON tt.from_user = uf.id
      JOIN users ut ON tt.to_user = ut.id
      WHERE tt.requested_by=?
      ORDER BY tt.created_at DESC LIMIT 20`, [req.session.userId]);
    for (const r of rows) {
      const table = getTable(r.task_type);
      const [t] = await db.query(`SELECT description FROM ${table} WHERE id=?`, [r.task_id]);
      r.description = t[0]?.description || '—';
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// WEEK PLAN
// ══════════════════════════════════════════════════════
app.post('/api/week-plan', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { employeeId, startDate, targetCount, hodId, improvementPct } = req.body;
    if (!employeeId || !startDate) {
      return res.status(400).json({ error: 'employeeId and startDate required' });
    }
    const impPct = (improvementPct !== undefined && improvementPct !== null && improvementPct !== '') ? parseInt(improvementPct) : null;
    const tCount = (targetCount !== undefined && targetCount !== null && targetCount !== '') ? parseInt(targetCount) : 0;
    const finalHodId = hodId || req.session.userId;
    // Upsert: insert ya update if same employee+startDate exists.
    // IMPORTANT: created_at sirf insert pe set hota hai (DEFAULT CURRENT_TIMESTAMP); update pe preserve rehta hai.
    // updated_at auto-update hota hai schema ki vajah se (ON UPDATE CURRENT_TIMESTAMP).
    const [result] = await db.execute(
      `INSERT INTO week_plans (employee_id, hod_id, start_date, target_count, improvement_pct)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE target_count = VALUES(target_count), hod_id = VALUES(hod_id), improvement_pct = VALUES(improvement_pct)`,
      [employeeId, finalHodId, startDate, tCount, impPct]
    );
    // affectedRows: 1 = inserted, 2 = updated existing row
    const action = result.affectedRows === 1 ? 'INSERTED' : 'UPDATED';
    console.log(`  📅 Week Plan ${action}: employee=${employeeId}, week=${startDate}, improvement_pct=${impPct}, by_hod=${finalHodId}`);
    res.json({ success: true, action: action.toLowerCase() });
  } catch (e) {
    // If table doesn't exist (shouldn't happen post-migration, but safety net), create it + retry
    if (e.code === 'ER_NO_SUCH_TABLE') {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS week_plans (
          id INT AUTO_INCREMENT PRIMARY KEY,
          employee_id INT NOT NULL,
          hod_id INT NOT NULL,
          start_date DATE NOT NULL,
          target_count INT DEFAULT 0,
          improvement_pct INT DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_emp_week (employee_id, start_date),
          INDEX idx_start_date (start_date),
          INDEX idx_employee (employee_id)
        )
      `);
      const { employeeId, startDate, targetCount, hodId, improvementPct } = req.body;
      const impPct = (improvementPct !== undefined && improvementPct !== null && improvementPct !== '') ? parseInt(improvementPct) : null;
      const tCount = (targetCount !== undefined && targetCount !== null && targetCount !== '') ? parseInt(targetCount) : 0;
      await db.execute(
        `INSERT INTO week_plans (employee_id, hod_id, start_date, target_count, improvement_pct)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE target_count = VALUES(target_count), hod_id = VALUES(hod_id), improvement_pct = VALUES(improvement_pct)`,
        [employeeId, hodId || req.session.userId, startDate, tCount, impPct]
      );
      console.log(`  📅 Week Plan saved (after table create): employee=${employeeId}, week=${startDate}`);
      return res.json({ success: true });
    }
    // If improvement_pct column missing (old table), add it then retry
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      try {
        await db.execute(`ALTER TABLE week_plans ADD COLUMN improvement_pct INT DEFAULT NULL`);
      } catch(ae) { /* already exists */ }
      try {
        await db.execute(`ALTER TABLE week_plans ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at`);
      } catch(ae) { /* already exists */ }
      const { employeeId, startDate, targetCount, hodId, improvementPct } = req.body;
      const impPct = (improvementPct !== undefined && improvementPct !== null && improvementPct !== '') ? parseInt(improvementPct) : null;
      const tCount = (targetCount !== undefined && targetCount !== null && targetCount !== '') ? parseInt(targetCount) : 0;
      await db.execute(
        `INSERT INTO week_plans (employee_id, hod_id, start_date, target_count, improvement_pct)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE target_count = VALUES(target_count), hod_id = VALUES(hod_id), improvement_pct = VALUES(improvement_pct)`,
        [employeeId, hodId || req.session.userId, startDate, tCount, impPct]
      );
      console.log(`  📅 Week Plan saved (after column add): employee=${employeeId}, week=${startDate}`);
      return res.json({ success: true });
    }
    console.error('  ❌ Week Plan save failed:', e);
    res.status(500).json({ error: 'Failed to save plan' });
  }
});

// GET week-plan list — supports filters for Reports tab (next update)
// Query params (all optional):
//   ?employeeId=123      → specific employee ka history
//   ?from=YYYY-MM-DD     → start_date >= from
//   ?to=YYYY-MM-DD       → start_date <= to
//   ?limit=N             → default 500 (Reports tab ke liye sufficient; pagination future)
app.get('/api/week-plan', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { employeeId, from, to } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
    const where = [];
    const params = [];
    if (employeeId) { where.push('wp.employee_id = ?'); params.push(parseInt(employeeId)); }
    if (from) { where.push('wp.start_date >= ?'); params.push(from); }
    if (to)   { where.push('wp.start_date <= ?'); params.push(to); }
    // HOD ko apne dept ke users hi dikhne chahiye (admin sab dekh sakta hai)
    // JWT me department nahi hai, isliye fresh DB se fetch karna padta hai
    if (req.session.role === 'hod') {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [req.session.userId]);
      where.push('u.department = ?');
      params.push((me[0] && me[0].department) || '');
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rows] = await db.execute(
      `SELECT wp.id, wp.employee_id, wp.hod_id, 
              DATE_FORMAT(wp.start_date,'%Y-%m-%d') AS start_date,
              wp.target_count, wp.improvement_pct,
              wp.created_at, wp.updated_at,
              u.name AS employee_name, u.department AS employee_department,
              h.name AS hod_name
       FROM week_plans wp
       JOIN users u ON u.id = wp.employee_id
       LEFT JOIN users h ON h.id = wp.hod_id
       ${whereSql}
       ORDER BY wp.start_date DESC, wp.employee_id ASC
       LIMIT ${limit}`,
      params
    );
    res.json(rows);
  } catch (e) {
    console.error('  ❌ Week Plan fetch failed:', e.message);
    res.status(500).json([]);
  }
});

// GET history endpoint — Reports tab ke liye dedicated:
//   /api/week-plan/history/:employeeId
// Returns sare weeks (newest first) for a single employee, with HOD name aur timestamps.
app.get('/api/week-plan/history/:employeeId', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const empId = parseInt(req.params.employeeId);
    if (!empId) return res.status(400).json({ error: 'Invalid employeeId' });
    // HOD sirf apne dept ke user ka history dekh sake
    if (req.session.role === 'hod') {
      const [me]  = await db.query('SELECT department FROM users WHERE id=?', [req.session.userId]);
      const [chk] = await db.execute('SELECT department FROM users WHERE id=?', [empId]);
      const myDept = (me[0] && me[0].department) || '';
      if (!chk.length || chk[0].department !== myDept) {
        return res.status(403).json({ error: 'Not allowed' });
      }
    }
    const [rows] = await db.execute(
      `SELECT wp.id,
              DATE_FORMAT(wp.start_date,'%Y-%m-%d') AS start_date,
              wp.target_count, wp.improvement_pct,
              wp.created_at, wp.updated_at,
              h.name AS hod_name
       FROM week_plans wp
       LEFT JOIN users h ON h.id = wp.hod_id
       WHERE wp.employee_id = ?
       ORDER BY wp.start_date DESC`,
      [empId]
    );
    const [emp] = await db.execute('SELECT id, name, department FROM users WHERE id=?', [empId]);
    res.json({
      employee: emp[0] || null,
      plans: rows,
      total: rows.length
    });
  } catch (e) {
    console.error('  ❌ Week Plan history fetch failed:', e.message);
    res.status(500).json({ error: 'Failed to fetch history', plans: [] });
  }
});

// ══════════════════════════════════════════════════════
// LEAVE TRACKER  (apply / approve / list / delete)
// Data Google Sheet ke "leave_tracker" tab me store hota hai.
// type: full_day | half_day | wfh | extra_working
// status: pending | approved | rejected
// ──────────────────────────────────────────────────────

// List leaves. Admin: sabki (filter ?employee= & ?status=). Baaki: sirf apni.
app.get('/api/leaves', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.session.role === 'admin';
    const uid = req.session.userId;
    const { employee, status } = req.query;
    const where = [];
    const params = [];
    if (!isAdmin) { where.push('l.user_id = ?'); params.push(uid); }
    else if (employee && employee !== 'all') { where.push('l.user_id = ?'); params.push(parseInt(employee)); }
    if (status && status !== 'all') { where.push('l.status = ?'); params.push(status); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rows] = await db.query(`
      SELECT l.id, l.user_id, l.type, l.reason,
             DATE_FORMAT(l.start_date,'%Y-%m-%d') AS start_date,
             DATE_FORMAT(l.end_date,'%Y-%m-%d') AS end_date,
             l.hours, l.status, l.applied_at, l.decided_by, l.decided_at, l.decision_note,
             u.name AS user_name, u.department AS department,
             d.name AS decided_by_name
      FROM leave_tracker l
      JOIN users u ON l.user_id = u.id
      LEFT JOIN users d ON l.decided_by = d.id
      ${whereSql}
      ORDER BY l.applied_at DESC, l.id DESC`, params);
    // "Your approver" = pehla admin
    const [admins] = await db.query("SELECT name FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1");
    const approverName = (admins[0] && admins[0].name) || 'Admin';
    res.json({ leaves: rows, approverName, isAdmin });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Apply for leave (koi bhi logged-in user apne liye)
app.post('/api/leaves', requireAuth, async (req, res) => {
  try {
    const { type, reason, startDate, endDate, hours } = req.body;
    const validTypes = ['full_day','half_day','wfh','extra_working'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid leave type' });
    if (!startDate) return res.status(400).json({ error: 'Start date required' });
    // half_day aur extra_working single-date hote hain; baaki me end_date optional (default start).
    const end = (type === 'half_day' || type === 'extra_working') ? startDate : (endDate || startDate);
    const hrs = type === 'extra_working' ? (parseInt(hours) || 0) : '';
    if (type === 'extra_working' && !hrs) return res.status(400).json({ error: 'Hours required for extra working' });
    await db.query(
      `INSERT INTO leave_tracker (user_id,type,reason,start_date,end_date,hours,status) VALUES (?,?,?,?,?,?,?)`,
      [req.session.userId, type, reason||'', startDate, end, String(hrs), 'pending']
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Approve / Reject — SIRF Admin
app.put('/api/leaves/:id/decision', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { decision, note } = req.body;
    if (!['approved','rejected'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });
    const [r] = await db.query(`SELECT id FROM leave_tracker WHERE id=?`, [req.params.id]);
    if (!r[0]) return res.status(404).json({ error: 'Leave not found' });
    const nowTs = new Date().toISOString().slice(0,19).replace('T',' ');
    await db.query(
      `UPDATE leave_tracker SET status=?, decided_by=?, decided_at=?, decision_note=? WHERE id=?`,
      [decision, req.session.userId, nowTs, note||'', req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete — owner apni ya admin koi bhi
app.delete('/api/leaves/:id', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.session.role === 'admin';
    const [r] = await db.query(`SELECT user_id FROM leave_tracker WHERE id=?`, [req.params.id]);
    if (!r[0]) return res.status(404).json({ error: 'Leave not found' });
    if (!isAdmin && r[0].user_id !== req.session.userId) return res.status(403).json({ error: 'Not allowed' });
    await db.query(`DELETE FROM leave_tracker WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// ADMIN: Clear ALL delegation + checklist tasks (data wipe)
// ──────────────────────────────────────────────────────
// IMPORTANT: Manual Google-Sheet editing se data wapas aa jaata hai (app apni
// in-memory copy ko sheet me overwrite kar deta hai). Isliye clearing app ke
// through hi karni chahiye — tab serving instance ki memory bhi clear hoti hai
// aur flush khaali sheet likhta hai. Admin-only + typed confirmation zaroori.
app.post('/api/admin/clear-tasks', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { confirm, scope } = req.body || {};
    if (confirm !== 'DELETE ALL') return res.status(400).json({ error: 'Type "DELETE ALL" to confirm' });
    const result = {};
    if (!scope || scope === 'both' || scope === 'delegation') {
      const [d] = await db.query('SELECT COUNT(*) AS c FROM delegation_tasks');
      await db.query('DELETE FROM delegation_tasks');
      result.delegationDeleted = d[0].c;
    }
    if (!scope || scope === 'both' || scope === 'checklist') {
      const [c] = await db.query('SELECT COUNT(*) AS c FROM checklist_tasks');
      await db.query('DELETE FROM checklist_tasks');
      result.checklistDeleted = c[0].c;
    }
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// DEBUG ENDPOINT (remove after fixing)
// ══════════════════════════════════════════════════════
app.get('/api/debug', requireAuth, requireAdmin, async (req, res) => {
  const result = { time: new Date().toISOString(), env: {}, db: {}, tables: {} };
  result.env = {
    NODE_ENV: process.env.NODE_ENV || '(not set)',
    DB_HOST: process.env.DB_HOST || 'localhost (default)',
    DB_USER: process.env.DB_USER || 'root (default)',
    DB_NAME: process.env.DB_NAME || 'task_manager (default)',
    PORT: process.env.PORT || '3000 (default)',
  };
  try {
    await db.query('SELECT 1');
    result.db.connected = true;
    const counts = ['users','delegation_tasks','checklist_tasks','fms_sheets'];
    for (const t of counts) {
      try {
        const [[row]] = await db.query(`SELECT COUNT(*) AS c FROM ${t}`);
        result.tables[t] = row.c;
      } catch(e) { result.tables[t] = 'ERROR: ' + e.message; }
    }
    // Show users with their roles and departments
    try {
      const [users] = await db.query('SELECT id, name, role, department FROM users ORDER BY role, name');
      result.users = users;
    } catch(e) { result.users = 'ERROR: ' + e.message; }
  } catch(e) {
    result.db.connected = false;
    result.db.error = e.message;
  }
  res.json(result);
});

// ══════════════════════════════════════════════════════
// PAGES
// ══════════════════════════════════════════════════════
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// Auth check is handled client-side via /api/me in init() — removing server-side
// requireAuth here prevents app.html from loading if cookie has any timing/domain issue
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

// On Vercel/serverless we export the app and let the platform invoke it
// as a request handler — calling app.listen() there would crash the function.
if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
  module.exports = app;
} else {
  _dbReady.finally(() => app.listen(PORT, () => {
    console.log(`\n  ✦ Task Manager: http://localhost:${PORT}`);
    console.log(`  Login: admin@admin.com / admin\n`);
  }));
  module.exports = app;
}