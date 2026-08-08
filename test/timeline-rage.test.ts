import assert from "node:assert/strict";
import { test } from "node:test";
import { RAGE_N, rageBurst } from "../src/rage.ts";
import { compressTimeline } from "../src/timeline.ts";

type Ev = {
  t: number;
  k?: string;
  sel?: string;
  rx?: number;
  ry?: number;
  x?: number;
  y?: number;
};

const e = (t: number, over: Partial<Ev> = {}): Ev => ({ t, ...over });
const pt = (x: number, y: number, at: number) => ({ x, y, at });
const vts = (r: { events: { vt: number }[] }) => r.events.map((x) => x.vt);

test("compressTimeline: empty timeline has no skips and the 400ms floor", () => {
  const r = compressTimeline([]);
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.skips, []);
  assert.equal(r.vEnd, 400);
});

test("compressTimeline: gaps up to gapMs leave virtual time equal to real time", () => {
  const r = compressTimeline([e(0), e(1000), e(5000), e(9000)]);
  assert.deepEqual(r.skips, []);
  assert.deepEqual(vts(r), [0, 1000, 5000, 9000]);
  assert.equal(r.vEnd, 9000);
});

test("compressTimeline: the gapMs boundary is exclusive", () => {
  const at = compressTimeline([e(0), e(4000)]);
  assert.deepEqual(at.skips, []);
  assert.deepEqual(vts(at), [0, 4000]);

  const over = compressTimeline([e(0), e(4001)]);
  assert.deepEqual(over.skips, [{ vt: 0, real: 4001 }]);
  assert.deepEqual(vts(over), [0, 1000]);
  assert.equal(over.vEnd, 1000);
});

test("compressTimeline: one long gap collapses to keepMs and shifts every later event", () => {
  const r = compressTimeline([e(1000), e(2000), e(12000), e(13000)]);
  const saved = 10000 - 1000; // gap - keepMs
  // The skip is stamped at the virtual time of the event *before* the gap,
  // and reports the gap's real length so the player can label it.
  assert.deepEqual(r.skips, [{ vt: 2000, real: 10000 }]);
  assert.deepEqual(vts(r), [1000, 2000, 12000 - saved, 13000 - saved]);
  assert.equal(r.vEnd, 13000 - saved);
});

test("compressTimeline: multiple gaps accumulate their savings", () => {
  const r = compressTimeline([e(1000), e(11000), e(12000), e(30000)]);
  assert.deepEqual(r.skips, [
    { vt: 1000, real: 10000 },
    { vt: 3000, real: 18000 },
  ]);
  assert.deepEqual(vts(r), [1000, 2000, 3000, 4000]);
  assert.equal(r.vEnd, 30000 - (9000 + 17000));
});

test("compressTimeline: the leading idle before the first event is compressed too", () => {
  const r = compressTimeline([e(30000), e(31000)]);
  assert.deepEqual(r.skips, [{ vt: 0, real: 30000 }]);
  assert.deepEqual(vts(r), [1000, 2000]);
  assert.equal(r.vEnd, 2000);
});

test("compressTimeline: custom gapMs/keepMs are honoured", () => {
  const evs = [e(500), e(2000), e(2500)];
  assert.deepEqual(compressTimeline(evs).skips, []); // untouched at the defaults

  const r = compressTimeline(evs, 1000, 200);
  assert.deepEqual(r.skips, [{ vt: 500, real: 1500 }]);
  assert.deepEqual(vts(r), [500, 700, 1200]);
  assert.equal(r.vEnd, 1200);
});

test("compressTimeline: vEnd is the last vt, floored at 400", () => {
  assert.equal(compressTimeline([e(100)]).vEnd, 400);
  assert.equal(compressTimeline([e(399)]).vEnd, 400);
  assert.equal(compressTimeline([e(401)]).vEnd, 401);

  const zero = compressTimeline([e(0), e(10000)], 4000, 0);
  assert.deepEqual(vts(zero), [0, 0]);
  assert.equal(zero.vEnd, 400);
});

test("compressTimeline: event payloads survive alongside vt, inputs untouched", () => {
  const src = [
    { t: 250, k: "c", sel: "#btn", rx: 0.5, ry: 0.25, x: 12, y: 34 },
    { t: 9000, k: "m", sel: "main>p", rx: 0.1, ry: 0.9, x: 56, y: 78 },
  ];
  const snap = structuredClone(src);
  const r = compressTimeline(src);
  assert.deepEqual(r.skips, [{ vt: 250, real: 8750 }]);
  assert.deepEqual(r.events, [
    { t: 250, k: "c", sel: "#btn", rx: 0.5, ry: 0.25, x: 12, y: 34, vt: 250 },
    { t: 9000, k: "m", sel: "main>p", rx: 0.1, ry: 0.9, x: 56, y: 78, vt: 1250 },
  ]);
  assert.deepEqual(src, snap);
});

