# Action history surface

**Status:** live — the internal per-campaign audit trail, plus a condensed
jargon-free projection for later customer reuse (AIC-15).

**Source of truth:** `server/src/services/action-history.ts`; routes in
`server/src/routes/admin.ts` (`GET /api/admin/campaigns/:id/history`).
**Lock-in tests:** `server/src/services/action-history.integration.test.ts`.

---

## How it works today

Reads **only** from `action_history` (written by the execute pipeline, AIC-12) — no
reconstruction. `listCampaignActionHistory(pool, campaignId)` returns the full PRD
§23 field set (what / previous → new / why / who approved / human involved / when /
result) **newest-first**; `listCustomerActionHistory` does the same across a
customer's campaigns. Each entry distinguishes **automated vs human-involved**
(`humanInvolved`).

`condense(entries)` produces the jargon-free customer projection: `{ when, summary
(plain Hebrew per action type), automated, result }` — no agorot, IDs, or Ads
Manager terms. The admin route serves the full list, or the condensed projection
with `?condensed=true`. This is the surface the customer-side history (P0.5) reuses.
