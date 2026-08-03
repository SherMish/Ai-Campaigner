// Minimal migration runner. Reads /migrations/*.sql in name order and runs any
// that haven't been recorded in _migrations. The first migration must create
// the _migrations ledger, so we try it unconditionally and only check after.
import "../load-env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function main() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");

    let alreadyApplied = false;
    try {
      const { rows } = await pool.query(
        "SELECT 1 FROM _migrations WHERE filename = $1",
        [file],
      );
      alreadyApplied = rows.length > 0;
    } catch {
      // _migrations doesn't exist yet — the first migration creates it.
    }

    if (alreadyApplied) {
      console.log(`[migrate] skip ${file} (already applied)`);
      continue;
    }

    console.log(`[migrate] applying ${file}`);
    await pool.query(sql);
    await pool.query(
      "INSERT INTO _migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
      [file],
    );
  }

  console.log("[migrate] done");
  await pool.end();
}

main().catch((err) => {
  console.error("[migrate] failed", err);
  process.exit(1);
});
