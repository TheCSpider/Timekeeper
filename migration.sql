-- Migration: add repeatability and earning-cap columns to chores
-- Run this against an existing database if you already have data.
-- New installs do not need this — init.sql already includes these columns.
--
-- Usage (inside the running Docker stack):
--   docker compose exec db psql -U timekeeper -d timekeeper -f /migration.sql
-- Or copy it in:
--   docker compose cp migration.sql db:/migration.sql
--   docker compose exec db psql -U timekeeper -d timekeeper -f /migration.sql

ALTER TABLE chores
    ADD COLUMN IF NOT EXISTS repeat_type     VARCHAR(10) NOT NULL DEFAULT 'once'
        CHECK (repeat_type IN ('once', 'daily', 'unlimited')),
    ADD COLUMN IF NOT EXISTS max_earned_minutes INTEGER,
    ADD COLUMN IF NOT EXISTS max_period      VARCHAR(10) NOT NULL DEFAULT 'week'
        CHECK (max_period IN ('day', 'week'));
