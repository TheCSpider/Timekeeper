const express = require('express');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');
const { sendError } = require('../errors');
const {
  getMandatoryChoresForWeek,
  getWeeklySettings,
  processWeeklyUpdates,
  getTimezone,
  localWeekStart,
  localDayOfWeek,
} = require('../weekly');

const router = express.Router();
router.use(authenticate);

// ── Helpers ───────────────────────────────────────────────────────────────────

// Check whether a user can submit a chore right now, and how much they'd earn.
// Returns { allowed, reason, timeEarned, atCap }
async function checkChoreEligibility(userId, chore, isMandatory, durationMinutes, tz) {
  const weekStartStr = localWeekStart(tz);

  // ── Repeat constraint ──────────────────────────────────────────────────────
  if (chore.repeat_type === 'once') {
    const existing = await pool.query(
      `SELECT id FROM chore_completions
       WHERE user_id = $1 AND chore_id = $2 AND week_start = $3
         AND status != 'rejected'`,
      [userId, chore.id, weekStartStr]
    );
    if (existing.rows.length > 0) {
      return { allowed: false, reason: 'Already completed this week.' };
    }
  } else if (chore.repeat_type === 'daily') {
    const existing = await pool.query(
      `SELECT id FROM chore_completions
       WHERE user_id = $1 AND chore_id = $2
         AND submitted_at AT TIME ZONE $3 >= DATE_TRUNC('day', NOW() AT TIME ZONE $3)
         AND submitted_at AT TIME ZONE $3 < DATE_TRUNC('day', NOW() AT TIME ZONE $3) + INTERVAL '1 day'
         AND status != 'rejected'`,
      [userId, chore.id, tz]
    );
    if (existing.rows.length > 0) {
      return { allowed: false, reason: 'Already completed today.' };
    }
  } else if (chore.repeat_type === 'weekdays') {
    const dow = localDayOfWeek(tz);
    if (dow === 0 || dow === 6) {
      return { allowed: false, reason: 'This chore is only available on weekdays (Mon–Fri).' };
    }
    const existing = await pool.query(
      `SELECT id FROM chore_completions
       WHERE user_id = $1 AND chore_id = $2
         AND submitted_at AT TIME ZONE $3 >= DATE_TRUNC('day', NOW() AT TIME ZONE $3)
         AND submitted_at AT TIME ZONE $3 < DATE_TRUNC('day', NOW() AT TIME ZONE $3) + INTERVAL '1 day'
         AND status != 'rejected'`,
      [userId, chore.id, tz]
    );
    if (existing.rows.length > 0) {
      return { allowed: false, reason: 'Already completed today.' };
    }
  }
  // 'unlimited' → no count constraint

  // ── Base time earned ───────────────────────────────────────────────────────
  let timeEarned = 0;
  if (!isMandatory) {
    if (chore.chore_type === 'doing') {
      timeEarned = chore.time_earned_minutes || 0;
    } else {
      timeEarned = Math.floor((durationMinutes || 0) * parseFloat(chore.time_ratio || 0.5));
    }
  }

  // ── Earning cap ────────────────────────────────────────────────────────────
  let atCap = false;
  if (chore.max_earned_minutes && timeEarned > 0) {
    const period = chore.max_period || 'week';
    let earnedSoFar;
    if (period === 'day') {
      const r = await pool.query(
        `SELECT COALESCE(SUM(time_earned_minutes), 0) AS total
         FROM chore_completions
         WHERE user_id = $1 AND chore_id = $2
           AND submitted_at AT TIME ZONE $3 >= DATE_TRUNC('day', NOW() AT TIME ZONE $3)
           AND submitted_at AT TIME ZONE $3 < DATE_TRUNC('day', NOW() AT TIME ZONE $3) + INTERVAL '1 day'
           AND status IN ('approved', 'auto_approved')`,
        [userId, chore.id, tz]
      );
      earnedSoFar = parseInt(r.rows[0].total, 10);
    } else {
      const r = await pool.query(
        `SELECT COALESCE(SUM(time_earned_minutes), 0) AS total
         FROM chore_completions
         WHERE user_id = $1 AND chore_id = $2 AND week_start = $3
           AND status IN ('approved', 'auto_approved')`,
        [userId, chore.id, weekStartStr]
      );
      earnedSoFar = parseInt(r.rows[0].total, 10);
    }

    const remaining = chore.max_earned_minutes - earnedSoFar;
    if (remaining <= 0) {
      timeEarned = 0;
      atCap = true;
    } else {
      timeEarned = Math.min(timeEarned, remaining);
    }
  }

  return { allowed: true, timeEarned, atCap };
}

