# Customer recommendations (AIC-23)

**Status:** live. The customer reads a recommendation in plain Hebrew and
**approves** or **defers** it. It is a thin wrapper over systems already built —
the deterministic explainer (AIC-10) and the safe-execute pipeline (AIC-12/13) —
never a new decision path.

**Source of truth:**
- Service: `server/src/services/customer-recommendations.ts`
- Routes: `server/src/routes/app.ts` — `GET /api/app/recommendations`,
  `GET /api/app/recommendations/:id`,
  `POST /api/app/recommendations/:id/approve`,
  `POST /api/app/recommendations/:id/dismiss` (all `requireAuth`)
- Client: `web/src/api.ts` (`listRecommendations`/`getRecommendation`/`approveRecommendation`/`dismissRecommendation`)
- Screens: `web/src/app/Recommendations.tsx` (list + detail)

**Lock-in tests:** `server/src/services/customer-recommendations.integration.test.ts`
(list + figures, cross-customer scoping, dismiss transition, no-token
"unavailable"). The full approve→execute pipeline is covered by
`execution/safe-executor.test.ts` (fakes) and the AIC-1 live write-test.

---

## What the customer sees (PRD §18)

For each `proposed` recommendation: the **title** (by type), the **why** — the
deterministic `explain()` text built server-side from the structured record so
the numbers can never drift — and, for a budget change, the exact **current →
proposed** daily budget plus the **maximum spend impact**. Actions: **אישור** /
**לא עכשיו**. The list also shows past changes ("מה כבר עשינו") from
`action_history`, and an honest empty state when there's nothing pending.

## Approve → the pipeline (never re-implemented here)

`approveCustomerRecommendation` is ownership-checked (the rec must belong to the
caller's campaign) and only acts on a `proposed` rec. It transitions
proposed → approved, then hands off to `SafeExecutor.execute` (AIC-12):
re-verify → sync live state → external-change check → budget-safety (AIC-13) →
execute → read-back → log. The customer never sees that machinery — only:

| pipeline outcome | customer sees |
| --- | --- |
| `executed` | "השינוי בוצע" + what we did |
| `aborted` (access lost / stopped / external change) | held message, rec stays approved to retry |
| `failed` | honest "we couldn't make the change" |

`buildCustomerExecutor` returns `null` when `META_SYSTEM_USER_TOKEN` is unset —
the route then answers **503** and the rec is left untouched (never approved into
a dead end). **לא עכשיו** transitions proposed → dismissed; no change.

## Scoping & safety

Every route resolves the caller's single managed campaign from the JWT; a rec is
only visible/actionable if `rec.campaignId` matches it — no cross-customer
access. The explanation is deterministic (template), so no LLM is required;
`explainWithLlm` (AIC-10) can smooth it later without changing any number.

## Home surface

`GET /api/app/overview` returns `pendingRecommendations` (count of `proposed`).
Home shows the nav badge and, when > 0, a "recommendation waiting" card linking
here instead of the no-action reassurance.
