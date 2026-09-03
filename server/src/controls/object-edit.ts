import type pg from "pg";
import { validateAdSetPatch, mergeTargeting, diffApplied, type AdSetPatch, type PatchProblem } from "../meta/ad-set-update.js";
import type { AdSetDetail } from "../meta/ad-set-detail.js";
import type { ControlActor } from "./manual-controls.js";

// AIC-185 — editing an ad set's audience, or an ad's name, from the customer's
// own dashboard.
//
// Same four beats as manual-controls' pause/resume, for the same reason:
//
//     validate → read → write → READ BACK AND COMPARE → log
//
// The read-back is not ceremony here. On 2026-09-02 an age of 20–35 was sent,
// Meta answered 200, and 18–65 was what it stored. Nothing in the response
// said so. An edit surface without a read-back is a surface that lies about
// the customer's own money.
//
// Ownership is the caller's job (assertOwnedByCampaign), exactly as it is for
// pause/resume: this module never trusts a Meta id on its own.

export type EditOutcome = "changed" | "invalid" | "not_found" | "failed" | "not_applied";

export interface EditResult {
  outcome: EditOutcome;
  problem?: PatchProblem;
  /** Populated on "not_applied": what Meta stored instead of what was asked. */
  mismatches?: Array<{ field: string; asked: string; stored: string }>;
  detail?: string;
  after?: AdSetDetail;
}

export interface AdSetEditWriter {
  getAdSetDetail(id: string): Promise<AdSetDetail | null>;
  /** The RAW targeting object, needed because the merge must preserve keys. */
  getAdSetRawTargeting(id: string): Promise<Record<string, unknown>>;
  updateAdSet(id: string, fields: { name?: string; targeting?: Record<string, unknown> }): Promise<void>;
}

async function log(deps: {
  pool: pg.Pool; campaignId: string; actionType: string; metaObjectId: string;
  actor: ControlActor; before: unknown; after: unknown; result: "success" | "failed"; what: string;
}): Promise<void> {
  await deps.pool.query(
    `INSERT INTO action_history
       (campaign_id, what, action_type, target_meta_id, previous_state, new_state, why, approved_by, human_involved, result)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9)`,
    [
      deps.campaignId, deps.what, deps.actionType, deps.metaObjectId,
      JSON.stringify(deps.before ?? {}), JSON.stringify(deps.after ?? {}),
      "", deps.actor.kind, deps.result,
    ],
  );
}

export async function editAdSet(deps: {
  pool: pg.Pool;
  writer: AdSetEditWriter;
  campaignId: string;
  metaAdSetId: string;
  patch: AdSetPatch;
  actor: ControlActor;
}): Promise<EditResult> {
  const { pool, writer, campaignId, metaAdSetId, patch, actor } = deps;

  const problem = validateAdSetPatch(patch);
  if (problem) return { outcome: "invalid", problem };

  let before: AdSetDetail | null;
  try {
    before = await writer.getAdSetDetail(metaAdSetId);
  } catch (e) {
    return { outcome: "not_found", detail: (e as Error).message };
  }
  if (!before) return { outcome: "not_found" };

  // Read the raw object so the merge preserves keys this code has never heard
  // of. Rebuilding targeting from a known field list is how an edit silently
  // turns off a setting nobody was discussing.
  const targetingTouched =
    patch.ageMin !== undefined || patch.ageMax !== undefined ||
    patch.genders !== undefined || patch.placement !== undefined || patch.cities !== undefined;

  let targeting: Record<string, unknown> | undefined;
  if (targetingTouched) {
    try {
      targeting = mergeTargeting(await writer.getAdSetRawTargeting(metaAdSetId), patch);
    } catch (e) {
      return { outcome: "failed", detail: (e as Error).message };
    }
  }

  const what = `עריכת קהל ${metaAdSetId}`;
  try {
    await writer.updateAdSet(metaAdSetId, { name: patch.name?.trim(), targeting });
  } catch (e) {
    await log({ pool, campaignId, actionType: "edit_ad_set", metaObjectId: metaAdSetId, actor, before, after: null, result: "failed", what });
    return { outcome: "failed", detail: (e as Error).message };
  }

  // The whole point. Meta answering 200 is not Meta applying the change.
  let after: AdSetDetail | null = null;
  try {
    after = await writer.getAdSetDetail(metaAdSetId);
  } catch {
    after = null;
  }
  if (!after) {
    await log({ pool, campaignId, actionType: "edit_ad_set", metaObjectId: metaAdSetId, actor, before, after: null, result: "failed", what });
    return { outcome: "failed", detail: "could not read the ad set back after the edit" };
  }

  const mismatches = diffApplied(patch, after);
  if (mismatches.length > 0) {
    await log({ pool, campaignId, actionType: "edit_ad_set", metaObjectId: metaAdSetId, actor, before, after, result: "failed", what });
    return { outcome: "not_applied", mismatches, after };
  }

  await log({ pool, campaignId, actionType: "edit_ad_set", metaObjectId: metaAdSetId, actor, before, after, result: "success", what });
  return { outcome: "changed", after };
}

export interface AdEditWriter {
  getAdName(id: string): Promise<string | null>;
  updateAd(id: string, fields: { name: string }): Promise<void>;
}

export async function editAdName(deps: {
  pool: pg.Pool;
  writer: AdEditWriter;
  campaignId: string;
  metaAdId: string;
  name: string;
  actor: ControlActor;
}): Promise<EditResult> {
  const { pool, writer, campaignId, metaAdId, name, actor } = deps;
  const trimmed = name.trim();
  if (!trimmed) return { outcome: "invalid", problem: "empty_name" };

  let before: string | null;
  try {
    before = await writer.getAdName(metaAdId);
  } catch (e) {
    return { outcome: "not_found", detail: (e as Error).message };
  }

  const what = `שינוי שם מודעה ${metaAdId}`;
  try {
    await writer.updateAd(metaAdId, { name: trimmed });
  } catch (e) {
    await log({ pool, campaignId, actionType: "edit_ad", metaObjectId: metaAdId, actor, before: { name: before }, after: null, result: "failed", what });
    return { outcome: "failed", detail: (e as Error).message };
  }

  let after: string | null = null;
  try {
    after = await writer.getAdName(metaAdId);
  } catch {
    after = null;
  }
  if (after !== trimmed) {
    await log({ pool, campaignId, actionType: "edit_ad", metaObjectId: metaAdId, actor, before: { name: before }, after: { name: after }, result: "failed", what });
    return { outcome: "not_applied", mismatches: [{ field: "name", asked: trimmed, stored: String(after) }] };
  }

  await log({ pool, campaignId, actionType: "edit_ad", metaObjectId: metaAdId, actor, before: { name: before }, after: { name: after }, result: "success", what });
  return { outcome: "changed" };
}