// ── Status ────────────────────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const { spendingBlocked } = await processWeeklyUpdates(req.user.id);

    const userRow = await pool.query(
      'SELECT time_balance_minutes FROM users WHERE id = $1',
      [req.user.id]
    );

    const sessionRow = await pool.query(
      `SELECT * FROM time_sessions
       WHERE user_id = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );

    const tz = await getTimezone();
    const weekStartStr = localWeekStart(tz);
    const mandatoryIds = await getMandatoryChoresForWeek(weekStartStr);
    const settings = await getWeeklySettings(weekStartStr);
    const required =
      settings.required_mandatory_count === 0
        ? mandatoryIds.length
        : settings.required_mandatory_count;

    let mandatoryCompleted = 0;
    if (mandatoryIds.length > 0) {
      const r = await pool.query(
        `SELECT COUNT(*) AS count FROM chore_completions
         WHERE user_id = $1 AND week_start = $2
           AND chore_id = ANY($3)
           AND status IN ('approved', 'auto_approved')`,
        [req.user.id, weekStartStr, mandatoryIds]
      );
      mandatoryCompleted = parseInt(r.rows[0].count, 10);
    }

    res.json({
      balance: userRow.rows[0].time_balance_minutes,
      spendingBlocked,
      activeSession: sessionRow.rows[0] || null,
      mandatory: {
        required,
        completed: mandatoryCompleted,
        total: mandatoryIds.length,
        ids: mandatoryIds,
      },
    });
  } catch (err) {
    sendError(res, err, 'user route');
  }
});

// ── Start session ─────────────────────────────────────────────────────────────
router.post('/session/start', async (req, res) => {
  try {
    const { spendingBlocked } = await processWeeklyUpdates(req.user.id);
    if (spendingBlocked) {
      return res.status(403).json({
        error: 'Spending is blocked: mandatory chores were not completed last week.',
      });
    }

    const existing = await pool.query(
      "SELECT id FROM time_sessions WHERE user_id = $1 AND status = 'active'",
      [req.user.id]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'You already have an active session.' });
    }

    // Allow starting even with 0 or negative balance (time debt)
    const startTime = req.body.start_time ? new Date(req.body.start_time) : new Date();

    const result = await pool.query(
      "INSERT INTO time_sessions (user_id, start_time, status) VALUES ($1, $2, 'active') RETURNING *",
      [req.user.id, startTime]
    );
    res.json(result.rows[0]);
  } catch (err) {
    sendError(res, err, 'user route');
  }
});

// ── Stop session ──────────────────────────────────────────────────────────────
router.post('/session/stop', async (req, res) => {
  try {
    const sessionRow = await pool.query(
      "SELECT * FROM time_sessions WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      [req.user.id]
    );
    if (sessionRow.rows.length === 0) {
      return res.status(400).json({ error: 'No active session.' });
    }
    const session = sessionRow.rows[0];

    const endTime = req.body.end_time ? new Date(req.body.end_time) : new Date();
    if (endTime < new Date(session.start_time)) {
      return res.status(400).json({ error: 'End time cannot be before the session start time.' });
    }

    const durationMs = endTime - new Date(session.start_time);
    const durationMinutes = durationMs / 60000;
    // Full deduction — balance can go negative (time debt)
    const deduction = Math.floor(durationMinutes);

    const userRow = await pool.query(
      'SELECT time_balance_minutes FROM users WHERE id = $1',
      [req.user.id]
    );
    const balanceBefore = userRow.rows[0].time_balance_minutes;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "UPDATE time_sessions SET end_time = $1, duration_minutes = $2, status = 'completed' WHERE id = $3",
        [endTime, durationMinutes, session.id]
      );
      await client.query(
        'UPDATE users SET time_balance_minutes = time_balance_minutes - $1 WHERE id = $2',
        [deduction, req.user.id]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({
      duration_minutes: durationMinutes,
      time_deducted: deduction,
      new_balance: balanceBefore - deduction,
    });
  } catch (err) {
    sendError(res, err, 'user route');
  }
});

// ── Cancel session (no deduction) ────────────────────────────────────────────
router.post('/session/cancel', async (req, res) => {
  try {
    const sessionRow = await pool.query(
      "SELECT id FROM time_sessions WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      [req.user.id]
    );
    if (sessionRow.rows.length === 0) {
      return res.status(400).json({ error: 'No active session.' });
    }
    await pool.query(
      "UPDATE time_sessions SET end_time = NOW(), duration_minutes = 0, status = 'cancelled' WHERE id = $1",
      [sessionRow.rows[0].id]
    );
    res.json({ success: true });
  } catch (err) {
    sendError(res, err, 'user route');
  }
});

// ── Chores list ───────────────────────────────────────────────────────────────
router.get('/chores', async (req, res) => {
  try {
    const tz = await getTimezone();
    const weekStartStr = localWeekStart(tz);
    const dow = localDayOfWeek(tz);
    const mandatoryIds = await getMandatoryChoresForWeek(weekStartStr);
    const safeIds = mandatoryIds.length > 0 ? mandatoryIds : [-1];

    // All completions this week (for repeat checking and status display)
    const weekCompletions = await pool.query(
      `SELECT chore_id, status, time_earned_minutes, submitted_at
       FROM chore_completions
       WHERE user_id = $1 AND week_start = $2`,
      [req.user.id, weekStartStr]
    );

    // Today's completions in the configured timezone (for daily repeat checking)
    const todayCompletions = await pool.query(
      `SELECT chore_id, status, time_earned_minutes
       FROM chore_completions
       WHERE user_id = $1
         AND submitted_at AT TIME ZONE $2 >= DATE_TRUNC('day', NOW() AT TIME ZONE $2)
         AND submitted_at AT TIME ZONE $2 < DATE_TRUNC('day', NOW() AT TIME ZONE $2) + INTERVAL '1 day'`,
      [req.user.id, tz]
    );

    // Earned per chore this week (approved) — for cap tracking
    const weekEarned = await pool.query(
      `SELECT chore_id, COALESCE(SUM(time_earned_minutes), 0) AS total
       FROM chore_completions
       WHERE user_id = $1 AND week_start = $2 AND status IN ('approved', 'auto_approved')
       GROUP BY chore_id`,
      [req.user.id, weekStartStr]
    );
    const weekEarnedMap = {};
    weekEarned.rows.forEach((r) => { weekEarnedMap[r.chore_id] = parseInt(r.total, 10); });

    // Earned per chore today in the configured timezone — for daily cap tracking
    const todayEarned = await pool.query(
      `SELECT chore_id, COALESCE(SUM(time_earned_minutes), 0) AS total
       FROM chore_completions
       WHERE user_id = $1
         AND submitted_at AT TIME ZONE $2 >= DATE_TRUNC('day', NOW() AT TIME ZONE $2)
         AND submitted_at AT TIME ZONE $2 < DATE_TRUNC('day', NOW() AT TIME ZONE $2) + INTERVAL '1 day'
         AND status IN ('approved', 'auto_approved')
       GROUP BY chore_id`,
      [req.user.id, tz]
    );
    const todayEarnedMap = {};
    todayEarned.rows.forEach((r) => { todayEarnedMap[r.chore_id] = parseInt(r.total, 10); });

    // Build lookup maps
    const weekCompMap = {};  // chore_id → last status this week
    weekCompletions.rows.forEach((r) => { weekCompMap[r.chore_id] = r.status; });

    const todayCompSet = new Set();  // chore IDs submitted today (non-rejected)
    todayCompletions.rows
      .filter((r) => r.status !== 'rejected')
      .forEach((r) => todayCompSet.add(r.chore_id));

    const chores = await pool.query(
      `SELECT c.*, (c.id = ANY($1)) AS is_mandatory_this_week
       FROM chores c
       WHERE c.active = true
       ORDER BY (c.id = ANY($1)) DESC, c.name`,
      [safeIds]
    );

    // Annotate each chore with submission eligibility
    const result = chores.rows.map((c) => {
      const isMandatory = mandatoryIds.includes(c.id);
      let canSubmit = true;
      let submitBlockReason = null;
      let atCap = false;

      // Repeat constraint
      if (c.repeat_type === 'once') {
        const weekStatus = weekCompMap[c.id];
        if (weekStatus && weekStatus !== 'rejected') {
          canSubmit = false;
          submitBlockReason = 'Completed this week';
        }
      } else if (c.repeat_type === 'daily') {
        if (todayCompSet.has(c.id)) {
          canSubmit = false;
          submitBlockReason = 'Completed today';
        }
      } else if (c.repeat_type === 'weekdays') {
        if (dow === 0 || dow === 6) {
          canSubmit = false;
          submitBlockReason = 'Weekdays only (Mon–Fri)';
        } else if (todayCompSet.has(c.id)) {
          canSubmit = false;
          submitBlockReason = 'Completed today';
        }
      }

      // Cap check (show even if submit is blocked for other reason)
      if (c.max_earned_minutes) {
        const period = c.max_period || 'week';
        const earned = period === 'day' ? (todayEarnedMap[c.id] || 0) : (weekEarnedMap[c.id] || 0);
        if (earned >= c.max_earned_minutes) {
          atCap = true;
          if (isMandatory) {
            // Mandatory chores can still be submitted at cap (just earn nothing)
          } else if (!submitBlockReason) {
            submitBlockReason = `Earning cap reached (${c.max_earned_minutes}m/${period})`;
          }
        }
      }

      return {
        ...c,
        is_mandatory_this_week: isMandatory,
        completion_status: weekCompMap[c.id] || null,
        can_submit: canSubmit,
        submit_block_reason: submitBlockReason,
        at_cap: atCap,
        earned_this_week: weekEarnedMap[c.id] || 0,
        earned_today: todayEarnedMap[c.id] || 0,
      };
    });

    res.json(result);
  } catch (err) {
    sendError(res, err, 'user route');
  }
});

// ── Submit chore completion ───────────────────────────────────────────────────
router.post('/chores/:id/complete', async (req, res) => {
  try {
    const choreId = parseInt(req.params.id, 10);
    const { duration_minutes, notes } = req.body;

    const choreRow = await pool.query(
      'SELECT * FROM chores WHERE id = $1 AND active = true',
      [choreId]
    );
    if (choreRow.rows.length === 0) {
      return res.status(404).json({ error: 'Chore not found.' });
    }
    const chore = choreRow.rows[0];

    if (chore.chore_type === 'time_based' && (!duration_minutes || duration_minutes <= 0)) {
      return res.status(400).json({ error: 'Duration (in minutes) required for time-based chores.' });
    }

    const tz = await getTimezone();
    const weekStartStr = localWeekStart(tz);
    const mandatoryIds = await getMandatoryChoresForWeek(weekStartStr);
    const isMandatory = mandatoryIds.includes(choreId);

    // Check eligibility (handles repeat + cap)
    const eligibility = await checkChoreEligibility(
      req.user.id, chore, isMandatory, duration_minutes, tz
    );

    if (!eligibility.allowed) {
      return res.status(400).json({ error: eligibility.reason });
    }

    const timeEarned = eligibility.timeEarned;
    const status = chore.requires_validation ? 'pending' : 'auto_approved';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const completion = await client.query(
        `INSERT INTO chore_completions
           (user_id, chore_id, week_start, status, duration_minutes, time_earned_minutes, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [req.user.id, choreId, weekStartStr, status, duration_minutes || null, timeEarned, notes || null]
      );

      if (status === 'auto_approved' && timeEarned > 0) {
        await client.query(
          'UPDATE users SET time_balance_minutes = time_balance_minutes + $1 WHERE id = $2',
          [timeEarned, req.user.id]
        );
      }

      await client.query('COMMIT');
      res.json({ ...completion.rows[0], at_cap: eligibility.atCap });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    sendError(res, err, 'user route');
  }
});

