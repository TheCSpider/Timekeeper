-- Timekeeper Database Schema

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(10) NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    time_balance_minutes INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Chore definitions
CREATE TABLE IF NOT EXISTS chores (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    chore_type VARCHAR(20) NOT NULL CHECK (chore_type IN ('doing', 'time_based')),
    time_earned_minutes INTEGER NOT NULL DEFAULT 0,  -- for 'doing' type
    time_ratio DECIMAL(5,2) NOT NULL DEFAULT 0.5,    -- for 'time_based': earn (duration * ratio) minutes
    requires_validation BOOLEAN NOT NULL DEFAULT false,
    -- Repeatability: 'once' = one per week, 'daily' = once per calendar day, 'unlimited' = no count limit
    repeat_type VARCHAR(10) NOT NULL DEFAULT 'once' CHECK (repeat_type IN ('once', 'daily', 'unlimited', 'weekdays')),
    -- Optional earning cap per period (NULL = no cap)
    max_earned_minutes INTEGER,
    max_period VARCHAR(10) NOT NULL DEFAULT 'week' CHECK (max_period IN ('day', 'week')),
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Which chores are mandatory for a given week (Sunday date = week key)
CREATE TABLE IF NOT EXISTS weekly_mandatory_chores (
    id SERIAL PRIMARY KEY,
    week_start DATE NOT NULL,
    chore_id INTEGER NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
    UNIQUE(week_start, chore_id)
);

-- Weekly configuration: allowance amount and required mandatory chore count
-- Uses effective_week_start so admin can schedule future changes
CREATE TABLE IF NOT EXISTS weekly_settings (
    id SERIAL PRIMARY KEY,
    effective_week_start DATE NOT NULL UNIQUE,
    required_mandatory_count INTEGER NOT NULL DEFAULT 0, -- 0 = all mandatory chores required
    allowance_minutes INTEGER NOT NULL DEFAULT 60,
    set_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Chore completions submitted by users
CREATE TABLE IF NOT EXISTS chore_completions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    chore_id INTEGER NOT NULL REFERENCES chores(id),
    week_start DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'auto_approved')),
    duration_minutes DECIMAL(10,2),          -- only for time_based chores
    time_earned_minutes INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    validated_at TIMESTAMP WITH TIME ZONE,
    validated_by INTEGER REFERENCES users(id)
);

-- Active and completed screen-time spending sessions
CREATE TABLE IF NOT EXISTS time_sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE,
    duration_minutes DECIMAL(10,2),
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'completed', 'cancelled')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Admin-issued time awards
CREATE TABLE IF NOT EXISTS time_awards (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount_minutes INTEGER NOT NULL,
    reason TEXT,
    awarded_by INTEGER NOT NULL REFERENCES users(id),
    awarded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Track Sunday allowance payments (one per user per week)
CREATE TABLE IF NOT EXISTS weekly_allowances (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    week_start DATE NOT NULL,
    amount_minutes INTEGER NOT NULL,
    paid_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, week_start)
);

-- Per-user per-week status: was spending blocked, was it overridden by admin
CREATE TABLE IF NOT EXISTS weekly_user_status (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    week_start DATE NOT NULL,
    mandatory_chores_met BOOLEAN NOT NULL DEFAULT false,
    spending_blocked BOOLEAN NOT NULL DEFAULT false,
    admin_override BOOLEAN NOT NULL DEFAULT false,
    evaluated_at TIMESTAMP WITH TIME ZONE,
    UNIQUE(user_id, week_start)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_completions_user_week  ON chore_completions(user_id, week_start);
CREATE INDEX IF NOT EXISTS idx_completions_status     ON chore_completions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_user_status   ON time_sessions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_mandatory_week         ON weekly_mandatory_chores(week_start);
CREATE INDEX IF NOT EXISTS idx_wus_user_week          ON weekly_user_status(user_id, week_start);
