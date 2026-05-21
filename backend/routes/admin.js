const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { sendError } = require('../errors');
const {
  getMandatoryChoresForWeek,
  getWeeklySettings,
  getTimezone,
  localWeekStart,
} = require('../weekly');

const router = express.Router();
router.use(authenticate, requireAdmin);

// ── Users ─────────────────────────────────────────────────────────────────────

router.get('/users', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, role, time_balance_minutes, created_at FROM users ORDER BY username'
    );
    res.json(result.rows);
  } catch (err) {
    sendError(res, err, 'GET /users');
  }
});

router.post('/users', async (req, res) => {
  const { username, password, role = 'user' } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  if (!['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Role must be "user" or "admin".' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, role)
       VALUES ($1, $2, $3)
       RETURNING id, username, role, time_balance_minutes, created_at`,
      [username, hash, role]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: `Username "${username}" is already taken.` });
    }
    sendError(res, err, 'POST /users');
  }
});

router.delete('/users/:id', async (req, res) => {
  if (parseInt(req.params.id, 10) === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  try {
    const result = await pool.query(
      'DELETE FROM users WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json({ success: true });
  } catch (err) {
    sendError(res, err, 'DELETE /users/:id');
  }
});

// Award time to a user (positive amount)
router.post('/users/:id/award', async (req, res) => {
  const { amount_minutes, reason } = req.body;
  const mins = parseInt(amount_minutes, 10);
  if (!mins || mins <= 0) {
    return res.status(400).json({ error: 'amount_minutes must be a positive integer.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO time_awards (user_id, amount_minutes, reason, awarded_by) VALUES ($1, $2, $3, $4)',
      [req.params.id, mins, reason || null, req.user.id]
    );
    const result = await client.query(
      'UPDATE users SET time_balance_minutes = time_balance_minutes + $1 WHERE id = $2 RETURNING time_balance_minutes',
      [mins, req.params.id]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found.' });
    }
    await client.query('COMMIT');
    res.json({ new_balance: result.rows[0].time_balance_minutes });
  } catch (err) {
    await client.query('ROLLBACK');
    sendError(res, err, 'POST /users/:id/award');
  } finally {
    client.release();
  }
});

// Deduct time from a user (stores as negative award for audit trail)
router.post('/users/:id/deduct', async (req, res) => {
  const { amount_minutes, reason } = req.body;
  const mins = parseInt(amount_minutes, 10);
  if (!mins || mins <= 0) {
    return res.status(400).json({ error: 'amount_minutes must be a positive integer.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO time_awards (user_id, amount_minutes, reason, awarded_by) VALUES ($1, $2, $3, $4)',
      [req.params.id, -mins, reason || null, req.user.id]
    );
    const result = await client.query(
      'UPDATE users SET time_balance_minutes = time_balance_minutes - $1 WHERE id = $2 RETURNING time_balance_minutes',
      [mins, req.params.id]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found.' });
    }
    await client.query('COMMIT');
    res.json({ new_balance: result.rows[0].time_balance_minutes });
  } catch (err) {
    await client.query('ROLLBACK');
    sendError(res, err, 'POST /users/:id/deduct');
  } finally {
    client.release();
  }
});

// Override spending block for a user for the current week
router.post('/users/:id/unblock', async (req, res) => {
  const weekStart = getWeekStart();
  const weekStartStr = formatDate(weekStart);
  try {
    await pool.query(
      `INSERT INTO weekly_user_status
         (user_id, week_start, mandatory_chores_met, spending_blocked, admin_override, evaluated_at)
       VALUES ($1, $2, false, false, true, NOW())
       ON CONFLICT (user_id, week_start)
       DO UPDATE SET spending_blocked = false, admin_override = true`,
      [req.params.id, weekStartStr]
    );
    res.json({ success: true });
  } catch (err) {
    sendError(res, err, 'POST /users/:id/unblock');
  }
});

// Weekly status overview for all non-admin users
router.get('/weekly-status', async (req, res) => {
  try {
    const tz = await getTimezone();
    const weekStartStr = localWeekStart(tz);
    const mandatoryIds = await getMandatoryChoresForWeek(weekStartStr);
    const safeIds = mandatoryIds.length > 0 ? mandatoryIds : [-1];
    const settings = await getWeeklySettings(weekStartStr);
    const required =
      settings.required_mandatory_count === 0
        ? mandatoryIds.length
        : settings.required_mandatory_count;

    const users = await pool.query(
      `SELECT u.id, u.username, u.role, u.time_balance_minutes,
              wus.spending_blocked, wus.admin_override, wus.mandatory_chores_met
       FROM users u
       LEFT JOIN weekly_user_status wus
         ON u.id = wus.user_id AND wus.week_start = $1
       WHERE u.role = 'user'
       ORDER BY u.username`,
      [weekStartStr]
    );

    const completions = await pool.query(
      `SELECT user_id, COUNT(*) AS count
       FROM chore_completions
       WHERE week_start = $1
         AND chore_id = ANY($2)
         AND status IN ('approved', 'auto_approved')
       GROUP BY user_id`,
      [weekStartStr, safeIds]
    );
    const compMap = {};
    completions.rows.forEach((r) => { compMap[r.user_id] = parseInt(r.count, 10); });

    res.json(
      users.rows.map((u) => ({
        ...u,
        mandatory_completed: compMap[u.id] || 0,
        mandatory_required: required,
        mandatory_total: mandatoryIds.length,
      }))
    );
  } catch (err) {
    sendError(res, err, 'GET /weekly-status');
  }
});

// ── Chores ────────────────────────────────────────────────────────────────────

router.get('/chores', async (req, res) => {
  try {
    const tz = await getTimezone();
    const weekStartStr = localWeekStart(tz);
    const mandatoryIds = await getMandatoryChoresForWeek(weekStartStr);
    const safeIds = mandatoryIds.length > 0 ? mandatoryIds : [-1];

    const result = await pool.query(
      `SELECT c.*, (c.id = ANY($1)) AS is_mandatory_this_week
       FROM chores c
       ORDER BY c.name`,
      [safeIds]
    );
    res.json(result.rows);
  } catch (err) {
    sendError(res, err, 'GET /chores');
  }
});

router.post('/chores', async (req, res) => {
  const {
    name, description, chore_type,
    time_earned_minutes, time_ratio, requires_validation,
    repeat_type, max_earned_minutes, max_period,
  } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Chore name is required.' });
  }
  if (!chore_type) {
    return res.status(400).json({ error: 'Chore type is required.' });
  }
  if (!['doing', 'time_based'].includes(chore_type)) {
    return res.status(400).json({ error: 'Type must be "doing" or "time_based".' });
  }
  if (!['once', 'daily', 'unlimited', 'weekdays'].includes(repeat_type || 'once')) {
    return res.status(400).json({ error: 'repeat_type must be "once", "daily", "unlimited", or "weekdays".' });
  }

  // Safely parse the earning cap — null means no cap
  const capMinutes = max_earned_minutes != null && max_earned_minutes !== ''
    ? parseInt(max_earned_minutes, 10)
    : null;
  if (capMinutes !== null && (isNaN(capMinutes) || capMinutes <= 0)) {
    return res.status(400).json({ error: 'Max earning cap must be a positive number, or leave blank for no cap.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO chores
         (name, description, chore_type, time_earned_minutes, time_ratio, requires_validation,
          repeat_type, max_earned_minutes, max_period)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        name.trim(),
        description ? description.trim() : null,
        chore_type,
        parseInt(time_earned_minutes, 10) || 0,
        parseFloat(time_ratio) || 0.5,
        requires_validation === true || requires_validation === 'true',
        repeat_type || 'once',
        capMinutes,
        max_period || 'week',
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    sendError(res, err, 'POST /chores');
  }
});

router.put('/chores/:id', async (req, res) => {
  const {
    name, description, chore_type,
    time_earned_minutes, time_ratio, requires_validation, active,
    repeat_type, max_earned_minutes, max_period,
  } = req.body;

  // Validate repeat_type if provided
  if (repeat_type !== undefined && !['once', 'daily', 'unlimited', 'weekdays'].includes(repeat_type)) {
    return res.status(400).json({ error: 'repeat_type must be "once", "daily", "unlimited", or "weekdays".' });
  }
  if (max_period !== undefined && !['day', 'week'].includes(max_period)) {
    return res.status(400).json({ error: 'max_period must be "day" or "week".' });
  }

  // Safely parse the earning cap.
  // - undefined (field not sent)  → keep existing value (handled by COALESCE in SQL)
  // - null or ""                  → clear the cap (set to NULL)
  // - positive integer            → set the cap
  let capMinutes;
  if (max_earned_minutes === undefined) {
    capMinutes = undefined; // will be excluded from the SET clause
  } else if (max_earned_minutes === null || max_earned_minutes === '') {
    capMinutes = null; // explicitly clear the cap
  } else {
    capMinutes = parseInt(max_earned_minutes, 10);
    if (isNaN(capMinutes) || capMinutes <= 0) {
      return res.status(400).json({
        error: 'Max earning cap must be a positive integer, or leave blank to remove the cap.',
      });
    }
  }

  try {
    // Build the SET clause dynamically so we only update fields that were actually sent.
    // This avoids the COALESCE(undefined, col) pattern and is more explicit.
    const sets = [];
    const params = [];
    const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (name               !== undefined) add('name',                name ? name.trim() : name);
    if (description        !== undefined) add('description',         description ? description.trim() : null);
    if (chore_type         !== undefined) add('chore_type',          chore_type);
    if (time_earned_minutes !== undefined) add('time_earned_minutes', parseInt(time_earned_minutes, 10) || 0);
    if (time_ratio         !== undefined) add('time_ratio',          parseFloat(time_ratio) || 0.5);
    if (requires_validation !== undefined) add('requires_validation', requires_validation === true || requires_validation === 'true');
    if (active             !== undefined) add('active',              active === true || active === 'true');
    if (repeat_type        !== undefined) add('repeat_type',         repeat_type);
    if (capMinutes         !== undefined) add('max_earned_minutes',  capMinutes); // null clears cap, number sets it
    if (max_period         !== undefined) add('max_period',          max_period);

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No fields provided to update.' });
    }

    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE chores SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: `Chore #${req.params.id} not found.` });
    }
    res.json(result.rows[0]);
  } catch (err) {
    sendError(res, err, 'PUT /chores/:id');
  }
});

