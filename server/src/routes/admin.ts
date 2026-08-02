import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAdmin } from "../middleware/admin.js";
import {
  buildCampaignReadout,
  listCampaignsForAdmin,
} from "../services/readout.js";

// Internal admin surfaces. Reads only from our DB (insight_snapshots) — never a
// live Meta call at render time (AIC-7).
export const adminRouter = Router();

adminRouter.use(requireAdmin);

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
