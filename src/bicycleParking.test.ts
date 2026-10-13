import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBicycleParking } from "./bicycleParking.ts";
import type { Point } from "./geometry.ts";
import type { MapFeatures, OverpassResponse } from "./osm.ts";
import { LocalProjection } from "./projection.ts";
import { cutIntoTiles } from "./tiles.ts";
import { defined } from "./testing.ts";

const ORIGIN = { latitude: 61.5, longitude: 23.76 };
const projection = new LocalProjection(ORIGIN);

function latLon(point: Point): { lat: number; lon: number } {
  const geo = projection.toGeo(point);
  return { lat: geo.latitude, lon: geo.longitude };
}

const round = (p: Point) => p.map((v) => Math.round(v * 10) / 10);

const elements: OverpassResponse["elements"] = [
  { type: "node", id: 1, ...latLon([10, 20]), tags: { amenity: "bicycle_parking", bicycle_parking: "Stands", capacity: "12", covered: "yes" } },
  { type: "node", id: 2, ...latLon([150, 20]), tags: { amenity: "bicycle_parking", capacity: "many", access: "customers", level: "-1" } },
  // an area 4 m east-west and 2 m north-south, drawn clockwise; a shed is covered
  { type: "way", id: 3, tags: { amenity: "bicycle_parking", bicycle_parking: "shed", access: "yes" }, geometry: [latLon([20, 10]), latLon([20, 12]), latLon([24, 12]), latLon([24, 10]), latLon([20, 10])] },
  // a row of stands drawn as a line
  { type: "way", id: 4, tags: { amenity: "bicycle_parking" }, geometry: [latLon([0, 0]), latLon([6, 0])] },
  { type: "node", id: 5, ...latLon([0, 0]), tags: { amenity: "parking" } },
];

test("bicycle parking at nodes, areas and lines, with their kind, capacity, cover, access and level", () => {
  const found = parseBicycleParking(elements, ORIGIN);
  assert.deepEqual(
    found.map((p) => [p.osm, round(p.point), p.kind, p.capacity, p.covered, p.access, p.level, p.outline?.length]),
    [
      ["n1", [10, 20], "stands", 12, true, undefined, undefined, undefined],
      ["n2", [150, 20], undefined, undefined, undefined, "customers", -1, undefined],
      ["w3", [22, 11], "shed", undefined, true, undefined, undefined, 4],
      ["w4", [3, 0], undefined, undefined, undefined, undefined, undefined, undefined],
    ],
  );
});

test("bicycle parking goes to the tile its point is in, only when the import had it", () => {
  const empty: MapFeatures = { roads: [], rails: [], buildings: [], areas: [], trees: [], lamps: [], crossings: [], signals: [], gates: [], barriers: [], playEquipment: [], bridgeDecks: [] };
  const keys = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
  const [west, east] = cutIntoTiles({ ...empty, bicycleParkings: parseBicycleParking(elements, ORIGIN) }, keys, 100);
  assert.deepEqual(defined(west.bicycleParkings).map((p) => p.osm), ["w3", "w4", "n1"]);
  assert.deepEqual(defined(east.bicycleParkings).map((p) => p.osm), ["n2"]);
  assert.equal(cutIntoTiles(empty, keys, 100)[0].bicycleParkings, undefined);
});
