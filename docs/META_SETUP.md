# Meta setup runbook (Standard Access)

**Status:** live — the durable, documented version of the one-time Meta-side
configuration the backend needs (AIC-3). The empirical probe of whether our
access tier can manage a **partner-owned** account is [AIC-1](https://linear.app/pisga-app/issue/AIC-1);
this runbook records the setup AIC-1 uses and whatever tier it proves out.

**Source of truth:** this doc + the secrets actually set in Railway (never in the
repo). The code that *consumes* this setup is the Meta client and connection
service (AIC-5).

> **Operator actions.** The steps marked **[operator]** happen in Meta's web UI
> and require a person with admin on the Business Portfolio — they cannot be done
> from code. The app only ever *consumes* the resulting token + asset IDs.

---

## The access model (accurate framing)

- The customer grants **our** Business Portfolio **partner access** to the assets
  we need (ad account, and — where we touch creatives — Page + Instagram).
- We assign those shared assets to **our System User**.
- The backend operates them with the **System User token**, **subject to Meta's
  required Marketing API permissions / access tier.**
- **No customer-facing OAuth in P0.** (That's a P1 option.)

Partner access + System User solve *how the customer hands us their assets*. They
do **not** by themselves guarantee our app's Marketing API **access tier** may
operate a partner-owned account — that is the separate question AIC-1 answers
empirically. For **Pisga's own** account (same business as ours) the assets can be
assigned to the System User and developed against under **Standard Access** — no
Advanced Access, no review — which unblocks P0.1–P0.3 immediately.

---

## One-time setup

### 1. Business Portfolio + Meta app **[operator]**
- Confirm our **Business Portfolio** (Business Manager) at business.facebook.com.
- Create/confirm the **Meta app** (business type) the System User token belongs to,
  with the **Marketing API** product added.
- Record the **App ID** (public) and keep the **App Secret** as a secret.

### 2. System User + token **[operator]**
- Business settings → **Users → System Users** → add a System User (admin role for
  P0 operations).
- **Generate token** for that System User, selecting our app, with scopes:
  - `ads_read` — pull campaigns + Insights
  - `ads_management` — apply approved changes (status/budget)
  - `business_management` — manage asset assignments where needed
  - add `pages_read_engagement` / `instagram_basic` (or current equivalents) when
    creative operations require Page/IG access
- Copy the token **once** — store it as a secret immediately (see §4).

### 3. Asset assignment **[operator]**
For each managed customer (and for Pisga first):
1. The customer grants our Business partner access to: **ad account** (+ **Page**,
   **Instagram** where creatives are touched).
2. In our Business settings, **assign** each shared asset to the **System User**
   with the task level we need (manage campaigns / view performance).
3. Record the asset IDs (`act_…`, page id, ig id) — these become the
   `meta_connection` / `ad_account` rows (AIC-5).

### 4. Token storage + rotation posture
- The token is **revocable, not permanent.** It is stored as a **secret** —
  Railway env var (`META_SYSTEM_USER_TOKEN`), never in the repo, never shipped to
  the client.
- The customer can **remove the partnership**, **change permissions**, or **Meta
  can invalidate** the token at any time. The app must therefore **detect and
  surface** loss of access (revoked / invalid / downgraded) and **stop executing
  actions** while access is lost — implemented in AIC-5, not here.
- Rotation: minting a new System User token and updating the secret is the
  rotation path; the connection health check (AIC-5) catches an invalidated token
  before it's used for a write.

### 5. Env vars the backend expects
Set in Railway (and mirrored in `server/.env.example` as placeholders):

| Var | Meaning |
| --- | --- |
| `META_APP_ID` | Our Meta app id (public) |
| `META_APP_SECRET` | App secret (secret) |
| `META_SYSTEM_USER_TOKEN` | System User token, `ads_read`+`ads_management` (secret) |
| `META_GRAPH_VERSION` | Graph API version, e.g. `v21.0` |

---

## Verification checklist (operator, after setup)
- [ ] System User token minted and stored as a Railway secret (not in repo/client).
- [ ] Pisga's own ad account assigned to the System User and **confirmed readable**
      (campaigns + Insights return) — this is the AIC-1 read check on our own account.
- [ ] Page + Instagram assigned and access confirmed (or the specific limitation
      written down).
- [ ] Token-lifecycle expectations understood: revocable; the app detects + surfaces
      loss (AIC-5).

## If AIC-1 finds an access-tier gate
Record here the exact tier required (e.g. Advanced Access + Business Verification),
what it gates (external partner-owned accounts only, vs our own), and the estimated
lead time — and raise the priority of
[AIC-25](https://linear.app/pisga-app/issue/AIC-25) accordingly. Pisga's own account
is unaffected (same business, Standard Access).
