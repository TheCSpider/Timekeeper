'use strict';

const nodemailer = require('nodemailer');
const pool = require('./db');
const { getTimezone, localDateStr, localWeekStart } = require('./weekly');

// ── Settings helpers ───────────────────────────────────────────────────────────

async function getReportEmail() {
  const r = await pool.query("SELECT value FROM app_settings WHERE key = 'report_email'");
  return r.rows.length > 0 ? r.rows[0].value.trim() : null;
}

// ── Date range data fetching ───────────────────────────────────────────────────

// Fetches all activity for non-admin users in [startDateStr, endDateStr]
// (YYYY-MM-DD inclusive, dates interpreted in `tz`)
async function fetchReportData(startDateStr, endDateStr, tz) {
  const [users, chores, awards, allowances, sessions] = await Promise.all([
    pool.query(
      "SELECT id, username FROM users WHERE role = 'user' ORDER BY username"
    ),

    pool.query(
      `SELECT cc.user_id, c.name AS chore_name, cc.time_earned_minutes
       FROM chore_completions cc
       JOIN chores c ON c.id = cc.chore_id
       WHERE cc.status IN ('approved', 'auto_approved')
         AND DATE(cc.submitted_at AT TIME ZONE $3) >= $1
         AND DATE(cc.submitted_at AT TIME ZONE $3) <= $2
       ORDER BY cc.user_id, cc.submitted_at`,
      [startDateStr, endDateStr, tz]
    ),

    pool.query(
      `SELECT user_id, amount_minutes, reason
       FROM time_awards
       WHERE DATE(awarded_at AT TIME ZONE $3) >= $1
         AND DATE(awarded_at AT TIME ZONE $3) <= $2
       ORDER BY user_id, awarded_at`,
      [startDateStr, endDateStr, tz]
    ),

    pool.query(
      `SELECT user_id, amount_minutes
       FROM weekly_allowances
       WHERE DATE(paid_at AT TIME ZONE $3) >= $1
         AND DATE(paid_at AT TIME ZONE $3) <= $2
       ORDER BY user_id`,
      [startDateStr, endDateStr, tz]
    ),

    pool.query(
      `SELECT user_id, FLOOR(duration_minutes)::INTEGER AS minutes_used
       FROM time_sessions
       WHERE status = 'completed'
         AND DATE(end_time AT TIME ZONE $3) >= $1
         AND DATE(end_time AT TIME ZONE $3) <= $2
       ORDER BY user_id, end_time`,
      [startDateStr, endDateStr, tz]
    ),
  ]);

  return {
    users: users.rows,
    chores: chores.rows,
    awards: awards.rows,
    allowances: allowances.rows,
    sessions: sessions.rows,
  };
}

// ── Per-user summary ───────────────────────────────────────────────────────────

function buildUserSummary(userId, data) {
  const userChores      = data.chores.filter((r) => r.user_id === userId);
  const userAwards      = data.awards.filter((r) => r.user_id === userId);
  const userAllowances  = data.allowances.filter((r) => r.user_id === userId);
  const userSessions    = data.sessions.filter((r) => r.user_id === userId);

  const positiveAwards  = userAwards.filter((r) => r.amount_minutes > 0);
  const negativeAwards  = userAwards.filter((r) => r.amount_minutes < 0);

  const choreGained     = userChores.reduce((s, r) => s + r.time_earned_minutes, 0);
  const allowanceGained = userAllowances.reduce((s, r) => s + r.amount_minutes, 0);
  const awardGained     = positiveAwards.reduce((s, r) => s + r.amount_minutes, 0);
  const awardDeducted   = Math.abs(negativeAwards.reduce((s, r) => s + r.amount_minutes, 0));
  const sessionSpent    = userSessions.reduce((s, r) => s + r.minutes_used, 0);

  const totalGained = choreGained + allowanceGained + awardGained;
  const totalSpent  = sessionSpent + awardDeducted;

  return {
    chores: userChores,
    allowances: userAllowances,
    positiveAwards,
    negativeAwards,
    sessions: userSessions,
    choreGained,
    allowanceGained,
    awardGained,
    awardDeducted,
    sessionSpent,
    totalGained,
    totalSpent,
    net: totalGained - totalSpent,
  };
}

// ── Formatting helpers ─────────────────────────────────────────────────────────

function fmtMins(m) {
  const total = Math.max(0, Math.round(m));
  const h = Math.floor(total / 60);
  const rem = total % 60;
  return h > 0 ? `${h}h ${rem}m` : `${rem}m`;
}

function signed(m) {
  return m >= 0 ? `+${fmtMins(m)}` : `−${fmtMins(Math.abs(m))}`;
}