// Delete a chore — hard delete if no completions, soft delete (deactivate) otherwise
router.delete('/chores/:id', async (req, res) => {
  try {
    const countRow = await pool.query(
      'SELECT COUNT(*) AS count FROM chore_completions WHERE chore_id = $1',
      [req.params.id]
    );
    const hasCompletions = parseInt(countRow.rows[0].count, 10) > 0;

    if (hasCompletions) {
      // Preserve historical records — just hide the chore from users
      const result = await pool.query(
        'UPDATE chores SET active = false WHERE id = $1 RETURNING id',
        [req.params.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: `Chore #${req.params.id} not found.` });
      }
      res.json({ success: true, soft: true, message: 'Chore has completion history and was deactivated (hidden from users).' });
    } else {
      // Safe to fully remove
      const result = await pool.query(
        'DELETE FROM chores WHERE id = $1 RETURNING id',
        [req.params.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: `Chore #${req.params.id} not found.` });
      }
      res.json({ success: true, soft: false });
    }
  } catch (err) {
    sendError(res, err, 'DELETE /chores/:id');
  }
});

// ── Mandatory chore management ────────────────────────────────────────────────

router.post('/chores/:id/toggle-mandatory', async (req, res) => {
  const choreId = parseInt(req.params.id, 10);
  if (isNaN(choreId)) {
    return res.status(400).json({ error: 'Invalid chore ID.' });
  }
  const tz = await getTimezone();
  const weekStartStr = localWeekStart(tz);

  try {
    await getMandatoryChoresForWeek(weekStartStr); // ensure this week is initialised

    const existing = await pool.query(
      'SELECT id FROM weekly_mandatory_chores WHERE week_start = $1 AND chore_id = $2',
      [weekStartStr, choreId]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        'DELETE FROM weekly_mandatory_chores WHERE week_start = $1 AND chore_id = $2',
        [weekStartStr, choreId]
      );
      res.json({ mandatory: false });
    } else {
      await pool.query(
        'INSERT INTO weekly_mandatory_chores (week_start, chore_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [weekStartStr, choreId]
      );
      res.json({ mandatory: true });
    }
  } catch (err) {
    sendError(res, err, 'POST /chores/:id/toggle-mandatory');
  }
});

