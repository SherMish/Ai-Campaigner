-- Emergency controls (AIC-14). automation_enabled (existing) = stop generating/
-- acting; status='unmanaged' (existing) = mark unmanaged. This adds
-- execution_frozen = freeze execution while leaving monitoring on. All are plain
-- DB flags, effective immediately, no deploy.
ALTER TABLE managed_campaigns
  ADD COLUMN execution_frozen BOOLEAN NOT NULL DEFAULT false;
