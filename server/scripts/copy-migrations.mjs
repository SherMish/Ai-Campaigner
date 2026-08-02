// Copy the .sql migrations into the build output so the compiled migration
// runner (dist/server/src/db/migrate.js) can find them in production.
import fs from "node:fs";
import path from "node:path";

const src = path.resolve("src/db/migrations");
const dst = path.resolve("dist/server/src/db/migrations");
fs.mkdirSync(dst, { recursive: true });

let n = 0;
for (const f of fs.readdirSync(src)) {
  if (f.endsWith(".sql")) {
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
    n++;
  }
}
console.log(`[build] copied ${n} migrations to dist`);
