const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('./db');

const authRoutes  = require('./routes/auth');
const userRoutes  = require('./routes/user');
const adminRoutes = require('./routes/admin');
const { initScheduler } = require('./scheduler');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

app.use('/api/auth',  authRoutes);
app.use('/api/user',  userRoutes);
app.use('/api/admin', adminRoutes);

// Serve frontend for any non-API GET (SPA-style)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ── Startup initialization ─────────────────────────────────────────────────
async function waitForDb(retries = 15, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch {
      console.log(`Waiting for database... (${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('Database not available after maximum retries');
}

// Create or migrate the full schema.
// Every statement is idempotent (IF NOT EXISTS / DROP … IF EXISTS) so this
// is safe to run on every container start against both fresh and existing DBs.
async function runMigrations() {

  // ── Core tables (creation order respects FK dependencies) ─────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                   SERIAL PRIMARY KEY,
      username             VARCHAR(50)  UNIQUE NOT NULL,
      password_hash        VARCHAR(255) NOT NULL,
      role                 VARCHAR(10)  NOT NULL DEFAULT 'user'
                             CHECK (role IN ('user', 'admin')),
      time_balance_minutes INTEGER      NOT NULL DEFAULT 0,
      created_at           TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chores (
      id                   SERIAL PRIMARY KEY,
      name                 VARCHAR(100) NOT NULL,
      description          TEXT,
      chore_type           VARCHAR(20)  NOT NULL
                             CHECK (chore_type IN ('doing', 'time_based')),
      time_earned_minutes  INTEGER      NOT NULL DEFAULT 0,
      time_ratio           DECIMAL(5,2) NOT NULL DEFAULT 0.5,
      requires_validation  BOOLEAN      NOT NULL DEFAULT false,
      repeat_type          VARCHAR(10)  NOT NULL DEFAULT 'once',
      max_earned_minutes   INTEGER,
      max_period           VARCHAR(10)  NOT NULL DEFAULT 'week'
                             CHECK (max_period IN ('day', 'week')),
      active               BOOLEAN      NOT NULL DEFAULT true,
      created_at           TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS weekly_mandatory_chores (
      id        SERIAL PRIMARY KEY,
      week_start DATE    NOT NULL,
      chore_id  INTEGER NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
      UNIQUE(week_start, chore_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS weekly_settings (
      id                       SERIAL PRIMARY KEY,
      effective_week_start     DATE    NOT NULL UNIQUE,
      required_mandatory_count INTEGER NOT NULL DEFAULT 0,
      allowance_minutes        INTEGER NOT NULL DEFAULT 60,
      set_by                   INTEGER REFERENCES users(id),
      created_at               TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chore_completions (
      id                   SERIAL PRIMARY KEY,
      user_id              INTEGER NOT NULL REFERENCES users(id),
      chore_id             INTEGER NOT NULL REFERENCES chores(id),
      week_start           DATE    NOT NULL,
      status               VARCHAR(20) NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','approved','rejected','auto_approved')),
      duration_minutes     DECIMAL(10,2),
      time_earned_minutes  INTEGER NOT NULL DEFAULT 0,
      notes                TEXT,
      submitted_at         TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      validated_at         TIMESTAMP WITH TIME ZONE,
      validated_by         INTEGER REFERENCES users(id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS time_sessions (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL REFERENCES users(id),
      start_time       TIMESTAMP WITH TIME ZONE NOT NULL,
      end_time         TIMESTAMP WITH TIME ZONE,
      duration_minutes DECIMAL(10,2),
      status           VARCHAR(20) NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','completed','cancelled')),
      created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS time_awards (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL REFERENCES users(id),
      amount_minutes   INTEGER NOT NULL,
      reason           TEXT,
      awarded_by       INTEGER NOT NULL REFERENCES users(id),
      awarded_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS weekly_allowances (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL REFERENCES users(id),
      week_start       DATE    NOT NULL,
      amount_minutes   INTEGER NOT NULL,
      paid_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      UNIQUE(user_id, week_start)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS weekly_user_status (
      id                   SERIAL PRIMARY KEY,
      user_id              INTEGER NOT NULL REFERENCES users(id),
      week_start           DATE    NOT NULL,
      mandatory_chores_met BOOLEAN NOT NULL DEFAULT false,
      spending_blocked     BOOLEAN NOT NULL DEFAULT false,
      admin_override       BOOLEAN NOT NULL DEFAULT false,
      evaluated_at         TIMESTAMP WITH TIME ZONE,
      UNIQUE(user_id, week_start)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key   VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // ── Indexes ────────────────────────────────────────────────────────────────

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_completions_user_week ON chore_completions(user_id, week_start);
    CREATE INDEX IF NOT EXISTS idx_completions_status    ON chore_completions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_status  ON time_sessions(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_mandatory_week        ON weekly_mandatory_chores(week_start);
    CREATE INDEX IF NOT EXISTS idx_wus_user_week         ON weekly_user_status(user_id, week_start)
  `);

  // ── Column additions for databases created before v2 ──────────────────────

  await pool.query(`
    ALTER TABLE chores
      ADD COLUMN IF NOT EXISTS repeat_type        VARCHAR(10) NOT NULL DEFAULT 'once',
      ADD COLUMN IF NOT EXISTS max_earned_minutes INTEGER,
      ADD COLUMN IF NOT EXISTS max_period         VARCHAR(10) NOT NULL DEFAULT 'week'
  `);

  // ── Keep repeat_type CHECK current (drop-and-replace is idempotent) ───────

  await pool.query(`ALTER TABLE chores DROP CONSTRAINT IF EXISTS chores_repeat_type_check`);
  await pool.query(`
    ALTER TABLE chores ADD CONSTRAINT chores_repeat_type_check
      CHECK (repeat_type IN ('once', 'daily', 'unlimited', 'weekdays'))
  `);

  console.log('✅ Schema migrations applied (or already up to date)');
}

async function seedDefaults() {
  // Default admin user
  const admins = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  let adminId;
  if (admins.rows.length === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    const r = await pool.query(
      "INSERT INTO users (username, password_hash, role) VALUES ('admin', $1, 'admin') RETURNING id",
      [hash]
    );
    adminId = r.rows[0].id;
    console.log('✅ Default admin created  →  username: admin  /  password: admin123');
  } else {
    adminId = admins.rows[0].id;
  }

  // Default regular user
  const users = await pool.query("SELECT id FROM users WHERE role = 'user' LIMIT 1");
  if (users.rows.length === 0) {
    const hash = await bcrypt.hash('user123', 10);
    await pool.query(
      "INSERT INTO users (username, password_hash, role) VALUES ('user1', $1, 'user')",
      [hash]
    );
    console.log('✅ Default user created   →  username: user1  /  password: user123');
  }

  // Default weekly settings (effective from this week's Sunday)
  const settings = await pool.query('SELECT id FROM weekly_settings LIMIT 1');
  if (settings.rows.length === 0) {
    await pool.query(
      `INSERT INTO weekly_settings (effective_week_start, required_mandatory_count, allowance_minutes, set_by)
       VALUES (
         CURRENT_DATE - EXTRACT(DOW FROM CURRENT_DATE)::INTEGER * INTERVAL '1 day',
         0, 60, $1
       )`,
      [adminId]
    );
    console.log('✅ Default weekly settings → allowance: 60 min, required mandatory chores: all');
  }

  // Default timezone
  await pool.query(`
    INSERT INTO app_settings (key, value) VALUES ('timezone', 'UTC')
    ON CONFLICT DO NOTHING
  `);

  // Default chores
  const chores = await pool.query('SELECT id FROM chores LIMIT 1');
  if (chores.rows.length === 0) {
    // name, description, type, earned_mins, ratio, requires_validation, repeat_type, max_earned_minutes, max_period
    await pool.query(`
      INSERT INTO chores
        (name, description, chore_type, time_earned_minutes, requires_validation, repeat_type, max_earned_minutes, max_period)
      VALUES
        ('Make Bed',           'Make your bed before 9 AM',            'doing', 10, false, 'daily',   null, 'day'),
        ('Do Dishes',          'Wash all dishes and put them away',     'doing', 20, false, 'daily',   null, 'day'),
        ('Clean Room',         'Tidy and vacuum your room',             'doing', 30, true,  'once',    null, 'week'),
        ('Take Out Trash',     'Empty all trash cans and take to curb', 'doing', 15, false, 'once',    null, 'week'),
        ('Vacuum Living Room', 'Vacuum and mop the living room',        'doing', 25, true,  'once',    null, 'week'),
        ('Set Table',          'Set the table for dinner',              'doing', 10, false, 'daily',   null, 'day'),
        ('Feed Pets',          'Feed and water the pets',               'doing', 10, false, 'daily',   null, 'day')
    `);

    await pool.query(`
      INSERT INTO chores
        (name, description, chore_type, time_ratio, requires_validation, repeat_type, max_earned_minutes, max_period)
      VALUES
        ('Read',                'Read any book or educational material', 'time_based', 0.5,  false, 'unlimited', 60,   'day'),
        ('Practice Instrument', 'Practice a musical instrument',         'time_based', 1.0,  true,  'unlimited', 60,   'day'),
        ('Exercise',            'Any sustained physical exercise',        'time_based', 0.5,  false, 'unlimited', 30,   'day'),
        ('Study / Homework',    'Work on school assignments',             'time_based', 0.75, false, 'unlimited', 90,   'week')
    `);

    console.log('✅ Default chores created (7 doing-type, 4 time-based)');
  }
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`\n🕐 Timekeeper starting on port ${PORT}...\n`);
  try {
    await waitForDb();
    await runMigrations();
    await seedDefaults();
    await initScheduler();
    console.log(`\n🚀 Ready at http://localhost:${PORT}\n`);
  } catch (err) {
    console.error('Startup error:', err.message);
    process.exit(1);
  }
});