// ── HTML email generation ──────────────────────────────────────────────────────

const COLORS = {
  bg:        '#f4f6f8',
  card:      '#ffffff',
  header:    '#1a1a2e',
  accent:    '#4f8ef7',
  green:     '#22c55e',
  red:       '#ef4444',
  muted:     '#6b7280',
  border:    '#e5e7eb',
  rowAlt:    '#f9fafb',
};

function td(content, style = '') {
  return `<td style="padding:6px 10px;font-size:13px;${style}">${content}</td>`;
}

function sectionTable(rows, emptyMsg) {
  if (rows.length === 0) {
    return `<p style="margin:4px 0 8px;font-size:13px;color:${COLORS.muted};">${emptyMsg}</p>`;
  }
  const rowsHtml = rows.map((cols, i) => {
    const bg = i % 2 === 0 ? '' : `background:${COLORS.rowAlt};`;
    return `<tr style="${bg}">${cols.join('')}</tr>`;
  }).join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:12px;">${rowsHtml}</table>`;
}

function userBlock(username, summary) {
  const netColor = summary.net >= 0 ? COLORS.green : COLORS.red;

  // Chore rows
  const choreRows = summary.chores.map((c) => [
    td(c.chore_name),
    td(`+${fmtMins(c.time_earned_minutes)}`, `color:${COLORS.green};text-align:right;`),
  ]);

  // Allowance rows
  const allowanceRows = summary.allowances.map((a) => [
    td('Weekly allowance'),
    td(`+${fmtMins(a.amount_minutes)}`, `color:${COLORS.green};text-align:right;`),
  ]);

  // Positive award rows
  const posAwardRows = summary.positiveAwards.map((a) => [
    td(a.reason ? `Award: ${a.reason}` : 'Admin award'),
    td(`+${fmtMins(a.amount_minutes)}`, `color:${COLORS.green};text-align:right;`),
  ]);

  // Session rows
  const sessionRows = summary.sessions.map((s) => [
    td('Screen time used'),
    td(`−${fmtMins(s.minutes_used)}`, `color:${COLORS.red};text-align:right;`),
  ]);

  // Negative award rows
  const negAwardRows = summary.negativeAwards.map((a) => [
    td(a.reason ? `Deduction: ${a.reason}` : 'Admin deduction'),
    td(`−${fmtMins(Math.abs(a.amount_minutes))}`, `color:${COLORS.red};text-align:right;`),
  ]);

  const allRows = [...choreRows, ...allowanceRows, ...posAwardRows, ...sessionRows, ...negAwardRows];
  const hasActivity = allRows.length > 0;

  return `
  <div style="background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:8px;margin-bottom:20px;overflow:hidden;">
    <div style="background:${COLORS.header};padding:10px 16px;display:flex;justify-content:space-between;align-items:center;">
      <span style="color:#fff;font-size:15px;font-weight:600;">${username}</span>
      <span style="color:${netColor};font-size:15px;font-weight:700;margin-left:auto;">${signed(summary.net)}</span>
    </div>
    <div style="padding:14px 16px;">
      ${hasActivity
        ? sectionTable(allRows, '')
        : `<p style="margin:0;font-size:13px;color:${COLORS.muted};">No activity this period.</p>`}
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-top:2px solid ${COLORS.border};margin-top:4px;padding-top:8px;">
        <tr>
          <td style="padding:6px 10px 2px;font-size:12px;color:${COLORS.muted};">Gained</td>
          <td style="padding:6px 10px 2px;font-size:12px;color:${COLORS.muted};text-align:right;">Spent</td>
          <td style="padding:6px 10px 2px;font-size:12px;color:${COLORS.muted};text-align:right;">Net</td>
        </tr>
        <tr>
          <td style="padding:2px 10px 6px;font-size:14px;font-weight:600;color:${COLORS.green};">+${fmtMins(summary.totalGained)}</td>
          <td style="padding:2px 10px 6px;font-size:14px;font-weight:600;color:${COLORS.red};text-align:right;">−${fmtMins(summary.totalSpent)}</td>
          <td style="padding:2px 10px 6px;font-size:14px;font-weight:700;color:${netColor};text-align:right;">${signed(summary.net)}</td>
        </tr>
      </table>
    </div>
  </div>`;
}

