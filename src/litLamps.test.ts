import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point } from "./geometry.ts";
import { fillLitWays } from "./litLamps.ts";
import type { Road, StreetLamp } from "./osm.ts";

function road(kind: string, line: Point[], extra: Partial<Road> = {}): Road {
  return { osm: "w1", kind, width: 8, layer: 0, bridge: false, tunnel: false, line, lit: true, ...extra };
}

test("a lit street gets lamps beside it where OSM maps none near, every so often, on its right going along it", () => {
  const lamps: StreetLamp[] = [];
  const added = fillLitWays(lamps, [road("residential", [[0, 0], [300, 0]])]);
  assert.ok(added >= 8 && added <= 11, `${added} lamps along 300 m`);
  assert.ok(lamps.every((l) => l.implied && l.heightEstimated && Math.abs(l.point[1] + 4.5) < 1e-6), "beside its right edge");
  const xs = lamps.map((l) => l.point[0]).sort((a, b) => a - b);
  assert.ok(xs.slice(1).every((x, i) => x - xs[i] > 20), `apart: ${xs}`);
});

test("where OSM maps lamps along it, a lit way gets none more there; an unlit way, a tunnel and steps get none", () => {
  const mapped: StreetLamp[] = [0, 25, 50, 75, 100].map((x) => ({ point: [x, 5], height: 8 }));
  const lamps = [...mapped];
  const added = fillLitWays(lamps, [
    road("residential", [[0, 0], [100, 0]]),
    road("residential", [[0, 200], [300, 200]], { lit: undefined }),
    road("residential", [[0, 400], [300, 400]], { tunnel: true }),
    road("steps", [[0, 600], [300, 600]]),
  ]);
  assert.equal(added, 0);
  assert.equal(lamps.length, mapped.length);
  // half of it mapped: the rest lit by lamps put there
  const half = [...mapped];
  assert.ok(fillLitWays(half, [road("footway", [[0, 0], [200, 0]], { width: 2 })]) >= 3);
  assert.ok(half.slice(mapped.length).every((l) => l.point[0] > 110 && Math.abs(l.point[1] + 1.5) < 1e-6), "past the mapped ones, beside the path's edge");
});
