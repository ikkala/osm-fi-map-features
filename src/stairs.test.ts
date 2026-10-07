import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOsm, type OverpassResponse } from "./osm.ts";
import { LocalProjection } from "./projection.ts";
import { dropStepsInParts } from "./stairs.ts";

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
