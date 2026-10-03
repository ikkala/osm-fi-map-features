import { FINNISH_DEFAULTS_MEASURED_IN_TAMPERE } from "./measuredDefaults.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  estimateCycling,
  estimateFootfall,
} from "./footfall.ts";
import type { Point } from "./geometry.ts";
import { sidewalks, type Building, type Road } from "./osm.ts";

function road(osm: string, kind: string, line: Point[], extra: Partial<Road> = {}): Road {
  return { osm, kind, width: kind === "footway" ? 2.5 : 8, layer: 0, bridge: false, tunnel: false, line, ...extra };
}

/** A building at x with n shops in it and a door */
function shops(x: number, y: number, n: number): Building {
  const outer: Point[] = [[x, y], [x + 10, y], [x + 10, y + 10], [x, y + 10]];
  return {
    osm: `w${x}`,
    kind: "retail",
    part: false,
    hasParts: false,
    height: 10,
    minHeight: 0,
    polygon: { outer, holes: [] },
    businesses: Array.from({ length: n }, (_, i) => ({ osm: `n${x}${i}`, category: "shop" as const, kind: "clothes", point: [x + 5, y + 5] as Point })),
    entrances: [{ at: [x + 5, y], kind: "main" }],
  };
}

test("sidewalks reads the sidewalk tags", () => {
  assert.deepEqual(sidewalks({ sidewalk: "both" }), { sidewalks: "both" });
  assert.deepEqual(sidewalks({ sidewalk: "no" }), { sidewalks: "none" });
  assert.deepEqual(sidewalks({ "sidewalk:both": "separate" }), { sidewalks: "separate" });
  assert.deepEqual(sidewalks({ "sidewalk:left": "yes", "sidewalk:right": "no" }), { sidewalks: "left" });
  assert.deepEqual(sidewalks({ "sidewalk:left": "separate", "sidewalk:right": "no" }), { sidewalks: "separate" });
  assert.deepEqual(sidewalks({}), {});
});

test("more walk where there are more businesses, and none where they cannot", () => {
  const centre = road("w1", "footway", [[0, 0], [100, 0]]);
  const suburb = road("w2", "footway", [[2000, 0], [2100, 0]]);
  const motorway = road("w3", "motorway", [[0, 50], [100, 50]]);
  const separate = road("w4", "secondary", [[0, 80], [100, 80]], { sidewalks: "separate" });
  const tunnel = road("w5", "residential", [[0, 120], [100, 120]], { tunnel: true });
  const result = estimateFootfall([centre, suburb, motorway, separate, tunnel], [shops(40, 10, 30), shops(60, -20, 30)]);
  assert.equal(result.ways, 2);
  assert.ok(centre.footfall && suburb.footfall);
  assert.ok(Math.min(...centre.footfall) > 2 * Math.max(...suburb.footfall));
  assert.equal(motorway.footfall, undefined);
  assert.equal(separate.footfall, undefined);
  assert.equal(tunnel.footfall, undefined);
});

test("a street with footway=sidewalk ways along it has its walking on them", () => {
  const street = road("w1", "residential", [[0, 0], [200, 0]]);
  const left = road("w2", "footway", [[0, 6], [200, 6]], { footway: "sidewalk" });
  const right = road("w3", "footway", [[0, -6], [200, -6]], { footway: "sidewalk" });
  const other = road("w4", "residential", [[0, 100], [200, 100]]);
  const result = estimateFootfall([street, left, right, other], []);
  assert.equal(result.separate, 1);
  assert.equal(street.footfall, undefined);
  assert.ok(left.footfall && right.footfall && other.footfall);
});

test("a way with nothing around gets its kind's share of the base", () => {
  const far = road("w1", "footway", [[50000, 0], [50100, 0]]);
  estimateFootfall([far], [shops(0, 10, 20)]);
  assert.deepEqual(far.footfall, [FINNISH_DEFAULTS_MEASURED_IN_TAMPERE.footfallModels.walking.base, FINNISH_DEFAULTS_MEASURED_IN_TAMPERE.footfallModels.walking.base]);
});

test("people cycle on cycleways and streets, not where bicycles may not go, and walk only where they may", () => {
  const cycleway = road("w1", "cycleway", [[0, 0], [100, 0]], { foot: "designated", bicycle: "designated" });
  const cycleOnly = road("w2", "cycleway", [[0, 50], [100, 50]]);
  const noWalking = road("w3", "cycleway", [[0, 100], [100, 100]], { foot: "no" });
  const footway = road("w4", "footway", [[0, 150], [100, 150]]);
  const shared = road("w5", "footway", [[0, 200], [100, 200]], { bicycle: "yes" });
  const noBicycles = road("w6", "footway", [[0, 250], [100, 250]], { bicycle: "no" });
  const street = road("w7", "residential", [[0, 300], [100, 300]]);
  const steps = road("w8", "steps", [[0, 350], [100, 350]]);
  const roads = [cycleway, cycleOnly, noWalking, footway, shared, noBicycles, street, steps];
  estimateFootfall(roads, []);
  estimateCycling(roads, []);
  const at = (values: number[] | undefined) => values?.[0] ?? 0;
  // walking: a shared cycleway as a footway, a cycleway for bicycles less, none where foot=no
  assert.equal(at(cycleway.footfall), at(footway.footfall));
  assert.ok(at(cycleOnly.footfall) < at(footway.footfall) / 2);
  assert.equal(noWalking.footfall, undefined);
  // cycling: most on cycleways, some on shared footways, few on other footways, none on steps or bicycle=no
  assert.ok(at(cycleway.cycling) > at(shared.cycling) && at(shared.cycling) > 5 * at(footway.cycling));
  assert.ok(at(street.cycling) > at(footway.cycling));
  assert.equal(noBicycles.cycling, undefined);
  assert.equal(steps.cycling, undefined);
  assert.ok(at(noWalking.cycling) > 0);
  // a main street with a cycleway beside it: a few still ride in its carriageway
  const sidepath = road("w9", "secondary", [[0, 400], [100, 400]], { bicycle: "use_sidepath" });
  const plain = road("w10", "secondary", [[0, 450], [100, 450]]);
  estimateCycling([sidepath, plain], []);
  assert.ok(at(sidepath.cycling) > 0 && at(sidepath.cycling) < at(plain.cycling) / 4);
});
