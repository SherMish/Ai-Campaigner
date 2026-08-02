-- AI Campaigner schema bootstrap. UTF-8 / Hebrew-safe on Postgres (Neon) by
-- default. Enum-like values are stored as TEXT and validated in application
-- code against shared enums, so adding a new value never needs a DDL migration.
--
-- This first migration only establishes the migration ledger. The 10 P0
-- entities (customer, meta_connection, ad_account, managed_campaign,
-- insight_snapshot, recommendation, action_history, ops_queue_item,
-- lead_quality_feedback, billing) land in AIC-4 as their own numbered
-- migrations against this ledger.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS _migrations (
  id          BIGSERIAL PRIMARY KEY,
  filename    TEXT UNIQUE NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
