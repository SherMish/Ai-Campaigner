import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LANDING_HTML = path.resolve(__dirname, "../landing/index.html");

// The static landing page (vanilla HTML in /landing) is the public homepage.
// Everything else — /login, /dashboard, /admin/* — is the React SPA. In dev we
// serve landing/index.html at GET /; on build we put the SPA at dist/app.html
// and the landing at dist/index.html so the same routing holds in prod (the
// Express server serves both surfaces in a single-origin Railway deploy).
function landingAtRoot(): PluginOption {
  return {
    name: "aic-landing-at-root",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        const isRoot =
          url === "/" || url === "/index.html" || url.startsWith("/?");
        if (req.method === "GET" && isRoot && fs.existsSync(LANDING_HTML)) {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache");
          res.end(fs.readFileSync(LANDING_HTML, "utf8"));
          return;
        }
        next();
      });
    },
    closeBundle() {
      const distDir = path.resolve(__dirname, "dist");
      const spaIndex = path.join(distDir, "index.html");
      if (!fs.existsSync(spaIndex)) return;
      // SPA bundled HTML → app.html; landing becomes the root index.html.
      fs.renameSync(spaIndex, path.join(distDir, "app.html"));
      if (fs.existsSync(LANDING_HTML)) {
        fs.copyFileSync(LANDING_HTML, spaIndex);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), landingAtRoot()],
  resolve: {
    alias: {
      "@aic/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Pass the /api prefix through unchanged so dev hits the same paths the
      // prod server serves.
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
