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

## Writers (who puts rows in)

`action_history` is no longer written only by the execute pipeline. Current
writers, all using the same field set:

| Writer | action_type values | human_involved |
| --- | --- | --- |
| `SafeExecutor` (AIC-12), via `completeExecution` | `pause_creative`, `increase_budget`, `decrease_budget`, `replace_creative` | depends on approval |
| Launch gate (AIC-53) | `activate_campaign` | true |
| Builder / additions (AIC-50/63) | `create_campaign`, `create_ad_set`, `create_ad`, `activate_ad_set`, `activate_ad` | true |
| **Manual controls (AIC-66)** | `pause_ad`, `pause_ad_set`, `resume_ad`, `resume_ad_set`, `archive_ad`, `archive_ad_set`, `delete_ad`, `delete_ad_set` | always true |

Every `action_type` needs a `SUMMARY_HE` entry or `condense()` renders the
generic fallback. Note AIC-66's manual `pause_ad` is deliberately **not** the
same key as the engine's `pause_creative`, even though both end in a paused ad:
the condensed history reads better when "you paused this" and "we recommended
pausing this" don't share a label — reinforcing what `human_involved` already
records. See [manual-controls.md](manual-controls.md).
