import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point, Polygon } from "./geometry.ts";
import { parseOsm, type OverpassResponse, type PlayEquipment } from "./osm.ts";
import { parsePlayEquipment, placePlayEquipment } from "./playgrounds.ts";
import { LocalProjection } from "./projection.ts";
import { defined } from "./testing.ts";

const ORIGIN = { latitude: 61.5, longitude: 23.76 };
const projection = new LocalProjection(ORIGIN);

function latLon(point: Point): { lat: number; lon: number } {
  const geo = projection.toGeo(point);
  return { lat: geo.latitude, lon: geo.longitude };
}

const round = (value: number | undefined) => (value === undefined ? undefined : Math.round(value * 10) / 10);

function piece(kind: string, point: Point, extra: Partial<PlayEquipment> = {}): PlayEquipment {
  return { osm: `n${Math.round(point[0] * 100 + point[1])}`, kind, point, ...extra };
}

test("nodes, lines and outlines of playground equipment, with their tags; playground=no is left out", () => {
  const elements: OverpassResponse["elements"] = [
    { type: "node", id: 1, ...latLon([10, 20]), tags: { playground: "Swing", capacity: "4", baby: "yes", material: "Metal" } },
    { type: "node", id: 2, ...latLon([0, 0]), tags: { playground: "no" } },
    { type: "way", id: 3, tags: { playground: "slide" }, geometry: [latLon([0, 0]), latLon([0, 3])] },
    // a sandpit 4 m east-west and 2 m north-south, drawn clockwise
    { type: "way", id: 4, tags: { playground: "sandpit", "playground:theme": "Ship" }, geometry: [latLon([20, 10]), latLon([20, 12]), latLon([24, 12]), latLon([24, 10]), latLon([20, 10])] },
  ];
  const parsed = parsePlayEquipment(elements, ORIGIN);
  assert.deepEqual(
    parsed.map((p) => [p.osm, p.kind, round(p.point[0]), round(p.point[1]), round(p.along), round(p.length), round(p.width)]),
    [
      ["n1", "swing", 10, 20, undefined, undefined, undefined],
      ["w3", "slide", 0, 1.5, 90, 3, undefined],
      ["w4", "sandpit", 22, 11, 0, 4, 2],
    ],
  );
  assert.deepEqual([parsed[0].capacity, parsed[0].baby, parsed[0].material], [4, true, "metal"]);
  const sandpit = parsed[2];
  assert.equal(sandpit.theme, "ship");
  // counter-clockwise
  assert.deepEqual(defined(sandpit.outline).map(([e, n]) => [round(e), round(n)]), [[24, 10], [24, 12], [20, 12], [20, 10]]);
});

test("a swing lines up with the next swing in its row, other nodes with their playground's nearest long edge", () => {
  // a playground 30 m east-west and 20 m north-south, with a short notch in its north-east corner
  const playground: Polygon = { outer: [[0, 0], [30, 0], [30, 19], [29, 20], [0, 20]], holes: [] };
  const equipment = [
    piece("swing", [5, 15]),
    piece("swing", [8, 11]),
    piece("swing", [20, 5]),
    piece("slide", [29.5, 10]),
    piece("springy", [28.9, 19.4]),
    piece("sandpit", [50, 50]),
    piece("climbingframe", [10, 10], { along: 30, length: 4, width: 3 }),
  ];
  const placed = placePlayEquipment(equipment, [playground]);
  assert.deepEqual([placed.merged, placed.rows, placed.edges], [0, 2, 3]);
  // the first two swings 5 m apart make a row (to the south-east, 127 degrees); the third, alone, takes the south edge
  // the slide by the east edge runs along it, the springy by the short corner edge takes the north edge
  assert.deepEqual(
    placed.equipment.map((p) => [p.kind, round(p.along)]),
    [["climbingframe", 30], ["swing", 126.9], ["swing", 126.9], ["swing", 0], ["slide", 90], ["springy", 0], ["sandpit", undefined]],
  );
});

test("nodes of a kind mapped twice become one in their middle, keeping the tags of each", () => {
  const equipment = [piece("dome", [0, 0]), piece("dome", [1, 0], { material: "rope" }), piece("dome", [1.5, 0.5]), piece("slide", [0.5, 0])];
  const placed = placePlayEquipment(equipment, []);
  assert.equal(placed.merged, 2);
  assert.deepEqual(
    placed.equipment.map((p) => [p.kind, round(p.point[0]), round(p.point[1]), p.material]),
    [["dome", 0.8, 0.2, "rope"], ["slide", 0.5, 0, undefined]],
  );
});

test("a playground's outline is kept for its equipment to line up with, and its ground is sand", () => {
  const ring = [latLon([0, 0]), latLon([10, 0]), latLon([10, 8]), latLon([0, 8]), latLon([0, 0])];
  const { features, playgrounds } = parseOsm([{ type: "way", id: 5, tags: { leisure: "playground" }, geometry: ring }], ORIGIN);
  assert.deepEqual(playgrounds.map((p) => p.outer.length), [4]);
  assert.deepEqual(features.areas.map((a) => [a.osm, a.kind]), [["w5", "sand"]]);
});
