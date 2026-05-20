const pool = require('./db');
const { userMessage } = require('./errors');

// ── Timezone helpers ───────────────────────────────────────────────────────────

// Returns the configured IANA timezone from app_settings (falls back to 'UTC')
async function getTimezone() {
  try {
    const r = await pool.query("SELECT value FROM app_settings WHERE key = 'timezone'");
    return r.rows.length > 0 ? r.rows[0].value : 'UTC';
  } catch {
    return 'UTC';
  }
}

// Returns 'YYYY-MM-DD' for the current date in the given IANA timezone
function localDateStr(tz, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date);
}

// Returns 'YYYY-MM-DD' for the Sunday starting this week in the given IANA timezone
function localWeekStart(tz, date = new Date()) {
  const s = localDateStr(tz, date);
  const [y, m, d] = s.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sun
  return new Date(Date.UTC(y, m - 1, d - dow)).toISOString().slice(0, 10);
}

// Returns day-of-week (0=Sun … 6=Sat) for the current date in the given IANA timezone
function localDayOfWeek(tz, date = new Date()) {
  const s = localDateStr(tz, date);
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// ── Legacy UTC helpers (kept for callers that still use them directly) ─────────

function getWeekStart(date = new Date()) {
  const d = new Date(date);
  const dayOfWeek = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - dayOfWeek);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function getPrevWeekStart(date = new Date()) {
  const ws = getWeekStart(date);
  ws.setUTCDate(ws.getUTCDate() - 7);
  return ws;
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

// ── Week settings ──────────────────────────────────────────────────────────────

// weekStartStr: 'YYYY-MM-DD'
async function getWeeklySettings(weekStartStr) {
  const result = await pool.query(
    `SELECT * FROM weekly_settings
     WHERE effective_week_start <= $1
     ORDER BY effective_week_start DESC
     LIMIT 1`,
    [weekStartStr]
  );
  return result.rows[0] || { required_mandatory_count: 0, allowance_minutes: 60 };
}

// weekStartStr: 'YYYY-MM-DD'
async function getMandatoryChoresForWeek(weekStartStr) {
  const specific = await pool.query(
    'SELECT chore_id FROM weekly_mandatory_chores WHERE week_start = $1',
    [weekStartStr]
  );
  if (specific.rows.length > 0) {
    return specific.rows.map((r) => r.chore_id);
  }

  // Inherit from previous week (subtract 7 days from the string date)
  const prevDate = new Date(weekStartStr + 'T12:00:00Z');
  prevDate.setUTCDate(prevDate.getUTCDate() - 7);
  const prevWeekStartStr = prevDate.toISOString().slice(0, 10);

  const prev = await pool.query(
    'SELECT chore_id FROM weekly_mandatory_chores WHERE week_start = $1',
    [prevWeekStartStr]
  );
  if (prev.rows.length > 0) {
    const ids = prev.rows.map((r) => r.chore_id);
    for (const choreId of ids) {
      await pool.query(
        'INSERT INTO weekly_mandatory_chores (week_start, chore_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [weekStartStr, choreId]
      );
    }
    return ids;
  }

  return [];
}

// ── Weekly housekeeping ────────────────────────────────────────────────────────

async function processWeeklyUpdates(userId) {
  const tz = await getTimezone();
  const now = new Date();
  const currentWeekStartStr = localWeekStart(tz, now);

  // ── 1. Sunday allowance ──────────────────────────────────────────────────────
  if (localDayOfWeek(tz, now) === 0) {
    const alreadyPaid = await pool.query(
      'SELECT id FROM weekly_allowances WHERE user_id = $1 AND week_start = $2',
      [userId, currentWeekStartStr]
    );
    if (alreadyPaid.rows.length === 0) {
      const settings = await getWeeklySettings(currentWeekStartStr);
      const amount = settings.allowance_minutes;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'INSERT INTO weekly_allowances (user_id, week_start, amount_minutes) VALUES ($1, $2, $3)',
          [userId, currentWeekStartStr, amount]
        );
        await client.query(
          'UPDATE users SET time_balance_minutes = time_balance_minutes + $1 WHERE id = $2',
          [amount, userId]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        e.message = `Failed to pay weekly allowance: ${userMessage(e)}`;
        throw e;
      } finally {
        client.release();
      }
    }
  }

  // ── 2. Evaluate previous week, set current-week spending block ────────────────
  const existing = await pool.query(
    'SELECT spending_blocked, admin_override FROM weekly_user_status WHERE user_id = $1 AND week_start = $2',
    [userId, currentWeekStartStr]
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    return { spendingBlocked: row.spending_blocked && !row.admin_override };
  }

  // Not yet evaluated — check previous week
  const prevDate = new Date(currentWeekStartStr + 'T12:00:00Z');
  prevDate.setUTCDate(prevDate.getUTCDate() - 7);
  const prevWeekStartStr = prevDate.toISOString().slice(0, 10);

  const mandatoryIds = await getMandatoryChoresForWeek(prevWeekStartStr);
  const settings = await getWeeklySettings(prevWeekStartStr);
  const required =
    settings.required_mandatory_count === 0
      ? mandatoryIds.length
      : settings.required_mandatory_count;

  let mandatoryMet = true;
  let spendingBlocked = false;

  if (mandatoryIds.length > 0 && required > 0) {
    const completed = await pool.query(
      `SELECT COUNT(*) AS count FROM chore_completions
       WHERE user_id = $1
         AND week_start = $2
         AND chore_id = ANY($3)
         AND status IN ('approved', 'auto_approved')`,
      [userId, prevWeekStartStr, mandatoryIds]
    );
    const completedCount = parseInt(completed.rows[0].count, 10);
    mandatoryMet = completedCount >= required;
    spendingBlocked = !mandatoryMet;
  }

  await pool.query(
    `INSERT INTO weekly_user_status
       (user_id, week_start, mandatory_chores_met, spending_blocked, evaluated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id, week_start) DO NOTHING`,
    [userId, currentWeekStartStr, mandatoryMet, spendingBlocked]
  );

  return { spendingBlocked };
}

module.exports = {
  getWeekStart,
  getPrevWeekStart,
  formatDate,
  getWeeklySettings,
  getMandatoryChoresForWeek,
  processWeeklyUpdates,
  getTimezone,
  localDateStr,
  localWeekStart,
  localDayOfWeek,
};
