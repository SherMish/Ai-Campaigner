# <Feature name>

> Copy this file to `docs/features/<feature>.md` when a new feature lands, fill in
> every section, and add its row to [../INDEX.md](../INDEX.md). Delete this comment.

**Status:** <planned | in progress | live> — one line on where this feature is.

**Source of truth:** the code files that own this behaviour, e.g.
`server/src/foo.ts`, `web/src/features/foo/`. List the real paths — this is where a
reader goes to verify the doc against the code.

**Lock-in tests:** the tests that pin this behaviour so it can't silently regress,
e.g. `server/test/foo.test.ts`. Every behaviour described below should trace to one.

---

## How it works today

Describe the **current** behaviour, plainly — not the history of how it got here.
When the behaviour changes, rewrite the stale sentence here; record the *what/why* of
the change in [../STATE.md](../STATE.md), not in this doc.
