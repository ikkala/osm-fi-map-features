import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOsm, type OverpassResponse, type Road } from "./osm.ts";
import { LocalProjection } from "./projection.ts";
import { dropStepsInParts, setStaircaseDecks } from "./stairs.ts";

const origin = { latitude: 61.5, longitude: 23.75 };
const projection = new LocalProjection(origin);

function at(east: number, north: number): { lat: number; lon: number } {
  const geo = projection.toGeo([east, north]);
  return { lat: geo.latitude, lon: geo.longitude };
}

/** A width x depth rectangle (east x north) with its south-west corner at east, north */
function rectangle(east: number, north: number, width: number, depth: number) {
  return [at(east, north), at(east + width, north), at(east + width, north + depth), at(east, north + depth), at(east, north)];
}

// steps 5 m deep and 10 m wide, climbing east: their skillion roof slopes down to the west
const stepsPart = (id: number, east: number, tags: Record<string, string> = {}): OverpassResponse["elements"][number] => ({
  type: "way",
  id,
  tags: { "building:part": "steps", height: "3", "roof:shape": "skillion", "roof:height": "3", "roof:direction": "W", ...tags },
  geometry: rectangle(east, 0, 5, 10),
});

const way = (id: number, highway: string, points: [number, number][]): OverpassResponse["elements"][number] => ({
  type: "way",
  id,
  tags: { highway },
  geometry: points.map(([e, n]) => at(e, n)),
});

test("ways of steps inside steps mapped as a building part are left out: the part shows the steps", () => {
  const { features } = parseOsm(
    [
      stepsPart(1, 0),
      // up the middle between points of the outline, and one ending 0.2 m out of it
      way(2, "steps", [[0, 5], [5, 5]]),
      way(3, "steps", [[0, 8], [5.2, 8.2]]),
      // reaching out of the part, and a footway in it
      way(4, "steps", [[-3, 2], [5, 2]]),
      way(5, "footway", [[0, 3], [5, 3]]),
      // steps parts that do not tell which way they climb, and another kind of part
      stepsPart(6, 20, { "roof:shape": "flat" }),
      way(7, "steps", [[20, 5], [25, 5]]),
      { type: "way", id: 8, tags: { "building:part": "yes", height: "3" }, geometry: rectangle(40, 0, 5, 10) },
      way(9, "steps", [[40, 5], [45, 5]]),
    ],
    origin,
  );
  assert.equal(dropStepsInParts(features.roads, features.buildings), 2);
  assert.deepEqual(features.roads.map((r) => r.osm).sort(), ["w4", "w5", "w7", "w9"]);
});

const flight = (osm: string, line: [number, number][], stepCount?: number, incline?: "up" | "down"): Road => ({
  osm,
  kind: "steps",
  width: 2,
  layer: 0,
  bridge: false,
  tunnel: false,
  line,
  ...(stepCount !== undefined && { stepCount }),
  ...(incline && { incline }),
});

// a hillside up to the east, from 100 m at e = 0 to 113 m at e = 20, but low at a wall's foot (e = 10, n < 4)
const hillside = (e: number, n: number) => (e === 10 && n < 4 ? 98 : 100 + 0.65 * e);

test("a staircase whose landing the model has below its foot climbs one riser from its foot to its top", () => {
  // 40 steps up to a landing, a turn, then 10 and 15 steps on to the top: 0.2 m a step
  const lower = flight("w1", [[0, 0], [8, 0], [10, 0]], 40, "up");
  const middle = flight("w2", [[10, 0], [10, 4]], 10, "up");
  const upper = flight("w3", [[10, 4], [20, 4]], 15, "up");
  assert.equal(setStaircaseDecks([upper, lower, middle], hillside), 1);
  assert.deepEqual(lower.deck, [100, 106.4, 108]);
  assert.deepEqual(middle.deck, [108, 110]);
  assert.deepEqual(upper.deck, [110, 113]);
});

test("a staircase's flights may be drawn either way", () => {
  const lower = flight("w1", [[10, 0], [0, 0]], 40, "down");
  const middle = flight("w2", [[10, 0], [10, 4]], 10, "up");
  const upper = flight("w3", [[20, 4], [10, 4]], 15, "down");
  assert.equal(setStaircaseDecks([middle, upper, lower], hillside), 1);
  assert.deepEqual(lower.deck, [108, 100]);
  assert.deepEqual(middle.deck, [108, 110]);
  assert.deepEqual(upper.deck, [113, 110]);
});

test("a staircase ending on a deck climbs to the deck's height", () => {
  const lower = flight("w1", [[0, 0], [10, 0]], 40, "up");
  const upper = flight("w2", [[10, 0], [20, 0]], 10, "up");
  const bridge: Road = { ...flight("w3", [[20, 0], [30, 0]]), kind: "footway", bridge: true, layer: 1, deck: [115, 115] };
  assert.equal(setStaircaseDecks([lower, upper, bridge], hillside), 1);
  assert.deepEqual(lower.deck, [100, 112]);
  assert.deepEqual(upper.deck, [112, 115]);
});

test("a flight the model has nearly level puts its landing out of line too", () => {
  // 20 and 20 steps over 4 m, the first climbing 0.9 m of its 2 m share
  const level = (e: number) => (e === 10 ? 100.9 : 100 + 0.2 * e);
  const lower = flight("w1", [[0, 0], [10, 0]], 20, "up");
  const upper = flight("w2", [[10, 0], [20, 0]], 20, "up");
  assert.equal(setStaircaseDecks([lower, upper], level), 0);
  const flat = (e: number) => (e === 10 ? 100.4 : 100 + 0.2 * e);
  assert.equal(setStaircaseDecks([lower, upper], flat), 1);
  assert.deepEqual(lower.deck, [100, 102]);
  assert.deepEqual(upper.deck, [102, 104]);
});

test("staircases the model has in line, or that do not tell how they climb, are left as they are", () => {
  const cases: Road[][] = [
    // in line with the ground, away from the wall
    [flight("w1", [[0, 10], [10, 10]], 20, "up"), flight("w2", [[10, 10], [20, 10]], 20, "up")],
    // a flight not telling which way it climbs, or how many steps it has
    [flight("w1", [[0, 0], [10, 0]], 40), flight("w2", [[10, 0], [10, 4]], 10, "up")],
    [flight("w1", [[0, 0], [10, 0]], undefined, "up"), flight("w2", [[10, 0], [10, 4]], 10, "up")],
    // up over a wall and down again
    [flight("w1", [[0, 0], [10, 0]], 40, "up"), flight("w2", [[10, 0], [10, 4]], 10, "down")],
    // a footway at the landing
    [flight("w1", [[0, 0], [10, 0]], 40, "up"), flight("w2", [[10, 0], [10, 4]], 10, "up"), { ...flight("w3", [[10, 0], [5, -5]]), kind: "footway" }],
    // a single flight
    [flight("w1", [[0, 0], [10, 0]], 40, "up")],
  ];
  for (const roads of cases) {
    assert.equal(setStaircaseDecks(roads, hillside), 0);
    assert.deepEqual(
      roads.map((r) => r.deck),
      roads.map(() => undefined),
    );
  }
});