// ── Completion history (chore completions + admin time adjustments) ───────────
router.get('/completions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         'chore'::TEXT               AS activity_type,
         c.name                      AS chore_name,
         c.chore_type::TEXT          AS chore_type,
         cc.status::TEXT             AS status,
         cc.time_earned_minutes      AS time_earned_minutes,
         cc.duration_minutes         AS duration_minutes,
         cc.notes                    AS notes,
         cc.submitted_at             AS submitted_at
       FROM chore_completions cc
       JOIN chores c ON cc.chore_id = c.id
       WHERE cc.user_id = $1

       UNION ALL

       SELECT
         'adjustment'::TEXT          AS activity_type,
         CASE WHEN ta.amount_minutes >= 0 THEN 'Admin Time Award'
              ELSE 'Admin Time Deduction' END AS chore_name,
         NULL::TEXT                  AS chore_type,
         'adjustment'::TEXT          AS status,
         ta.amount_minutes           AS time_earned_minutes,
         NULL::DECIMAL               AS duration_minutes,
         ta.reason                   AS notes,
         ta.awarded_at               AS submitted_at
       FROM time_awards ta
       WHERE ta.user_id = $1

       UNION ALL

       SELECT
         'session'::TEXT                            AS activity_type,
         'Screen Time'::TEXT                        AS chore_name,
         NULL::TEXT                                 AS chore_type,
         ts.status::TEXT                            AS status,
         -CEIL(ts.duration_minutes)::INTEGER        AS time_earned_minutes,
         ts.duration_minutes                        AS duration_minutes,
         NULL::TEXT                                 AS notes,
         ts.end_time                                AS submitted_at
       FROM time_sessions ts
       WHERE ts.user_id = $1 AND ts.status = 'completed'

       ORDER BY submitted_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    sendError(res, err, 'user route');
  }
});

module.exports = router;
