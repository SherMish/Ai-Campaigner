# Admin viewing a customer's dashboard

**Status:** live (AIC-189). A "כניסה כמשתמש" button on the admin **משתמשים**
page opens that customer's own dashboard, read-only, behind a red bar.

**Source of truth:**
- Token: `server/src/auth/tokens.ts` (`signImpersonationToken`, `verifyAuthToken`)
- The two rules: `server/src/middleware/auth.ts`, `server/src/middleware/admin.ts`
- Route: `POST /admin/users/:id/impersonate` (`server/src/routes/admin.ts`)
- Client detection: `web/src/app/impersonation.ts`
- The bar: `web/src/app/ImpersonationBar.tsx`, `.imp-*` in `web/src/ui.css`
- Button: `web/src/admin/AdminUsers.tsx`

**Lock-in tests:** `server/src/auth/impersonation.test.ts` (through real
Express middleware), `web/src/app/impersonation.test.ts`.

---

## It is a viewer, and that is enforced on the server

An impersonated session **cannot write**. Every non-GET request carrying the
`imp` claim is refused with `403 read_only_session`, in `requireAuth` — not per
route, so the guarantee holds for the next route somebody adds.

This is the live-account safety boundary, restated: nothing happens on a
customer's account that was not either done by them through the dashboard, or by
an admin knowingly through the admin console. A write made through impersonation
is neither — it is an admin action wearing the customer's name, and it would be
recorded as the customer's own, because that is precisely what the session
claims to be. It could spend their budget or create ads in their account.

Hiding the buttons would not be enough. The API is reachable without the UI.

## An impersonation token is never an admin token

`requireAdmin` refuses any token carrying `imp`, **even when the impersonated
user is themselves an admin**. Without that, viewing one admin's dashboard would
hand over the whole admin API under their identity: ops actions and provisioning
writes attributed to the wrong human.

The check is on the token's shape rather than on who is impersonating whom,
because the safe rule is "a session claiming to be someone else never carries
their privileges".

## Thirty minutes

A viewing session exists for the length of a look. This token grants a real
customer's data to somebody who is not them, and there is no reason for it to
sit in a browser overnight. The customer's own session stays at 30 days.

## The bar

Sticky to the top of every `/app` screen, red, not dismissable, naming the
customer, with an exit that clears the token and reloads into the admin console.

The reload is deliberate: every store in memory holds the customer's data, and
carrying that into the admin screens is how one business's numbers end up in
front of a decision about another.

It is not dismissable because the failure it prevents is quiet — an admin skims
a real customer's spend and reasons about it as though it were test data, or
their own. A banner that can be closed is a banner that is closed.

`readImpersonation` decodes the JWT payload in the browser **for display only**.
A JWT is signed, not encrypted, so this is by design; every guarantee that
matters is checked server-side against the signature. If the parser were wrong
in either direction the result would be a missing warning, never a granted
permission.

## Known gaps

- **Nothing is written to `action_history`.** The impersonation is logged to the
  server console (`[admin] impersonation: admin=… → user=…`), which is enough to
  answer "who looked at this" during an incident but is not queryable from the
  ops console.
- **The customer is not told.** Some products show "an admin viewed your account"
  in a log the customer can read. Worth considering before this is used on
  paying customers who did not ask for support.