test("rageBurst: fires exactly once, on the third nearby quick click", () => {
  let r = rageBurst([], pt(100, 100, 0));
  assert.equal(r.rage, false);
  assert.equal(r.burst.length, 1);

  r = rageBurst(r.burst, pt(105, 100, 200));
  assert.equal(r.rage, false);
  assert.equal(r.burst.length, 2);

  r = rageBurst(r.burst, pt(100, 105, 400));
  assert.equal(r.rage, true);
  assert.equal(r.burst.length, RAGE_N);

  // Still one 'r' event per burst: the window keeps growing but never re-fires.
  const fourth = rageBurst(r.burst, pt(102, 102, 600));
  assert.equal(fourth.rage, false);
  assert.equal(fourth.burst.length, 4);
  const fifth = rageBurst(fourth.burst, pt(101, 101, 800));
  assert.equal(fifth.rage, false);
  assert.equal(fifth.burst.length, 5);
});

test("rageBurst: distance is euclidean, so 25/25 apart (~35px) never accumulates", () => {
  let r = rageBurst([], pt(100, 100, 0));
  r = rageBurst(r.burst, pt(125, 125, 100));
  assert.deepEqual(r.burst, [pt(125, 125, 100)]);
  assert.equal(r.rage, false);

  r = rageBurst(r.burst, pt(150, 150, 200));
  assert.deepEqual(r.burst, [pt(150, 150, 200)]);
  assert.equal(r.rage, false);
});

test("rageBurst: 20/20 apart (~28px) does accumulate", () => {
  let r = rageBurst([], pt(100, 100, 0));
  r = rageBurst(r.burst, pt(120, 120, 100));
  assert.equal(r.burst.length, 2);
  assert.equal(r.rage, false);

  r = rageBurst(r.burst, pt(100, 100, 200));
  assert.deepEqual(r.burst, [pt(100, 100, 0), pt(120, 120, 100), pt(100, 100, 200)]);
  assert.equal(r.rage, true);
});

test("rageBurst: the RAGE_PX boundary is exclusive", () => {
  const at30 = rageBurst([pt(100, 100, 0)], pt(130, 100, 100));
  assert.deepEqual(at30.burst, [pt(130, 100, 100)]);

  const at29 = rageBurst([pt(100, 100, 0)], pt(129, 100, 100));
  assert.deepEqual(at29.burst, [pt(100, 100, 0), pt(129, 100, 100)]);
});

test("rageBurst: clicks slower than RAGE_MS apart never reach three", () => {
  let r = rageBurst([], pt(100, 100, 0));
  r = rageBurst(r.burst, pt(100, 100, 1000));
  assert.deepEqual(r.burst, [pt(100, 100, 1000)]);
  r = rageBurst(r.burst, pt(100, 100, 2000));
  assert.deepEqual(r.burst, [pt(100, 100, 2000)]);
  assert.equal(r.rage, false);
});

test("rageBurst: the window rolls, dropping only the points that aged out", () => {
  const rolled = rageBurst([pt(100, 100, 0), pt(100, 100, 500)], pt(100, 100, 1300));
  assert.deepEqual(rolled.burst, [pt(100, 100, 500), pt(100, 100, 1300)]);
  assert.equal(rolled.rage, false);

  const at900 = rageBurst([pt(100, 100, 0)], pt(100, 100, 900));
  assert.deepEqual(at900.burst, [pt(100, 100, 900)]);

  const at899 = rageBurst([pt(100, 100, 0)], pt(100, 100, 899));
  assert.deepEqual(at899.burst, [pt(100, 100, 0), pt(100, 100, 899)]);
});

test("rageBurst: never mutates the burst it is given", () => {
  const b = [pt(100, 100, 0), pt(100, 100, 100)];
  const snap = structuredClone(b);
  const r = rageBurst(b, pt(100, 100, 200));
  assert.equal(r.rage, true);
  assert.deepEqual(b, snap);
  assert.notStrictEqual(r.burst, b);
});

test("rageBurst: a fresh window starts after a burst fires and can fire again", () => {
  let r = rageBurst([], pt(100, 100, 0));
  r = rageBurst(r.burst, pt(100, 100, 100));
  r = rageBurst(r.burst, pt(100, 100, 200));
  assert.equal(r.rage, true);

  const far = rageBurst(r.burst, pt(400, 400, 300));
  assert.deepEqual(far.burst, [pt(400, 400, 300)]);
  assert.equal(far.rage, false);

  const late = rageBurst(r.burst, pt(100, 100, 5000));
  assert.deepEqual(late.burst, [pt(100, 100, 5000)]);
  assert.equal(late.rage, false);

  let n = rageBurst(far.burst, pt(405, 400, 400));
  assert.equal(n.rage, false);
  n = rageBurst(n.burst, pt(400, 405, 500));
  assert.equal(n.rage, true);
});
