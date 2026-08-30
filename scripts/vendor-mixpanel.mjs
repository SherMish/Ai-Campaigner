// AIC-28. Copies Mixpanel's OFFICIAL loader stub out of the installed package
// into web/public/vendor, for the static landing page and /guides.
//
// Vendored from node_modules rather than pasted in: the stub is minified and
// must match the library it loads, and one wrong character fails silently.
// From the pinned dependency it is always the version `mixpanel-browser` in
// package.json expects.
//
// Why the stub + CDN library and not a bundle of the npm package: bundling the
// package is 126 KB gzipped because it includes the session recorder, while
// Mixpanel's CDN build is 33 KB. These are SEO pages; that difference matters
// more than the third-party request. (Measured, not assumed.)
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "node_modules/mixpanel-browser/dist/mixpanel-jslib-snippet.min.js");
const outDir = path.join(root, "web/public/vendor");
mkdirSync(outDir, { recursive: true });
copyFileSync(src, path.join(outDir, "mixpanel-snippet.min.js"));
console.log("[vendor] mixpanel snippet copied");
