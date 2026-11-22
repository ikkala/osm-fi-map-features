import assert from "node:assert/strict";
import test from "node:test";
import { bareUnderBridges, GAP_EDGE_M } from "./bareGround.ts";
import { DECK_EDGE_M } from "./ways.ts";
import type { Road } from "./osm.ts";
import { defined } from "./testing.ts";

const road = (osm: string, line: [number, number][], extra: Partial<Road> = {}): Road => ({ osm, kind: "residential", line, width: 6, layer: 1, bridge: true, tunnel: false, ...extra });
// the model's ground: a valley floor at 10 m running north beside the bridge, a hump of 4 m under its deck
const reach = 3 + DECK_EDGE_M + GAP_EDGE_M;
const model = (e: number, n: number) => (Math.abs(n) < reach && Math.abs(e) < 10 ? 14 : 10 + n / 100);

test("under a bridge the ground is spanned across it from either side, the model's elsewhere", () => {
  const ground = bareUnderBridges([road("w1", [[-10, 0], [10, 0]])], [], model);
  const at = defined(ground(0, 0));
  assert.ok(Math.abs(at - 10) < 0.01, `${at}`);
  assert.ok(Math.abs(defined(ground(0, 2)) - 10.02) < 0.01);
  assert.equal(ground(0, 20), model(0, 20));
  assert.equal(ground(30, 0), model(30, 0));
});

test("the ground is spanned past a bridge beside it, and where the model is lower it stays", () => {
  const beside = [road("w1", [[-10, 0], [10, 0]]), road("w2", [[-10, -8], [10, -8]])];
  const ground = bareUnderBridges(beside, [], (e, n) => (n < -8 - reach || n > reach ? 10 : n === 0 ? 9 : 14));
  assert.equal(ground(0, -4), 10);
  assert.equal(ground(0, 0), 9);
});

test("a boardwalk lies on the ground: the model's stays under it", () => {
  const ground = bareUnderBridges([road("w1", [[-10, 0], [10, 0]], { boardwalk: true })], [], model);
  assert.equal(ground(0, 0), 14);
});

test("under a bridge's outline the gap goes across its bridge way", () => {
  const outline = { osm: "w9", polygon: { outer: [[-10, -12], [10, -12], [10, 12], [-10, 12]] satisfies [number, number][], holes: [] } };
  const ground = bareUnderBridges([road("w1", [[-9, 0], [9, 0]])], [outline], (e, n) => (Math.abs(n) < 12 ? 14 : 10));
  assert.equal(ground(0, 11), 10);
});

test("along a way passing under a bridge at a slant the ground is spanned along the way, from where it comes out", () => {
  // a road in a cut running north-east under the bridge, at 10 m, its banks rising 1 m a meter beside it
  const cut = (e: number, n: number) => 10 + Math.abs(e - n) / Math.SQRT2;
  const hump = (e: number, n: number) => (Math.abs(n) < reach && Math.abs(e) < 10 ? 14 : cut(e, n));
  const under = { ...road("w2", [[-30, -30], [30, 30]]), layer: 0, bridge: false };
  const ground = bareUnderBridges([road("w1", [[-10, 0], [10, 0]]), under], [], hump);
  assert.ok(Math.abs(defined(ground(0, 0)) - 10) < 0.01, `${ground(0, 0)}`);
  assert.ok(Math.abs(defined(ground(1, 1)) - 10) < 0.01);
});

test("over a tunnel passing under a bridge the ground its room, roof and cover need stays: the bridge's abutment", () => {
  const bridge = road("w1", [[-10, 0], [10, 0]]);
  // a street's tunnel under the bridge's end, its portals 30 m either side at the ground, 10 m: it needs it up to 16.1 m
  const tunnel = { ...road("w3", [[0, -30], [0, 30]]), layer: -1, bridge: false, tunnel: true };
  const leading = [road("w4", [[0, -40], [0, -30]], { layer: 0, bridge: false }), road("w5", [[0, 30], [0, 40]], { layer: 0, bridge: false })];
  assert.equal(bareUnderBridges([bridge, tunnel, ...leading], [], model)(0, 0), 14);
  // its portals far down, at 2 m, it passes deep under the gap and needs none of the hump
  const deep = bareUnderBridges([bridge, tunnel, ...leading], [], (e, n) => (Math.abs(n) >= 30 ? 2 : model(e, n)));
  assert.ok(Math.abs(defined(deep(0, 0)) - 10) < 0.01);
});

test("beside a way running along under a bridge the ground is spanned across the bridge", () => {
  const along = { ...road("w2", [[-30, 1], [30, 1]]), layer: 0, bridge: false };
  const ground = bareUnderBridges([road("w1", [[-10, 0], [10, 0]]), along], [], model);
  assert.ok(Math.abs(defined(ground(0, 1)) - 10.01) < 0.01);
});

test("at a span's ends, where the bridge lands on the ground, the model's ground stays", () => {
  const ground = bareUnderBridges([road("w1", [[-10, 0], [10, 0]])], [], model);
  assert.equal(ground(9.5, 0), 14);
  assert.equal(ground(-9.5, 1), 14);
  // where two bridge ways meet, the span goes on
  const joined = bareUnderBridges([road("w1", [[-10, 0], [0, 0]]), road("w2", [[0, 0], [10, 0]])], [], model);
  assert.ok(Math.abs(defined(joined(0.5, 0)) - 10) < 0.01);
});
