import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point } from "./geometry.ts";
import type { Building } from "./osm.ts";
import { applyRoofTops, parseRoofTops, type MeasuredPart } from "./roofTops.ts";

const BASE = 90;

/** Meters to a tenth, as the tops are measured */
const tenth = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 10) / 10);

function rectangle(x: number, y: number, width: number, depth: number): Point[] {
  return [[x, y], [x + width, y], [x + width, y + depth], [x, y + depth]];
}

/** A building at x, standing at BASE, width east and depth north */
function building(x: number, width: number, depth: number, extra: Partial<Building> = {}): Building {
  return {
    osm: `w${x}`,
    kind: "yes",
    part: false,
    hasParts: false,
    height: 12,
    minHeight: 0,
    base: BASE,
    roofShapeEstimated: true,
    polygon: { outer: rectangle(x, 0, width, depth), holes: [] },
    ...extra,
  };
}

/** A measured part over x .. x + width, y .. y + depth, its top that far over BASE */
function part(x: number, y: number, width: number, depth: number, top: number): MeasuredPart {
  return { polygon: { outer: rectangle(x, y, width, depth), holes: [] }, top: BASE + top };
}

test("parseRoofTops reads polygons and multipolygons with their tops, not parts under the ground", () => {
  const ring = (x: number) => [[x, 61], [x + 0.001, 61], [x + 0.001, 61.001], [x, 61]];
  const parsed = parseRoofTops({
    features: [
      { geometry: { type: "Polygon", coordinates: [ring(23), ring(23.0002)] }, properties: { kattokorkeus: 116.4, suhdemaanpintaan: "Pinnalla" } },
      { geometry: { type: "MultiPolygon", coordinates: [[ring(24)], [ring(25)]] }, properties: { kattokorkeus: 99, suhdemaanpintaan: "Pinnan yllä" } },
      { geometry: { type: "Polygon", coordinates: [ring(26)] }, properties: { kattokorkeus: 80, suhdemaanpintaan: "Pinnan alla" } },
      { geometry: { type: "Polygon", coordinates: [ring(27)] }, properties: { kattokorkeus: null } },
    ],
  });
  assert.deepEqual(
    parsed.map((p) => [p.outer[0].longitude, p.holes.length, p.top]),
    [
      [23, 1, 116.4],
      [24, 0, 99],
      [25, 0, 99],
    ],
  );
});

test("applyRoofTops gives an old building whose top is well over its eaves a hipped roof up to it", () => {
  const school = building(0, 36, 29, { kind: "school", levels: 4, year: 1907, height: 16 });
  const match = applyRoofTops([school], [part(-1, -1, 38, 31, 25.7)]);
  assert.deepEqual(match, { heights: 1, roofs: 1, uncovered: 0, rejected: 0 });
  assert.equal(tenth(school.height), 25.7);
  // the walls are its 4 storeys of 3.6 m, the ridge along its long side
  assert.equal(school.roofShape, "hipped");
  assert.equal(tenth(school.roofHeight), 11.3);
  assert.equal(school.roofAngle, 0);
  assert.equal(school.roofHeightEstimated, true);
});

test("applyRoofTops keeps flat roofs flat, and leaves a newer building's machine room out", () => {
  const block = building(0, 40, 12, { kind: "apartments", levels: 6, year: 1975, height: 25, heightFromLevels: true });
  const newer = building(100, 40, 12, { kind: "apartments", levels: 5, year: 1981, height: 15 });
  // OSM says flat
  const tagged = building(200, 40, 12, { levels: 3, year: 1925, height: 11, roofShapeEstimated: undefined });
  const match = applyRoofTops([block, newer, tagged], [part(0, 0, 40, 12, 19.5), part(100, 0, 40, 12, 19.1), part(200, 0, 40, 12, 18)]);
  assert.deepEqual(match, { heights: 1, roofs: 0, uncovered: 0, rejected: 2 });
  assert.deepEqual([tenth(block.height), block.roofShape, block.heightFromLevels], [19.5, undefined, undefined]);
  assert.deepEqual([newer.height, newer.roofShape], [15, undefined]);
  assert.deepEqual([tagged.height, tagged.roofShape], [11, undefined]);
});

