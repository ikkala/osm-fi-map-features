import assert from "node:assert/strict";
import { test } from "node:test";
import { areaKind, parseOsm, type Area, type OverpassResponse } from "./osm.ts";
import { setPlatformTops } from "./platforms.ts";
import { LocalProjection } from "./projection.ts";

const origin = { latitude: 61.5, longitude: 23.75 };
const projection = new LocalProjection(origin);

function at(east: number, north: number): { lat: number; lon: number } {
  const geo = projection.toGeo([east, north]);
  return { lat: geo.latitude, lon: geo.longitude };
}

function rectangle(e0: number, n0: number, e1: number, n1: number) {
  return [at(e0, n0), at(e1, n0), at(e1, n1), at(e0, n1), at(e0, n0)];
}

test("railway platforms are areas of their own, a multipolygon's holes kept", () => {
  assert.equal(areaKind({ railway: "platform" }), "platform");
  const response: OverpassResponse = {
    elements: [
      { type: "way", id: 1, tags: { railway: "platform", area: "yes" }, geometry: rectangle(0, 0, 40, 4) },
      {
        type: "relation",
        id: 2,
        tags: { type: "multipolygon", railway: "platform", public_transport: "platform" },
        members: [
          { type: "way", role: "outer", geometry: rectangle(0, 10, 100, 18) },
          // stairs down through it
          { type: "way", role: "inner", geometry: rectangle(40, 12, 44, 16) },
        ],
      },
    ],
  };
  const { features } = parseOsm(response.elements, origin);
  const platforms = features.areas.filter((a) => a.kind === "platform");
  assert.deepEqual(platforms.map((a) => a.osm), ["w1", "r2"]);
  assert.equal(platforms[1].polygon.holes.length, 1);
  assert.deepEqual(features.rails, []);
});

test("a platform's top is the ground's median inside it: the ridge the elevation model has, not its smoothed edges", () => {
  // a platform 6 m wide over ground that rises from 95.4 at its edges to 96.3 a meter in
  const platform: Area = { osm: "w1", kind: "platform", polygon: { outer: [[0, 0], [50, 0], [50, 6], [0, 6]], holes: [] } };
  const grass: Area = { osm: "w2", kind: "grass", polygon: { outer: [[0, 0], [10, 0], [10, 10]], holes: [] } };
  const ground = (_e: number, n: number) => (n < 1 || n > 5 ? 95.4 : 96.3);
  assert.equal(setPlatformTops([platform, grass], ground), 1);
  assert.equal(platform.top, 96.3);
  assert.equal(grass.top, undefined);
  // no ground known: no top
  const unknown: Area = { osm: "w3", kind: "platform", polygon: platform.polygon };
  assert.equal(setPlatformTops([unknown], () => undefined), 0);
  assert.equal(unknown.top, undefined);
});