function generateEmailHtml(title, period, userRows) {
  const userBlocksHtml = userRows.map((u) => userBlock(u.username, u.summary)).join('');

  const totalGained = userRows.reduce((s, u) => s + u.summary.totalGained, 0);
  const totalSpent  = userRows.reduce((s, u) => s + u.summary.totalSpent,  0);

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${title}</title></head>
<body style="margin:0;padding:0;background:${COLORS.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bg};padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr><td style="background:${COLORS.header};border-radius:8px 8px 0 0;padding:24px 28px;">
          <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;">⏱ Timekeeper</h1>
          <p style="margin:4px 0 0;color:rgba(255,255,255,.65);font-size:14px;">${title} &nbsp;·&nbsp; ${period}</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:${COLORS.bg};padding:24px 4px;">
          ${userBlocksHtml}

          <!-- Totals footer -->
          <div style="background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:8px;padding:14px 20px;">
            <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:${COLORS.muted};text-transform:uppercase;letter-spacing:.05em;">All Users Combined</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              <tr>
                <td style="font-size:14px;font-weight:600;color:${COLORS.green};">+${fmtMins(totalGained)} gained</td>
                <td style="font-size:14px;font-weight:600;color:${COLORS.red};text-align:center;">−${fmtMins(totalSpent)} spent</td>
                <td style="font-size:14px;font-weight:700;color:${COLORS.accent};text-align:right;">${signed(totalGained - totalSpent)} net</td>
              </tr>
            </table>
          </div>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:16px 4px 4px;text-align:center;">
          <p style="margin:0;font-size:11px;color:${COLORS.muted};">Sent by Timekeeper &nbsp;·&nbsp; ${new Date().toUTCString()}</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Email delivery ─────────────────────────────────────────────────────────────

async function sendReport(subject, html) {
  const to = await getReportEmail();
  if (!to) {
    console.log('⚠️  report_email not configured in app_settings — skipping send');
    return;
  }

  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log('⚠️  SMTP env vars not set — skipping email report');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: SMTP_SECURE === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from: SMTP_FROM || SMTP_USER,
    to,
    subject,
    html,
  });

  console.log(`📧 Report sent: "${subject}" → ${to}`);
}

// ── Public report generators ───────────────────────────────────────────────────

async function generateWeeklyReport() {
  try {
    const tz = await getTimezone();
    const now = new Date();

    // This run fires on Sunday 00:00 in tz, so today IS the new week start.
    // Previous week = [currentWeekStart - 7, currentWeekStart - 1]
    const currentWeekStart = localWeekStart(tz, now);

    const prevStartDate = new Date(currentWeekStart + 'T12:00:00Z');
    prevStartDate.setUTCDate(prevStartDate.getUTCDate() - 7);
    const prevWeekStart = prevStartDate.toISOString().slice(0, 10);

    const prevEndDate = new Date(currentWeekStart + 'T12:00:00Z');
    prevEndDate.setUTCDate(prevEndDate.getUTCDate() - 1);
    const prevWeekEnd = prevEndDate.toISOString().slice(0, 10);

    const data = await fetchReportData(prevWeekStart, prevWeekEnd, tz);
    const userRows = data.users.map((u) => ({
      username: u.username,
      summary: buildUserSummary(u.id, data),
    }));

    const html = generateEmailHtml(
      'Weekly Summary',
      `${prevWeekStart} – ${prevWeekEnd}`,
      userRows
    );

    await sendReport(`Timekeeper Weekly Report — ${prevWeekStart}`, html);
  } catch (err) {
    console.error('Error generating weekly report:', err.message);
  }
}

async function generateMonthlyReport() {
  try {
    const tz = await getTimezone();
    const now = new Date();

    // This run fires on the 1st of the month 00:00 in tz.
    // Previous month = first day of prev month through yesterday.
    const todayStr = localDateStr(tz, now);
    const [y, m] = todayStr.split('-').map(Number);

    const prevM = m === 1 ? 12 : m - 1;
    const prevY = m === 1 ? y - 1 : y;
    const prevMonthStart = `${prevY}-${String(prevM).padStart(2, '0')}-01`;

    const prevMonthEndDate = new Date(todayStr + 'T12:00:00Z');
    prevMonthEndDate.setUTCDate(prevMonthEndDate.getUTCDate() - 1);
    const prevMonthEnd = prevMonthEndDate.toISOString().slice(0, 10);

    const monthName = new Date(prevY, prevM - 1, 1).toLocaleString('en-US', {
      month: 'long',
      year: 'numeric',
    });

    const data = await fetchReportData(prevMonthStart, prevMonthEnd, tz);
    const userRows = data.users.map((u) => ({
      username: u.username,
      summary: buildUserSummary(u.id, data),
    }));

    const html = generateEmailHtml('Monthly Summary', monthName, userRows);
    await sendReport(`Timekeeper Monthly Report — ${monthName}`, html);
  } catch (err) {
    console.error('Error generating monthly report:', err.message);
  }
}

module.exports = { generateWeeklyReport, generateMonthlyReport };
