import { describe, it, expect } from "vitest";
import { FakeMetaClient } from "./client.js";
import { InMemorySnapshotStore } from "./snapshot-store.js";
import {
  IngestionService,
  runIngestionTick,
  type ManagedCampaignRef,
} from "./ingestion-service.js";
import { CollectingLogger } from "../services/logger.js";
import { rollingPeriods, todayPeriod } from "./scheduled-ingestion.js";
import type { RawInsightRow } from "./types.js";

const PERIOD = { start: "2026-07-27", end: "2026-08-02" };
const PREV = { start: "2026-07-20", end: "2026-07-26" };

function campaignRows(spend: string, leads: string): RawInsightRow[] {
  return [
    {
      grain: "campaign",
      objectId: "meta_camp_1",
      spend,
      actions: [
        {
          action_type: "onsite_conversion.messaging_conversation_started",
          value: leads,
        },
      ],
    },
  ];
}

describe("IngestionService.ingestCampaign", () => {
  it("normalizes and upserts snapshots", async () => {
    const client = new FakeMetaClient();
    client.setInsights("meta_camp_1", campaignRows("180.00", "5"));
    const store = new InMemorySnapshotStore();
    const svc = new IngestionService(store, client);

    const n = await svc.ingestCampaign(
      { id: "camp-1", metaCampaignId: "meta_camp_1" },
      PERIOD,
    );
    expect(n).toBe(1);
    const snap = [...store.rows.values()][0];
    expect(snap.spendAgorot).toBe(18000);
    expect(snap.leads).toBe(5);
    expect(snap.cplAgorot).toBe(3600);
  });

  it("is idempotent per (campaign, grain, object, period) — re-run doesn't duplicate", async () => {
    const client = new FakeMetaClient();
    client.setInsights("meta_camp_1", campaignRows("180.00", "5"));
    const store = new InMemorySnapshotStore();
    const svc = new IngestionService(store, client);

    await svc.ingestCampaign({ id: "camp-1", metaCampaignId: "meta_camp_1" }, PERIOD);
    await svc.ingestCampaign({ id: "camp-1", metaCampaignId: "meta_camp_1" }, PERIOD);
    expect(store.rows.size).toBe(1);
  });

  it("computes period-over-period totals", async () => {
    const client = new FakeMetaClient();
    const store = new InMemorySnapshotStore();
    const svc = new IngestionService(store, client);

    client.setInsights("meta_camp_1", campaignRows("180.00", "5"));
    await svc.ingestCampaign({ id: "camp-1", metaCampaignId: "meta_camp_1" }, PERIOD);
    client.setInsights("meta_camp_1", campaignRows("200.00", "4"));
    await svc.ingestCampaign({ id: "camp-1", metaCampaignId: "meta_camp_1" }, PREV);

    const cmp = await svc.periodComparison("camp-1", PERIOD, PREV);
    expect(cmp.current).toMatchObject({ spendAgorot: 18000, leads: 5, cplAgorot: 3600 });
    expect(cmp.previous).toMatchObject({ spendAgorot: 20000, leads: 4, cplAgorot: 5000 });
  });
});

