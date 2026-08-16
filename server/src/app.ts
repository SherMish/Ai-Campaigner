import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { adminRouter } from "./routes/admin.js";
import { appRouter } from "./routes/app.js";
import { authRouter } from "./routes/auth.js";
import { builderRouter } from "./routes/builder.js";
import { additionsRouter } from "./routes/additions.js";
import { controlsRouter } from "./routes/controls.js";
import { OUR_BUSINESS_PORTFOLIO_ID } from "./config/meta-identity.js";

// Locate the built web (web/dist with the landing at index.html). Robust to the
// working directory: prod runs `npm --workspace server run start` (cwd = server/),
// dev/tests run from the repo root, and the compiled entry sits deep under
// server/dist — so try cwd-relative, parent-relative, and file-relative paths and
// pick the first that actually contains index.html.
function resolveWebDist(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "web/dist"),
    path.resolve(process.cwd(), "../web/dist"),
    path.resolve(here, "../../../../web/dist"),
    path.resolve(here, "../../../web/dist"),
  ];
  return candidates.find((p) => fs.existsSync(path.join(p, "index.html"))) ?? null;
}

// Builds the Express app. Exported separately from index.ts so tests can
// exercise it without binding a port.
export function createApp() {
  const app = express();

  // Built web output. When present, this one server serves the API and the static
  // web on a single origin (see railway.json); when absent (dev, tests), only
  // /health + /api are mounted and Vite serves the web.
  const WEB_DIST = resolveWebDist();

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

  // API routers mount under /api so single-origin deploys line up with the web
  // client's /api prefix (web/src/api.ts).
  const api = express.Router();

  // AIC-101/AIC-99: our Business Portfolio ID, from config — not a literal
  // baked into the frontend bundle. It's the one value on the Connect screen
  // that has to survive the "Ads Agent" rename unchanged (customers add us as
  // a partner BY ID, never by name — see docs/META_SETUP.md's naming trap).
  // Unauthenticated: this is a public identifier we already print in front of
  // customers, not a secret, and Connect.tsx/AddContent.tsx need it before
  // the customer signs in on some flows.
  api.get("/config", (_req, res) => {
    res.json({ businessPortfolioId: OUR_BUSINESS_PORTFOLIO_ID });
  });

  api.use("/auth", authRouter);
  api.use("/app", appRouter);
  api.use("/app/builder", builderRouter);
  api.use("/app/additions", additionsRouter);
  api.use("/app/controls", controlsRouter);
  api.use("/admin", adminRouter);
  app.use("/api", api);

  // Single-origin static hosting. `web build` writes the landing page to
  // dist/index.html and the SPA bundle to dist/app.html (see web/vite.config.ts).
  // Assets serve directly; `/` serves the landing; any other non-API GET falls
  // back to the SPA so client-side routes (/admin/*, /login, …) resolve.
  if (WEB_DIST) {
    app.use(express.static(WEB_DIST, { index: false }));
    app.get("/", (_req, res, next) => {
      const landing = path.join(WEB_DIST, "index.html");
      if (fs.existsSync(landing)) res.sendFile(landing);
      else next();
    });
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path === "/health") return next();
      const spa = path.join(WEB_DIST, "app.html");
      if (fs.existsSync(spa)) res.sendFile(spa);
      else next();
    });
  }

  return app;
}
