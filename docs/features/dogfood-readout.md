# Dogfood readout (admin)

**Status:** live (code) — the internal admin screen that renders a managed
campaign's performance from our own `insight_snapshot` data (AIC-7). The
reconciliation-against-Ads-Manager milestone is gated on real ingestion (a live
System User token + linked campaign).

**Source of truth:**
- Service: `server/src/services/readout.ts` (`buildCampaignReadout`, `deltaPct`, `listCampaignsForAdmin`)
- Route: `server/src/routes/admin.ts` (mounted at `/api/admin` in `server/src/app.ts`)
- Guard: `server/src/middleware/admin.ts` (`requireAdmin`)
- Screen: `web/src/admin/Readout.tsx` (route `/admin/readout` in `web/src/App.tsx`); copy in `web/src/strings.ts` (`admin`)

**Lock-in tests:** `server/src/services/readout.test.ts` (deltaPct),
`server/src/services/readout.integration.test.ts` (DB + HTTP; self-skips without
`DATABASE_URL`).

---

## How it works today

`GET /api/admin/campaigns` lists managed campaigns; `GET /api/admin/campaigns/:id/
readout` returns the readout. `buildCampaignReadout` reads **only** from the DB —
no live Meta call at render time:
- campaign name + status from `managed_campaigns`;
- current + previous 7-day totals via `PgSnapshotStore.campaignTotals`
  (`rollingPeriods` windows, UTC);
- per-creative rows from creative-grain snapshots in the current window, ordered
  by spend desc;
- period-over-period deltas via `deltaPct` (NULL when there's no baseline — never
  a fake +100%).

Money renders through `formatShekel`; a NULL CPL shows "—" rather than 0. The
`/admin` router is behind `requireAdmin` (a shared `ADMIN_TOKEN` bearer when set;
open in local dev). The screen is the reference the customer Home dashboard (P0.5)
mirrors in plain Hebrew.

## Not done here (gated)
Reconciliation vs Ads Manager for the same window needs real ingested snapshots
(live token + linked campaign). Verified so far against seeded snapshots: the
service + endpoint return correct totals/deltas/per-creative, and the screen
renders them (status/spend/leads/CPL + per-creative table).
