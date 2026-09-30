import assert from "node:assert/strict";
import { test } from "node:test";
import {
  averageDay,
  CYCLING_HOURS,
  CYCLING_MONTHS,
  CYCLING_WEEKDAYS,
  estimateCycling,
  estimateFootfall,
  FOOTFALL_HOURS,
  FOOTFALL_MONTHS,
  FOOTFALL_WEEKDAYS,
  type FootfallCount,
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

test("the months, weekdays and hours average out", () => {
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  assert.ok(Math.abs(mean(FOOTFALL_MONTHS) - 1) < 0.01);
  assert.ok(Math.abs(mean(FOOTFALL_WEEKDAYS) - 1) < 0.01);
  for (const hours of [FOOTFALL_HOURS.weekday, FOOTFALL_HOURS.weekend]) {
    assert.equal(hours.length, 24);
    assert.ok(Math.abs(hours.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  }
  // a Sunday in January (0.85 × 0.75) was a quiet day
  assert.equal(Math.round(averageDay(638, new Date("2026-01-04"))), 1001);
});

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
  const result = estimateFootfall([centre, suburb, motorway, separate, tunnel], [shops(40, 10, 30), shops(60, -20, 30)], []);
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
  const result = estimateFootfall([street, left, right, other], [], []);
  assert.equal(result.separate, 1);
  assert.equal(street.footfall, undefined);
  assert.ok(left.footfall && right.footfall && other.footfall);
});

test("counts fit the estimate and pull it towards them nearby", () => {
  // ten counted footways, busier with more shops around them
  const roads: Road[] = [];
  const buildings: Building[] = [];
  const counts: FootfallCount[] = [];
  for (let i = 0; i < 10; i++) {
    const x = i * 1000;
    roads.push(road(`w${i}`, "footway", [[x, 0], [x + 100, 0]]));
    buildings.push(shops(x + 45, 10, i * 5));
    counts.push({ point: [x + 50, 1], daily: 200 + i * 400, whole: false });
  }
  const far = road("w99", "footway", [[50000, 0], [50100, 0]]);
  const result = estimateFootfall([...roads, far], buildings, counts);
  assert.equal(result.matched, 10);
  assert.ok(result.withinTwo >= 0.8, `within two: ${result.withinTwo}`);
  // the busiest is close to its count
  const busiest = roads[9].footfall ?? [];
  assert.ok(Math.abs(busiest[0] - 3800) < 1500, `busiest ${busiest.join(", ")}`);
  // with nothing around, the base
  assert.deepEqual(far.footfall, [result.model.base, result.model.base]);
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
  estimateFootfall(roads, [], []);
  estimateCycling(roads, [], []);
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
});

test("cycling counts are made average days by cycling's own months", () => {
  // a Wednesday in January: 0.35 × 1.1
  assert.equal(Math.round(averageDay(385, new Date("2026-01-07"), "cycling")), 1000);
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  assert.ok(Math.abs(mean(CYCLING_MONTHS) - 1) < 0.01);
  assert.ok(Math.abs(mean(CYCLING_WEEKDAYS) - 1) < 0.01);
  for (const hours of [CYCLING_HOURS.weekday, CYCLING_HOURS.weekend]) {
    assert.ok(Math.abs(hours.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  }
});
