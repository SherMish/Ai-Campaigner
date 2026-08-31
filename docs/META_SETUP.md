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

## Our identifiers (verified live 2026-08-12)

Record these once; the onboarding call needs the first one verbatim.

| Thing | Value |
| --- | --- |
| **Business Portfolio** (give this to customers) | **`2491237118040524`** — name: **"AI Campaigner"** |
| Meta app | `1762330388097443` — name: "AI Campaigner" |
| System User | `122103498795426897` — name: **"AdPilot backend"** |

> ⚠️ **Naming trap.** The Business Portfolio and the app share the name "AI
> Campaigner", but a customer adds a **partner by Business Portfolio ID**, not by
> name. Give them the number. (Historic note: older docs/memory recorded the
> System User as `61592806930741` and once mis-identified the portfolio as
> `467328257419676` / "Liam Aboros" — that one is the **customer-side** business
> that owns Pisga's ad account `act_2181076988590009`, not ours. Use the table.)

---

## The three layers of access (all three must be satisfied)

This is the part that bit us in production. Meta access is **not** one switch — it
is three independent layers, and the Business Settings UI can look completely
correct while the backend still has zero access:

| # | Layer | Who does it | Verify with |
| --- | --- | --- | --- |
| 1 | Asset **shared to our Business Portfolio** | the **customer**, in *their* Business Settings | `GET /{business}/client_pages` (or `client_ad_accounts`) |
| 2 | Asset **assigned to the System User** inside our portfolio | **us** | `GET /me/accounts` (Pages); `GET /{ad_account}/assigned_users?business={business}` (ad accounts — Meta has no self-scoped "which ad accounts am I on" edge, so this is checked from the object's own side instead) |
| 3 | Token carries the right **scopes** | **us**, *at token-generation time* | `GET /debug_token` |

**Layer 3 is the trap.** A System User token's scopes are **frozen when the token
is minted**. Assigning new asset *types* later (e.g. adding Page access to a token
originally minted for ads only) does **not** retroactively add scopes — the token
keeps failing with `(#100) … requires the 'pages_read_engagement' permission`
forever, no matter how correct layers 1 and 2 look. **Adding a new asset type means
regenerating the token and updating the Railway secret.**

---

## One-time setup

### 1. Business Portfolio + Meta app **[operator]**
- Confirm our **Business Portfolio** (Business Manager) at business.facebook.com.
- Create/confirm the **Meta app** (business type) the System User token belongs to,
  with the **Marketing API** product added.
- Record the **App ID** (public) and keep the **App Secret** as a secret.
- **App Mode must be Live, not Development** — found live 2026-08-12: creating an
  ad creative from an *existing* Page post (`object_story_id`, the "use an
  existing post" flow) fails with `code 100, subcode 1885183` — "Ads creative
  post was created by an app that is in development mode. It must be in public
  to create this ad." — while our app is in Development mode. Fresh
  image/video uploads (`createCreativeFromUpload`, its own `object_story_spec`)
  are unaffected; only the existing-post path is gated. Toggle App Mode →
  Live in developers.facebook.com (may require Basic Settings — privacy policy
  URL, icon, category — to be filled in first).

### 2. System User + token **[operator]**
- Business settings → **Users → System Users** → add a System User (admin role for
  P0 operations).
- **Generate token** for that System User, selecting our app, with scopes:
  - `ads_read` — pull campaigns + Insights
  - `ads_management` — apply approved changes (status/budget), create campaigns/ad
    sets/ads
  - `business_management` — read/manage asset assignments
  - **`pages_show_list`** — required for `/me/accounts` to return Pages at all
  - **`pages_read_engagement`** — required for the connection health check's direct
    `GET /{page_id}` read
  - `instagram_basic` (or current equivalent) when IG creatives are touched
- **Tick the Page scopes even if Page features aren't live yet.** Minting an
  ads-only token and adding Pages later costs a full token regeneration + secret
  rotation (see the layer-3 trap above) — that is exactly what happened on
  2026-08-12 and it broke a customer-facing feature.
- Copy the token **once** — store it as a secret immediately (see §4).

### 3. Asset assignment **[operator]**
For each managed customer (and for Pisga first):
1. The customer grants our Business partner access to: **ad account** (+ **Page**,
   **Instagram** where creatives are touched). See the per-customer runbook below
   for the exact clicks.
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
| `META_SYSTEM_USER_TOKEN` | System User token — `ads_read`+`ads_management`+`business_management`, **plus `pages_show_list`+`pages_read_engagement`** for Page-dependent features, **plus `instagram_basic`** (AIC-156, added 2026-08-31) to read a customer's Instagram media (secret). Scopes are frozen at generation; adding an asset type later requires a new token. `instagram_basic` is only OFFERED in the token generator once the app carries an Instagram use case — the permission list is driven by the app's use cases, not by what you type. |
| `META_GRAPH_VERSION` | Graph API version, e.g. `v21.0` |

---

---

## Per-customer onboarding (the call)

Manual, human-led. No customer-facing OAuth in P0.

**Before the call, have ready:** our Business Portfolio ID **`2491237118040524`**.

**Customer needs:** a Meta Business with an active ad account, a Facebook Page (+
WhatsApp number connected to it, for WhatsApp-lead ads), and admin on their own
Business Settings.

### 1. Customer grants partner access **[customer, their Business Settings]**
Business Settings → **Accounts** → the asset type (**Ad Accounts** or
**Pages**) → the specific asset → **Assign Partner** → **Business Partner** →
enter **`2491237118040524`** → select the tasks below → give access.

(Corrected 2026-08-15, verified live: an earlier version of this doc
described a single global **Partners → Add** flow — that path doesn't match
what Meta's current UI actually shows. Partners are granted **per asset**,
under **Accounts**, not through one global add-a-partner screen.)

Repeat per asset that needs sharing:

| Asset | Minimum task | Why |
| --- | --- | --- |
| **Ad account** (required) | Manage campaigns / Advertise | read Insights, apply approved budget + status changes |
| **Page** (required for WhatsApp-lead ads + add-content) | **Advertise**, plus enough to *read* the Page — grant **Manage** if the health check can't read it with Advertise alone | ad creation references the Page (`promoted_object.page_id`); the connection health check reads the Page directly |
| **Instagram** (if IG creatives are used) | as applicable | IG creative operations — **but see the Instagram section below: assignment alone does not make it visible** |

⚠️ **Sharing the ad account alone is not enough.** That was GelNails' state for
months: ads ran fine, but every Page-dependent feature (add-content, AIC-63) was
silently broken and the connection health check correctly reported the gap the
moment `page_id` was filled in.

Also confirm their **WhatsApp number is linked to the Page**.

### 2. We assign the shared assets to the System User **[operator, our Business Settings]**
The shared assets now appear under **Partners** in the AI Campaigner portfolio
(`2491237118040524`).

Users → **System Users** → **"AdPilot backend"** → **Assign Assets** → select the
ad account **and the Page** → grant the tasks → Save.
*(Equivalent path: Accounts → Pages → the Page → Assigned Users → add "AdPilot backend".)*

⚠️ **This is a separate step from step 1.** A Page shared to the business but not
assigned to the System User is invisible to the backend.

### 3. Confirm the token covers the asset types **[operator]**
Run the verification block below. If the Page checks fail with
`requires the 'pages_read_engagement' permission` **even though steps 1–2 are done**,
the token predates Page support → **regenerate it** (§2) with `pages_show_list` +
`pages_read_engagement` and update `META_SYSTEM_USER_TOKEN` in Railway.

### 4. Add them in the AI Campaigner console **[operator]**
Create the customer (business info, offer, budget, contact), then open
**Admin → Customers → the customer → "אשף חיבור Meta"** (`/admin/onboarding/:id`,
AIC-101) to link their ad account + Page + campaign. The wizard walks steps 1–5
of this runbook on one screen — the same partner-grant script as step 1 above,
a live per-asset access check (steps 2–3, using the exact three-layer classifier
this doc describes), the provisioning form (step 4), and a final connection
verify (step 5) — so an operator can run the whole call without leaving the
page or falling back to hand-written SQL. It refuses to save a `page_id` the
backend can't read (re-verifying live at save time, never trusting an earlier
check), which is the AIC-68/AIC-69 ordering rule below enforced in code, not
just in this doc. See [ops-console.md](features/ops-console.md#meta-connection-onboarding-wizard-aic-101--aic-68).

### 5. Verify
Ingestion pulls their campaign within a tick — spend / leads / CPL appear in the
admin readout. Health ≠ `ok` → a grant or assignment is incomplete; re-run the
checks below.

---

## Verifying access (copy-paste)

Read-only. `TOKEN` = the System User token; run from the repo root.

```bash
TOKEN=$(grep '^META_SYSTEM_USER_TOKEN=' server/.env | cut -d= -f2-); VER=v21.0

# Layer 3 — what scopes does this token actually carry?
curl -s "https://graph.facebook.com/$VER/debug_token?input_token=$TOKEN" \
  -H "Authorization: Bearer $TOKEN"

# Layer 1 — did the customer's share land in OUR portfolio?
curl -s "https://graph.facebook.com/$VER/2491237118040524/client_pages?fields=id,name" \
  -H "Authorization: Bearer $TOKEN"
curl -s "https://graph.facebook.com/$VER/2491237118040524/client_ad_accounts?fields=id,name" \
  -H "Authorization: Bearer $TOKEN"

# Layer 2 — can the System User actually reach the Page?
curl -s "https://graph.facebook.com/$VER/me/accounts?fields=id,name,tasks" \
  -H "Authorization: Bearer $TOKEN"

# Layer 2 (ad account) — is our System User in THIS account's own assigned_users list?
curl -s "https://graph.facebook.com/$VER/act_<AD_ACCOUNT_ID>/assigned_users?fields=id,name,tasks&business=2491237118040524" \
  -H "Authorization: Bearer $TOKEN"

# The exact call the connection health check makes (must return the Page, not error 100)
curl -s "https://graph.facebook.com/$VER/<PAGE_ID>?fields=id,name" \
  -H "Authorization: Bearer $TOKEN"

# Ad account reachable?
curl -s "https://graph.facebook.com/$VER/act_<AD_ACCOUNT_ID>?fields=name,account_status,business" \
  -H "Authorization: Bearer $TOKEN"
```

**Reading the results**

| Symptom | Layer at fault | Fix |
| --- | --- | --- |
| `client_pages` empty | 1 | customer hasn't shared the Page — redo step 1 |
| `client_pages` has it, `/me/accounts` empty, Page read → error 100 | 2 **or** 3 | assign the Page to the System User (step 2); if already assigned, the token lacks Page scopes → regenerate (step 3) |
| `client_ad_accounts` has it, `assigned_users` doesn't include our System User id, account read → error 100 | 2 **or** 3 | assign the ad account to the System User (step 2); if already assigned, the token lacks `ads_*` scopes → regenerate (step 3) |
| `debug_token` scopes lack `pages_*` | 3 | regenerate the token; asset assignment alone will never fix this |
| Page/ad-account read succeeds | ✅ | safe to set `meta_connections.page_id` / provision the ad account |

**Order matters:** confirm the Page read succeeds *before* writing `page_id` into
`meta_connections`. A `page_id` the backend can't read flips the whole connection to
`revoked` (worst-health-wins), which removes the campaign from
`listEligibleForGeneration` and **silently stops the recommendation engine** — a far
worse outcome than the feature that needed `page_id`. See
[AIC-69](https://linear.app/pisga-app/issue/AIC-69).

## Verification checklist (operator, after setup)
- [ ] System User token minted **with Page scopes** and stored as a Railway secret
      (not in repo/client).
- [ ] Pisga's own ad account assigned to the System User and **confirmed readable**
      (campaigns + Insights return) — this is the AIC-1 read check on our own account.
- [ ] Page shared (layer 1) **and** assigned to the System User (layer 2) **and**
      readable with the current token (layer 3) — all three verified with the block
      above, not assumed from the Business Settings UI.
- [ ] Instagram assigned and access confirmed (or the specific limitation written down).
- [ ] Token-lifecycle expectations understood: revocable; the app detects + surfaces
      loss (AIC-5).

## If AIC-1 finds an access-tier gate
Record here the exact tier required (e.g. Advanced Access + Business Verification),
what it gates (external partner-owned accounts only, vs our own), and the estimated
lead time — and raise the priority of
[AIC-25](https://linear.app/pisga-app/issue/AIC-25) accordingly. Pisga's own account
is unaffected (same business, Standard Access).

---

## Instagram: assignment is not connection (2026-08-30)

Instagram cost an hour that the other asset types did not, because Business
Settings can show an Instagram account fully connected while the API sees
nothing. The three layers above still apply, and Instagram adds one more
condition on top.

**What we read.** `{page}?fields=instagram_business_account`. Confirmed live:
this needs **no Page token and no `instagram_*` scope** — our System User token
carries none and reads it fine. The picker also asks
`{ad_account}/instagram_accounts`, an older link that is real but empty for
accounts connected the modern way; querying only that edge is what made the
wizard show an empty dropdown for a correctly-configured account.

**The trap.** An Instagram account can be:

- assigned to our System User (Business Settings → System Users → Assigned
  assets → "Full access"), **and**
- connected to the Page in Business Settings → Pages → Connected assets,

and still be invisible to us — because neither of those is the link the Graph
API exposes on the Page. Observed exactly this with `liam_handstylist`: both
boxes ticked in Meta, every Page-side edge empty, and the only edge that would
have listed it refused with:

```
(#10) requires that you can VIEW_INSTAGRAM_ACCOUNTS for this business account
```

**The fix that works.** Connect it from **Instagram's own side**: Instagram app
→ Settings → Business tools → *Connect to Facebook* → pick the Page. That
populates `instagram_business_account`, and it appeared in our picker
immediately with no token change. The alternative — granting
`VIEW_INSTAGRAM_ACCOUNTS` and regenerating the token with `instagram_basic` —
is more moving parts and hits the layer-3 trap.

**Not an Instagram account:** `page_backed_instagram_accounts`. Meta
auto-creates this shadow profile so a Page can run Instagram placements without
a real account. It has no username and nobody logs into it; the picker
deliberately ignores it rather than offering an id an operator cannot identify.

### Three kinds of "ad account" in Instagram's connect flow

Instagram's *Connect to Facebook* screen offers a choice that matters:

| shown as | what it is | usable by us |
| --- | --- | --- |
| **Meta ad account** | a real ad account in a Business portfolio | **yes** — the only one |
| Instagram ad account | auto-created by boosting from the Instagram app | no |
| Facebook ad account | auto-created by boosting from a Page | no |

The last two are a separate lightweight surface, not a lesser tier: they cannot
be shared by partner access or driven through the Marketing API. Both refuse us
with `(#200) Ad account owner has NOT grant ads_management or ads_read`, which
is not a permission anyone can grant — it is the wrong kind of account. **Always
pick the Meta ad account.** Spend on a boost account is invisible to the product
entirely: no insights, no recommendations, and it will never show up in any
number we report.
