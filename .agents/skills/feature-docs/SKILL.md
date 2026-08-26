---
name: feature-docs
description: Keep feature documentation in lockstep with the code. Invoke whenever a
  feature is added, changed, or removed — it enforces one-doc-per-feature, the INDEX
  routing table, and the STATE changelog.
---

# Feature documentation discipline

Every feature has exactly one **owning doc** under `docs/features/`. This skill is the
loop that keeps those docs true.

## When to run
Any time you add, change, or delete a feature or behaviour — as part of the SAME unit
of work, before it's done.

## The loop
1. **Locate the owner** in `docs/INDEX.md`. If none exists for a new feature, create
   one from `docs/features/_TEMPLATE.md`.
2. **Edit the doc to describe how it works TODAY.** Rewrite the stale sentence; never
   append "update: now X". The owning doc is current behaviour, not history.
3. **On deletion,** delete the owning doc and its INDEX row.
4. **Update INDEX.md** on any doc add/rename/remove.
5. **Append a STATE.md block:** `### YYYY-MM-DD — <title>` at the top, one per change,
   what changed and why. Never extend an existing line.
6. **House shape** for every owning doc: `Status` / `Source of truth` (the code files)
   / `Lock-in tests` / body.

## Definition of done
Owning doc reflects current behaviour · INDEX routes to it · STATE has a dated block ·
tests ship with the change.
