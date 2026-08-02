import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAdmin } from "../middleware/admin.js";
import {
  buildCampaignReadout,
  listCampaignsForAdmin,
} from "../services/readout.js";
import { ControlService, PgControlStore } from "../execution/control-service.js";

// Internal admin surfaces. Reads only from our DB (insight_snapshots) — never a
// live Meta call at render time (AIC-7).
export const adminRouter = Router();

adminRouter.use(requireAdmin);

const controls = new ControlService(new PgControlStore(pool));

// Emergency controls (AIC-14): immediate per-account kill-switches, no deploy.
const CONTROL_ACTIONS = {
  disable_automation: (id: string) => controls.disableAutomation(id),
  enable_automation: (id: string) => controls.enableAutomation(id),
  freeze_execution: (id: string) => controls.freezeExecution(id),
  unfreeze_execution: (id: string) => controls.unfreezeExecution(id),
  mark_unmanaged: (id: string) => controls.markUnmanaged(id),
  pause_management: (id: string) => controls.pauseManagement(id),
} as const;

adminRouter.post("/campaigns/:id/controls", async (req, res) => {
  const action = req.body?.action as keyof typeof CONTROL_ACTIONS | undefined;
  if (!action || !(action in CONTROL_ACTIONS)) {
    res.status(400).json({ error: "unknown control action", allowed: Object.keys(CONTROL_ACTIONS) });
    return;
  }
  await CONTROL_ACTIONS[action](req.params.id);
  res.json({ ok: true, action });
});

adminRouter.get("/campaigns", async (_req, res) => {
  const campaigns = await listCampaignsForAdmin(pool);
  res.json({ campaigns });
});

adminRouter.get("/campaigns/:id/readout", async (req, res) => {
  const readout = await buildCampaignReadout(pool, req.params.id);
  if (!readout) {
    res.status(404).json({ error: "campaign not found" });
    return;
  }
  res.json(readout);
});
