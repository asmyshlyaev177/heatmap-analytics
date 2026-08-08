// A D1 stand-in for tests: real SQL semantics via node:sqlite (same SQLite
// engine D1 runs on), same prepare/bind/all/run/batch surface, plus D1's
// limits encoded as assertions so a regression that exceeds them fails here
// instead of in production.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// D1 rejects statements with more than 100 bound parameters.
export const D1_MAX_PARAMS = 100;

type Row = Record<string, unknown>;

class FakeStatement {
  db: DatabaseSync;
  sql: string;
  params: unknown[];

  constructor(db: DatabaseSync, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  // D1's bind() returns a new statement rather than mutating
  bind(...values: unknown[]): FakeStatement {
    if (values.length > D1_MAX_PARAMS) {
      throw new Error(
        `too many SQL variables: ${values.length} > ${D1_MAX_PARAMS} (D1 limit) in: ${this.sql.slice(0, 80)}`,
      );
    }
    return new FakeStatement(this.db, this.sql, values);
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    const results = this.db.prepare(this.sql).all(...(this.params as never[])) as T[];
    return { results, success: true, meta: {} };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const info = this.db.prepare(this.sql).run(...(this.params as never[]));
    return { success: true, meta: { changes: Number(info.changes ?? 0) } };
  }

  async first<T = Row>(): Promise<T | null> {
    const { results } = await this.all<T>();
    return results[0] ?? null;
  }
}

export class FakeD1 {
  readonly db: DatabaseSync;

  constructor(schemaPath = join(ROOT, "schema.sql")) {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(readFileSync(schemaPath, "utf8"));
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.db, sql);
  }

  // D1 runs a batch as one atomic transaction, in order
  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    this.db.exec("BEGIN");
    try {
      const out: unknown[] = [];
      for (const s of statements) out.push(await s.run());
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // test conveniences
  rows<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  count(table: string): number {
    return Number((this.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0] as { n: number }).n);
  }

  close(): void {
    this.db.close();
  }
}

export interface TestEnv {
  DB: FakeD1;
  VIEWER_TOKEN?: string;
  ALLOWED_SITES?: string;
  RETENTION_DAYS?: string;
}

export function makeEnv(over: Partial<TestEnv> = {}): TestEnv {
  return { DB: new FakeD1(), VIEWER_TOKEN: "test-token", ...over };
}

// A collect() request shaped exactly like the tracker's beacon: text/plain
// body, plus the CF-Connecting-IP + User-Agent headers every real browser
// request carries and the collector must ignore.
export function beacon(
  body: Record<string, unknown>,
  { ip = "203.0.113.7", ua = "Mozilla/5.0 (TestBrowser)" } = {},
): Request {
  return new Request("https://collector.test/collect", {
    method: "POST",
    headers: { "Content-Type": "text/plain", "CF-Connecting-IP": ip, "User-Agent": ua },
    body: JSON.stringify(body),
  });
}

export function apiUrl(path: string, params: Record<string, string> = {}): URL {
  const url = new URL(`https://collector.test/api/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

// the visitor id the tracker keeps in localStorage and replays on every beacon
export const SID = "visitor-aaaa";

export const pageview = (over: Record<string, unknown> = {}) => ({
  v: 1,
  site: "testsite",
  sid: SID,
  pv: "pv-1",
  path: "/",
  vw: 1440,
  vh: 900,
  sa: 1_700_000_000_000,
  d: 5000,
  msc: 40,
  ev: [],
  ...over,
});

export const ev = (
  k: "c" | "m" | "s" | "r",
  t: number,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  s: over.s ?? t,
  k,
  el: k === "s" ? undefined : "#target",
  rx: k === "s" ? undefined : 0.5,
  ry: k === "s" ? undefined : 0.5,
  x: k === "s" ? undefined : 100,
  y: 200,
  t,
  ...over,
});
