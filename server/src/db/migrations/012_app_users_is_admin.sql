-- Per-user admin role (AIC ops console). Admin access is an attribute of the
-- logged-in account, not a shared secret: an app_user with is_admin = true can
-- reach /api/admin/*. Default false, so no one is admin by omission.
ALTER TABLE app_users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false;
