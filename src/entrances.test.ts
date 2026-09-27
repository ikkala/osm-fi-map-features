import assert from "node:assert/strict";
import { test } from "node:test";
import { assignEntrances, guessEntrances, parseEntrances } from "./entrances.ts";
import type { Point } from "./geometry.ts";
import type { Building, Road } from "./osm.ts";

function rectangle(x: number, y: number, width: number, depth: number, extra: Partial<Building> = {}): Building {
  const outer: Point[] = [[x, y], [x + width, y], [x + width, y + depth], [x, y + depth]];
  return { osm: `w${x}_${y}`, kind: "yes", part: false, hasParts: false, height: 9, minHeight: 0, polygon: { outer, holes: [] }, ...extra };
}

const street = (line: Point[]): Road => ({ osm: "w1", kind: "residential", width: 6, layer: 0, bridge: false, tunnel: false, line });
const near = (p: Point, q: Point) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.01;

test("parseEntrances keeps entrance nodes in meters, without entrance=no", () => {
  const origin = { latitude: 61.5, longitude: 23.7 };
  const entrances = parseEntrances(
    [
      { type: "node", id: 1, lat: 61.5, lon: 23.7, tags: { entrance: "main" } },
      { type: "node", id: 2, lat: 61.5, lon: 23.7, tags: { entrance: "no" } },
      { type: "node", id: 3, lat: 61.5, lon: 23.7, tags: { natural: "tree" } },
    ],
    origin,
  );
  assert.equal(entrances.length, 1);
  assert.equal(entrances[0].kind, "main");
  assert.ok(near(entrances[0].at, [0, 0]));
});

test("assignEntrances puts entrances on the outlines they are on", () => {
  const a = rectangle(0, 0, 10, 10);
  const b = rectangle(10, 0, 10, 10);
  const placed = assignEntrances([a, b], [
    { at: [5, 0.2], kind: "staircase" },
    // on the wall the two share
    { at: [10, 5], kind: "yes" },
    { at: [5, 5], kind: "yes" },
  ]);
  assert.equal(placed, 2);
  assert.deepEqual(a.entrances?.map((e) => [e.at, e.kind]), [[[5, 0], "staircase"], [[10, 5], "yes"]]);
  assert.deepEqual(b.entrances?.map((e) => e.kind), ["yes"]);
});

test("guessEntrances: staircases 18 m apart on a slab's street side, one main door on others", () => {
  // a 72 x 12 m block of flats with the street to its south, and a house with the street to its east
  const slab = rectangle(0, 0, 72, 12, { windows: "apartments" });
  const house = rectangle(0, 100, 10, 8, { windows: "house" });
  // no guesses: a wide block, one with an OSM entrance, a part, one without windows
  const block = rectangle(200, 0, 40, 40, { windows: "apartments" });
  const mapped = rectangle(300, 0, 20, 10, { windows: "office", entrances: [{ at: [310, 10], kind: "main" }] });
  const part = rectangle(400, 0, 20, 10, { windows: "office", part: true });
  const shed = rectangle(500, 0, 20, 10);
  const roads = [street([[-50, -20], [600, -20]]), street([[30, 90], [30, 120]])];
  assert.equal(guessEntrances([slab, house, block, mapped, part, shed], roads), 2);
  assert.deepEqual(slab.entrances?.map((e) => [e.at[0], e.at[1], e.kind, e.guessed]), [
    [9, 0, "staircase", true],
    [27, 0, "staircase", true],
    [45, 0, "staircase", true],
    [63, 0, "staircase", true],
  ]);
  assert.equal(house.entrances?.length, 1);
  assert.ok(near(house.entrances?.[0].at ?? [0, 0], [10, 104]));
  assert.deepEqual([block.entrances, mapped.entrances?.length, part.entrances, shed.entrances], [undefined, 1, undefined, undefined]);
});
