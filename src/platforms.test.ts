import assert from "node:assert/strict";
import { test } from "node:test";
import { areaKind, parseOsm, type Area, type OverpassResponse, type Rail } from "./osm.ts";
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

test("a tram stop's platform stands over the lowest bed of the tramway beside it, not over one passing under it", () => {
  const stop: Area = { osm: "w1", kind: "platform", polygon: { outer: [[0, 1.5], [30, 1.5], [30, 4], [0, 4]], holes: [] } };
  const station: Area = { osm: "w2", kind: "platform", polygon: { outer: [[0, 101.5], [30, 101.5], [30, 104], [0, 104]], holes: [] } };
  // rising 1 m along the stop, on to 102 well past it
  const tram: Rail = { osm: "w3", kind: "light_rail", layer: 0, bridge: false, tunnel: false, line: [[-20, 0], [0, 0], [30, 0], [100, 0]], bed: [100, 100, 101, 102] };
  // out of a tunnel under the station's platform, 6 m under it
  const under: Rail = { osm: "w4", kind: "light_rail", layer: 0, bridge: false, tunnel: false, line: [[0, 102], [30, 102]], bed: [94, 94] };
  const ground = (_e: number, n: number) => (n < 50 ? 100.2 : 100);
  assert.equal(setPlatformTops([stop, station], ground, [tram, under]), 2);
  assert.equal(stop.top, 100.4);
  assert.equal(station.top, 100);
});
