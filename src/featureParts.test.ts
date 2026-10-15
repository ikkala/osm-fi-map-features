import assert from "node:assert/strict";
import { test } from "node:test";
import { compassOf, lakeParts, streetNameKey, streetParts, type PartArea, type PartRoad } from "./featureParts.ts";
import type { Point } from "./geometry.ts";
import { defined } from "./testing.ts";

test("a vector's compass direction is the nearest of eight", () => {
  assert.equal(compassOf(1, 0), "e");
  assert.equal(compassOf(1, 1), "ne");
  assert.equal(compassOf(0, -5), "s");
  assert.equal(compassOf(-1, -0.2), "w");
  assert.equal(compassOf(-1, 0.9), "nw");
});

test("street names compare without letter case, the kind of dash or extra spaces", () => {
  assert.equal(streetNameKey("Paasikiven–Kekkosentie"), streetNameKey("paasikiven-kekkosentie "));
  assert.notEqual(streetNameKey("Hämeenkatu"), streetNameKey("Hämeenpuisto"));
});

const roads: PartRoad[] = [
  { name: "Testikatu", line: [[0, 0], [250, 0]] },
  { name: "Testikatu", line: [[250, 0], [600, 0]] },
  // the other carriageway past a roundabout
  { name: "Testikatu", line: [[640, 10], [700, 10]] },
  { name: "Testikatu", line: [[0, 5000], [800, 5000]] },
  { name: "Sivukatu", line: [[300, -400], [300, 400]] },
  { line: [[600, 0], [640, 10]] },
  { name: "Lyhytkatu", line: [[0, 1000], [150, 1000]] },
];

test("a street near a point has its two ends, each by its direction from the other", () => {
  const street = defined(streetParts(roads, "testikatu", [300, 20]));
  assert.equal(street.pieces.length, 3);
  assert.deepEqual(street.parts.map((p) => [p.kind, p.direction, p.point]), [
    ["end", "w", [0, 0]],
    ["end", "e", [700, 10]],
  ]);
});

test("no street when none of the name passes near, and no parts for a short one", () => {
  assert.equal(streetParts(roads, "Testikatu", [300, 200]), undefined);
  assert.equal(streetParts(roads, "Muukatu", [300, 0]), undefined);
  assert.deepEqual(defined(streetParts(roads, "Lyhytkatu", [50, 1010])).parts, []);
});

const ring = (...points: Point[]) => ({ outer: points, holes: [] });
const areas: PartArea[] = [
  // one lake cut in two at e = 300
  { osm: "r10", kind: "water", polygon: ring([0, 100], [200, 0], [300, 20], [300, 280], [100, 250]) },
  { osm: "r10", kind: "water", polygon: ring([300, 20], [500, 50], [600, 200], [400, 300], [300, 280]) },
  { osm: "w2", kind: "water", polygon: ring([1000, 0], [1080, 0], [1080, 60], [1000, 60]) },
  { osm: "w3", kind: "water", flowing: true, polygon: ring([2000, 0], [2400, 0], [2400, 40], [2000, 40]) },
  { osm: "w4", kind: "grass", polygon: ring([3000, 0], [3400, 0], [3400, 400], [3000, 400]) },
];

test("a lake has a shore for each direction its outline reaches farthest, those near one kept before left out", () => {
  const lake = defined(lakeParts(areas, [150, 150]));
  assert.equal(lake.pieces.length, 2);
  assert.deepEqual(lake.parts.map((p) => [p.direction, p.point]), [
    ["n", [400, 300]],
    ["e", [600, 200]],
    ["s", [200, 0]],
    ["w", [0, 100]],
    ["se", [500, 50]],
    ["nw", [100, 250]],
  ]);
  assert.ok(lake.parts.every((p) => p.kind === "shore"));
});

test("a lake is matched by a point on its shore too; a pond has no parts, flowing water and land no lake", () => {
  assert.equal(defined(lakeParts(areas, [-30, 100])).pieces.length, 2);
  assert.equal(lakeParts(areas, [-80, 100]), undefined);
  assert.deepEqual(defined(lakeParts(areas, [1040, 30])).parts, []);
  assert.equal(lakeParts(areas, [2200, 20]), undefined);
  assert.equal(lakeParts(areas, [3200, 200]), undefined);
});