// ── Completions ───────────────────────────────────────────────────────────────

router.get('/completions/pending', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cc.*, c.name AS chore_name, c.chore_type, u.username
       FROM chore_completions cc
       JOIN chores c ON cc.chore_id = c.id
       JOIN users u ON cc.user_id = u.id
       WHERE cc.status = 'pending'
       ORDER BY cc.submitted_at ASC`
    );
    res.json(result.rows);
  } catch (err) {
    sendError(res, err, 'GET /completions/pending');
  }
});

router.get('/completions/all', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         'chore'::TEXT               AS activity_type,
         u.username                  AS username,
         c.name                      AS chore_name,
         c.chore_type::TEXT          AS chore_type,
         cc.status::TEXT             AS status,
         cc.time_earned_minutes      AS time_earned_minutes,
         cc.duration_minutes         AS duration_minutes,
         cc.notes                    AS notes,
         cc.submitted_at             AS submitted_at
       FROM chore_completions cc
       JOIN chores c ON cc.chore_id = c.id
       JOIN users u ON cc.user_id = u.id

       UNION ALL

       SELECT
         'adjustment'::TEXT          AS activity_type,
         u.username                  AS username,
         CASE WHEN ta.amount_minutes >= 0 THEN 'Admin Time Award'
              ELSE 'Admin Time Deduction' END AS chore_name,
         NULL::TEXT                  AS chore_type,
         'adjustment'::TEXT          AS status,
         ta.amount_minutes           AS time_earned_minutes,
         NULL::DECIMAL               AS duration_minutes,
         ta.reason                   AS notes,
         ta.awarded_at               AS submitted_at
       FROM time_awards ta
       JOIN users u ON ta.user_id = u.id

       UNION ALL

       SELECT
         'session'::TEXT                            AS activity_type,
         u.username                                 AS username,
         'Screen Time'::TEXT                        AS chore_name,
         NULL::TEXT                                 AS chore_type,
         ts.status::TEXT                            AS status,
         -CEIL(ts.duration_minutes)::INTEGER        AS time_earned_minutes,
         ts.duration_minutes                        AS duration_minutes,
         NULL::TEXT                                 AS notes,
         ts.end_time                                AS submitted_at
       FROM time_sessions ts
       JOIN users u ON ts.user_id = u.id
       WHERE ts.status = 'completed'

       ORDER BY submitted_at DESC
       LIMIT 200`
    );
    res.json(result.rows);
  } catch (err) {
    sendError(res, err, 'GET /completions/all');
  }
});

