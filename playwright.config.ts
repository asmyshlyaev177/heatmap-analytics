import { defineConfig, devices } from "@playwright/test";

// Ports come from the environment so several suites (or several agents) can
// run at once without sharing the collector's recorded-beacon state:
//
//   PAGES_PORT=4541 COLLECTOR_PORT=4542 pnpm exec playwright test
//
// With no ports given we derive a pair from the pid rather than defaulting to
// a fixed one, so two plain `playwright test` runs cannot end up talking to a
// single collector. The derived values are written back into process.env
// before the workers fork, which is what makes helpers.ts (loaded per worker)
// compute the same URLs as the webServer.
// both, or the pair a running server is listening on is only half known
const explicitPorts = !!(process.env.PAGES_PORT && process.env.COLLECTOR_PORT);
const derived = 20000 + (process.pid % 4000) * 2; // below the ephemeral range
process.env.PAGES_PORT ??= String(derived);
process.env.COLLECTOR_PORT ??= String(derived + 1);

const PAGES_PORT = process.env.PAGES_PORT;
const COLLECTOR_PORT = process.env.COLLECTOR_PORT;

export const PAGES = `http://localhost:${PAGES_PORT}`;
export const COLLECTOR = `http://localhost:${COLLECTOR_PORT}`;

export default defineConfig({
  testDir: "./e2e/specs",
  // Beacons are bucketed per test (see e2e/server.mjs), but the tracker and
  // replay specs measure sampler timing, which three parallel workers on one
  // box distort — so still one worker.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : [["list"]],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: PAGES,
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/server.mjs",
    url: `${PAGES}/index.html`,
    // Reuse only what the caller pointed us at. A derived port belongs to this
    // run alone, so anything already listening there is somebody else's server.
    reuseExistingServer: explicitPorts && !process.env.CI,
    env: { PAGES_PORT, COLLECTOR_PORT },
    stdout: "ignore",
    stderr: "pipe",
  },
});