describe("runIngestionTick (reliability)", () => {
  it("isolates a failing campaign: logs it and keeps going", async () => {
    const client = new FakeMetaClient();
    client.setInsights("meta_ok", campaignRows("100.00", "2"));
    const store = new InMemorySnapshotStore();
    const ingestion = new IngestionService(store, client);
    const logger = new CollectingLogger();

    const campaigns: ManagedCampaignRef[] = [
      { id: "good", metaCampaignId: "meta_ok", connectionId: null },
      { id: "bad", metaCampaignId: "meta_missing", connectionId: null }, // no fixture → 0 rows, still ok
    ];

    // Force the second campaign to throw.
    const throwing = new IngestionService(store, {
      ...client,
      getInsights: async (cid: string) => {
        if (cid === "meta_missing") throw new Error("Meta 500");
        return client.getInsights(cid, PERIOD);
      },
    } as unknown as FakeMetaClient);

    const summary = await runIngestionTick({
      campaigns,
      ingestion: throwing,
      period: PERIOD,
      logger,
    });

    expect(summary.ok).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.snapshots).toBe(1);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0].msg).toContain("bad");
  });

  it("skips campaigns not yet linked to a Meta campaign", async () => {
    const store = new InMemorySnapshotStore();
    const ingestion = new IngestionService(store, new FakeMetaClient());
    const logger = new CollectingLogger();
    const summary = await runIngestionTick({
      campaigns: [{ id: "unlinked", metaCampaignId: null, connectionId: null }],
      ingestion,
      period: PERIOD,
      logger,
    });
    expect(summary).toEqual({ ok: 0, failed: 0, snapshots: 0 });
  });

  // The today window is ingested as its OWN snapshot row so the customer
  // dashboard can show today, while the engine keeps reading only the
  // complete-days window. Real bug this fixes: 3 leads arrived today and the
  // headline still read "1 פניות" because nothing ever ingested today.
  it("ingests each extra window as its own snapshot alongside the primary one", async () => {
    const client = new FakeMetaClient();
    client.setInsights("meta_ok", campaignRows("100.00", "2"));
    const store = new InMemorySnapshotStore();
    const logger = new CollectingLogger();
    const seen: string[] = [];
    const recording = new IngestionService(store, {
      ...client,
      getInsights: async (cid: string, p: { start: string; end: string }) => {
        seen.push(`${p.start}..${p.end}`);
        return client.getInsights(cid, p as never);
      },
    } as unknown as FakeMetaClient);

    const summary = await runIngestionTick({
      campaigns: [{ id: "c1", metaCampaignId: "meta_ok", connectionId: null }],
      ingestion: recording,
      period: PERIOD,
      extraPeriods: [{ start: "2026-08-12", end: "2026-08-12" }],
      logger,
    });

    expect(seen).toEqual([`${PERIOD.start}..${PERIOD.end}`, "2026-08-12..2026-08-12"]);
    expect(summary.ok).toBe(1);
    expect(summary.snapshots).toBe(2); // one row per window
  });

  // The extra window is display-only. Its failure must never mark the
  // campaign failed — the engine's data (the primary window) landed fine.
  it("an extra-window failure is logged but never fails the campaign", async () => {
    const client = new FakeMetaClient();
    client.setInsights("meta_ok", campaignRows("100.00", "2"));
    const store = new InMemorySnapshotStore();
    const logger = new CollectingLogger();
    const flaky = new IngestionService(store, {
      ...client,
      getInsights: async (cid: string, p: { start: string; end: string }) => {
        if (p.start === "2026-08-12") throw new Error("Meta 500 on today");
        return client.getInsights(cid, p as never);
      },
    } as unknown as FakeMetaClient);

    const summary = await runIngestionTick({
      campaigns: [{ id: "c1", metaCampaignId: "meta_ok", connectionId: null }],
      ingestion: flaky,
      period: PERIOD,
      extraPeriods: [{ start: "2026-08-12", end: "2026-08-12" }],
      logger,
    });

    expect(summary).toMatchObject({ ok: 1, failed: 0, snapshots: 1 });
    expect(logger.errors).toHaveLength(1);
  });
});

describe("todayPeriod vs rollingPeriods — the engine never sees a partial day", () => {
  const REF = new Date("2026-08-12T09:00:00Z");

  it("todayPeriod is a single-day window on the reference date", () => {
    expect(todayPeriod(REF)).toEqual({ start: "2026-08-12", end: "2026-08-12" });
  });

  it("the engine's current window STOPS at yesterday, never overlapping today", () => {
    const { current, previous } = rollingPeriods(REF);
    expect(current.end).toBe("2026-08-11"); // yesterday, not today
    expect(current.end < todayPeriod(REF).start).toBe(true);
    expect(previous.end < current.start).toBe(true); // and the two windows are disjoint
  });
});
