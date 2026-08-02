import cors from "cors";
import express from "express";
import { adminRouter } from "./routes/admin.js";

// Builds the Express app. Exported separately from index.ts so tests can
// exercise it without binding a port.
export function createApp() {
  const app = express();

  app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:5173" }));
  app.use(express.json({ limit: "1mb" }));

  // /health stays at the root (no /api prefix) so Railway's healthcheck and
  // uptime monitors don't need to know the API mount point.
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "ai-campaigner",
      time: new Date().toISOString(),
    });
  });

  // API routers mount under /api so single-origin Railway deploys line up with
  // the web client's /api prefix (web/src/api.ts).
  const api = express.Router();
  api.use("/admin", adminRouter);
  app.use("/api", api);

  return app;
}
