import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import { securityHeaders } from "./middleware/security.js";
import express from "express";
import { adminRouter } from "./routes/admin.js";
import { adminBuilderRouter } from "./routes/admin-builder.js";
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

  // AIC-133: Railway terminates TLS and forwards the client IP in
  // X-Forwarded-For. Without this, req.ip is the proxy for EVERY request, so
  // the auth rate limiter would put the entire internet in one bucket — one
  // attacker would lock out all customers, and separately would never be
  // limited relative to anyone else. Set to 1 (trust one hop) rather than
  // `true`, which trusts a client-supplied header chain and lets an attacker
  // spoof a fresh IP per request to bypass the limiter entirely.
  app.set("trust proxy", 1);
  app.use(securityHeaders);
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
  // AIC-105 Branch A — mirrors builderRouter, keyed on an admin-supplied
  // customerId instead of the caller's own JWT. Mounted alongside adminRouter
  // (both own /admin, on disjoint route paths) rather than folded into it, so
  // this file can mirror routes/builder.ts's shape 1:1 without further
  // bloating an already-large adminRouter.
  api.use("/admin", adminBuilderRouter);
  app.use("/api", api);

  // Single-origin static hosting. `web build` writes the landing page to
  // dist/index.html and the SPA bundle to dist/app.html (see web/vite.config.ts).
  // Assets serve directly; `/` serves the landing; any other non-API GET falls
  // back to the SPA so client-side routes (/admin/*, /login, …) resolve.
  if (WEB_DIST) {
    // AIC-126: `extensions: ["html"]` makes GET /guides/<slug> serve
    // guides/<slug>.html. Without it the request falls through to the SPA
    // catch-all below and a crawler gets the empty app shell instead of the
    // article — which would defeat the entire point of generating the guides
    // as static HTML. It also makes /privacy and /terms work without the
    // extension. Only matches files that actually exist, so SPA routes
    // (/login, /admin/*) are unaffected.
    // `redirect: false` because a request for /guides matches the guides/
    // DIRECTORY, and serve-static's directory redirect fires BEFORE
    // `extensions` is consulted — so /guides would 301 to /guides/ and the
    // canonical URL would never be the URL actually served. With the redirect
    // off, the directory is skipped and guides.html resolves directly.
    app.use(express.static(WEB_DIST, { index: false, extensions: ["html"], redirect: false }));
    // AIC-126: the guides index, before the static middleware — serve-static
    // would resolve /guides against the guides/ directory and (with
    // redirect:false) fall through to the SPA, which is what shipped for one
    // iteration of this change and returned the empty app shell to crawlers.
    // Same shape as the landing handler below.
    app.get(["/guides", "/guides/"], (_req, res, next) => {
      const idx = path.join(WEB_DIST, "guides", "index.html");
      if (fs.existsSync(idx)) res.sendFile(idx);
      else next();
    });
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