router.put('/completions/:id', async (req, res) => {
  const { action } = req.body;
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'action must be "approve" or "reject".' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const compRow = await client.query(
      "SELECT * FROM chore_completions WHERE id = $1 AND status = 'pending'",
      [req.params.id]
    );
    if (compRow.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pending completion not found — it may have already been reviewed.' });
    }
    const comp = compRow.rows[0];
    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    await client.query(
      'UPDATE chore_completions SET status = $1, validated_at = NOW(), validated_by = $2 WHERE id = $3',
      [newStatus, req.user.id, req.params.id]
    );

    if (action === 'approve' && comp.time_earned_minutes > 0) {
      await client.query(
        'UPDATE users SET time_balance_minutes = time_balance_minutes + $1 WHERE id = $2',
        [comp.time_earned_minutes, comp.user_id]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, new_status: newStatus });
  } catch (err) {
    await client.query('ROLLBACK');
    sendError(res, err, 'PUT /completions/:id');
  } finally {
    client.release();
  }
});

// ── App settings (timezone, etc.) ────────────────────────────────────────────

router.get('/app-settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM app_settings');
    const out = {};
    result.rows.forEach((r) => { out[r.key] = r.value; });
    res.json(out);
  } catch (err) {
    sendError(res, err, 'GET /app-settings');
  }
});

router.post('/app-settings', async (req, res) => {
  const { timezone, report_email } = req.body;
  if (timezone === undefined && report_email === undefined) {
    return res.status(400).json({ error: 'Provide at least one of: timezone, report_email.' });
  }

  if (timezone !== undefined) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      return res.status(400).json({ error: `"${timezone}" is not a valid IANA timezone.` });
    }
  }

  try {
    const updates = [];
    if (timezone !== undefined) updates.push({ key: 'timezone', value: timezone });
    if (report_email !== undefined) updates.push({ key: 'report_email', value: report_email });

    for (const { key, value } of updates) {
      if (value === '') {
        await pool.query('DELETE FROM app_settings WHERE key = $1', [key]);
      } else {
        await pool.query(
          `INSERT INTO app_settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = $2`,
          [key, value]
        );
      }
    }
    res.json({ timezone, report_email });
  } catch (err) {
    sendError(res, err, 'POST /app-settings');
  }
});

// ── Weekly settings ───────────────────────────────────────────────────────────

router.get('/settings', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM weekly_settings ORDER BY effective_week_start DESC LIMIT 20'
    );
    res.json(result.rows);
  } catch (err) {
    sendError(res, err, 'GET /settings');
  }
});

router.post('/settings', async (req, res) => {
  const { required_mandatory_count, allowance_minutes, effective_week_start } = req.body;

  const allowance = parseInt(allowance_minutes, 10);
  if (isNaN(allowance) || allowance < 0) {
    return res.status(400).json({ error: 'allowance_minutes must be 0 or a positive integer.' });
  }

  let effectiveDate = effective_week_start;
  if (!effectiveDate) {
    const tz = await getTimezone();
    const thisWeek = new Date(localWeekStart(tz) + 'T12:00:00Z');
    thisWeek.setUTCDate(thisWeek.getUTCDate() + 7);
    effectiveDate = thisWeek.toISOString().slice(0, 10);
  }

  try {
    const result = await pool.query(
      `INSERT INTO weekly_settings
         (effective_week_start, required_mandatory_count, allowance_minutes, set_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (effective_week_start)
       DO UPDATE SET
         required_mandatory_count = $2,
         allowance_minutes        = $3,
         set_by                   = $4,
         created_at               = NOW()
       RETURNING *`,
      [effectiveDate, parseInt(required_mandatory_count, 10) || 0, allowance, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    sendError(res, err, 'POST /settings');
  }
});

module.exports = router;
