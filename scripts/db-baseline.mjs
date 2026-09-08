// Marks every migrations/*.sql as applied without running it.
//
// schema.sql builds a fresh database in one shot, so on a new one every
// migration is already satisfied the moment it exists — running them would fail
// on a duplicate column. `wrangler d1 migrations apply` has no "mark applied",
// so this writes the rows it would have written itself.
//
// Names come from the directory rather than a list in here: a list is one more
// place to forget a file, and forgetting means the migration re-runs on the next
// fresh database.
//
// Flags are passed through, so `--remote` targets production and no flag targets
// the local dev database. Runs via a pnpm script, which is what puts
// node_modules/.bin on PATH for the wrangler call.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const SAFE = /^[\w.-]+\.sql$/;

const names = readdirSync("migrations")
  .filter((f) => f.endsWith(".sql"))
  .sort();

const unsafe = names.filter((n) => !SAFE.test(n));
if (unsafe.length) throw new Error(`migration names must be [\\w.-]+.sql: ${unsafe.join(", ")}`);
if (!names.length) process.exit(0);

// The same shape wrangler creates on its first apply, so whichever runs first
// wins and the other is a no-op.
const sql = `CREATE TABLE IF NOT EXISTS d1_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT OR IGNORE INTO d1_migrations (name) VALUES ${names.map((n) => `('${n}')`).join(", ")};`;

execFileSync(
  "wrangler",
  ["d1", "execute", "heatmap-analytics", ...process.argv.slice(2), "--command", sql],
  { stdio: "inherit" },
);
console.log(`baselined ${names.length}: ${names.join(", ")}`);
