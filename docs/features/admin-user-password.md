# Admin sets a user's password

**Status:** live (AIC-192). "שינוי סיסמה" on the admin **משתמשים** page.

**Source of truth:**
- Rules: `AuthService.setPasswordByAdmin` (`server/src/auth/auth-service.ts`)
- Route: `POST /admin/users/:id/password` (`server/src/routes/admin.ts`)
- UI: `web/src/admin/AdminUsers.tsx` (modal), copy in `web/src/strings.ts` (`password`)

**Lock-in tests:** `server/src/auth/auth-service.test.ts` (`setPasswordByAdmin`).

---

## Why it exists

A customer who loses their password has no self-serve way back in. The
"שכחתי סיסמה" and reset screens are **mockups**: the forgot screen reports a link
was sent when nothing is sent, and no route or email provider sits behind either.
Until that is built, an admin sets the password and hands it to the customer.

## Rules

- **Full admin only** (`requireFullAdmin`), the gate that also guards managing
  operators. Setting a password is account takeover by design; an operator who
  can archive an ad should not be able to sign in as the customer. An operator
  sees "רק מנהל מלא יכול לשנות סיסמה של משתמש".
- **Never an impersonation token** — refused by `requireAdmin` on every admin route.
- **No current password required** — the customer it exists for has lost theirs.
- **At least 8 characters, at most 72 bytes.** bcrypt reads only the first 72
  bytes and silently ignores the rest, so a longer password would "work" while
  only its prefix is checked. Bytes, not characters: a Hebrew letter is two.
- **The secret goes nowhere but the hash.** Not logged, not echoed, not in the
  audit row. `logAdminAction` records `user.password.set` — who, whose, when. The
  modal clears the fields the moment the save succeeds, and opens empty for
  every user.
- **Nothing is sent to the customer.** The admin hands the password over.

## Known gaps

- **Existing sessions survive.** Sessions are stateless 30-day JWTs, so anyone
  already signed in on another device stays signed in. Revoking them needs a
  token version on `app_users`.
- **Signup has no 72-byte ceiling.** Only this route enforces it; a signup with a
  longer password is accepted and only its first 72 bytes are ever checked.
- **Self-serve reset is still fake** — see "Why it exists". The forgot screen
  should at minimum stop claiming a link was sent.