test("applyRoofTops takes the tops that fit the storeys: a tower on a podium, not a lower wing", () => {
  const tower = building(0, 30, 30, { kind: "apartments", levels: 12, year: 2018, height: 50 });
  // the tower is a sixth of the outline, the podium the rest
  const parts = [part(0, 0, 30, 30, 11), part(0, 0, 30, 5, 38.8)];
  const wing = building(100, 20, 20, { levels: 9, height: 35 });
  const match = applyRoofTops([tower, wing], [...parts, part(100, 0, 20, 20, 15.7)]);
  assert.deepEqual(match, { heights: 1, roofs: 0, uncovered: 0, rejected: 1 });
  assert.equal(tenth(tower.height), 38.8);
  assert.equal(wing.height, 35);
});

test("applyRoofTops lets a guessed roof rise up to the top, at most half of the height, never lower than guessed", () => {
  const roof = { roofShape: "gabled" as const, roofAngle: 0, roofHeightEstimated: true, levels: 1, year: 1980 };
  const house = building(0, 12, 8, { kind: "house", height: 5, roofHeight: 2, ...roof });
  const garage = building(100, 6, 4, { kind: "garage", height: 4, roofHeight: 1, ...roof });
  const old = building(200, 12, 8, { kind: "house", height: 6.1, roofHeight: 2.5, ...roof, year: 1900 });
  // roof:shape and roof:height in OSM
  const hotel = building(300, 25, 24, { kind: "hotel", levels: 25, height: 90, roofShape: "hipped", roofHeight: 1.5, roofShapeEstimated: undefined });
  const parts = [part(0, 0, 12, 8, 5.5), part(100, 0, 6, 4, 3.1), part(200, 0, 12, 8, 8), part(300, 0, 25, 24, 80.3)];
  const match = applyRoofTops([house, garage, old, hotel], parts);
  assert.deepEqual(match, { heights: 4, roofs: 0, uncovered: 0, rejected: 0 });
  assert.deepEqual([tenth(house.height), house.roofShape, tenth(house.roofHeight)], [5.5, "gabled", 2.5]);
  // the storeys are too rough a guess of the eaves to flatten a roof
  assert.deepEqual([tenth(garage.height), garage.roofShape, garage.roofHeight], [3.1, "gabled", 1]);
  assert.deepEqual([tenth(old.height), tenth(old.roofHeight)], [8, 4]);
  assert.deepEqual([tenth(hotel.height), hotel.roofHeight], [80.3, 1.5]);
});

test("applyRoofTops leaves out a roof too steep for its building, and buildings too little covered", () => {
  const narrow = building(0, 20, 6, { levels: 1, year: 1900, height: 3.6 });
  const half = building(100, 20, 10, { levels: 2, year: 1950, height: 6.4 });
  const match = applyRoofTops([narrow, half], [part(0, 0, 20, 6, 20), part(100, 0, 8, 10, 8)]);
  assert.deepEqual(match, { heights: 0, roofs: 0, uncovered: 1, rejected: 1 });
  assert.deepEqual([narrow.height, narrow.roofShape, half.height], [3.6, undefined, 6.4]);
});

test("applyRoofTops measures a building without storeys, its guessed roof at most half of it", () => {
  const church = building(0, 30, 15, { kind: "church", height: 13.5, heightEstimated: true, heightByType: true, roofShape: "gabled", roofAngle: 0, roofHeight: 6, roofHeightEstimated: true });
  const shed = building(100, 4, 3, { kind: "shed", height: 3, heightEstimated: true });
  const match = applyRoofTops([church, shed], [part(0, 0, 30, 15, 11), part(100, 0, 4, 3, 1.5)]);
  assert.deepEqual(match, { heights: 1, roofs: 0, uncovered: 0, rejected: 1 });
  assert.deepEqual([tenth(church.height), tenth(church.roofHeight), church.heightEstimated, church.heightByType], [11, 5.5, undefined, undefined]);
  // too low for any building
  assert.deepEqual([shed.height, shed.heightEstimated], [3, true]);
});

test("applyRoofTops leaves parts, special and open buildings and those without a base alone", () => {
  const buildings = [
    building(0, 10, 10, { part: true }),
    building(0, 10, 10, { hasParts: true }),
    building(0, 10, 10, { special: true }),
    building(0, 10, 10, { shelter: "roof" }),
    building(0, 10, 10, { lattice: true }),
    building(0, 10, 10, { minHeight: 3 }),
    building(0, 10, 10, { base: undefined }),
  ];
  const match = applyRoofTops(buildings, [part(0, 0, 10, 10, 30)]);
  assert.deepEqual(match, { heights: 0, roofs: 0, uncovered: 0, rejected: 0 });
  assert.ok(buildings.every((b) => b.height === 12));
});
