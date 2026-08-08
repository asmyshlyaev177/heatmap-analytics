declare module "*.txt" {
  const content: string;
  export default content;
}

// Collector origin baked into the tracker bundle by scripts/build.mjs, so an
// embedding page only needs the <script> tag. Override at build time with
// HM_ENDPOINT (the e2e build sets it empty so tests can never reach production).
declare const __HM_ENDPOINT__: string;

// Minimal D1 surface used by the worker — avoids pulling in
// @cloudflare/workers-types, which conflicts with lib.dom for the
// client bundles that share this tsconfig.
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown>;
}
