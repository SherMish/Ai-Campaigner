# Customer auth (email + password)

**Status:** live — email+password signup/login with our own JWT session (AIC-21).
Wired end-to-end: the auth screens hit real endpoints and a real `app_users` row is
created. Google sign-in is deferred ([AIC-30]).

**Source of truth:**
- Schema: `server/src/db/migrations/011_app_users.sql` (`app_users`, case-insensitive unique email)
- Backend: `server/src/auth/` (`passwords.ts` bcrypt, `tokens.ts` JWT, `user-store.ts`, `auth-service.ts`), `server/src/routes/auth.ts`, `server/src/middleware/auth.ts`
- Frontend: `web/src/app/Auth.tsx` (Signup/Login), `web/src/app/AuthGate.tsx`, `web/src/api.ts` (token attach), logout in `web/src/app/components.tsx`

**Lock-in tests:** `server/src/auth/auth-service.test.ts` (unit),
`server/src/auth/auth.integration.test.ts` (DB + HTTP).

---

## How it works today

- **Passwords** are bcrypt hashes (cost 12; `bcryptjs`, no native build). Never
  stored/logged in plaintext; API responses never include the hash.
- **Sessions** are our own JWT (`sub = userId`, 30-day expiry), signed with
  `JWT_SECRET` (required — `tokens.ts` throws if unset). Google (AIC-30) will reuse
  this same session.
- **Endpoints** (`/api/auth`):
  - `POST /signup {email, password, name}` → 200 `{token, user}`; 409 duplicate
    email (case-insensitive); 400 invalid email / password < 8 chars.
  - `POST /login {email, password}` → 200 `{token, user}`; 401 bad credentials.
  - `GET /me` (Bearer) → `{user}`; 401 without a valid token.
  - `POST /change-password {currentPassword, newPassword}` (Bearer) → 200 `{ok}`;
    401 if the current password is wrong; 400 if the new one is < 8 chars. Verifies
    the current password (`findByIdWithHash` + bcrypt) before `updatePassword`.
- **`requireAuth`** middleware verifies the bearer JWT and sets `req.userId`.
- **Frontend**: Signup/Login POST to the endpoints, store the JWT in localStorage
  (`aic_auth_token`), and `api()` attaches it as a bearer on non-admin `/api` calls.
  `AuthGate` bounces signed-in routes (`/app*`, `/onboarding`, `/connect`,
  `/review`, `/checkout`) to `/login` when there's no token; the app header has a
  logout.

## Not yet
- **Forgot/reset password** screens exist (frontend-only) but aren't wired — needs
  an email sender (Resend). Deferred; operator can reset manually in P0.
- **User ↔ customer link**: `app_users.customer_id` is nullable and set later
  during onboarding (not yet wired).
- No rate-limiting / lockout / email verification yet (P0 scope).
