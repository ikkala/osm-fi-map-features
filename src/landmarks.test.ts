import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point } from "./geometry.ts";
import { DAM_WIDTH_M, landmarkQuery, parseLandmarks, PIER_WIDTH_M } from "./landmarks.ts";
import type { MapFeatures, OverpassResponse } from "./osm.ts";
import { LocalProjection } from "./projection.ts";
import { setCourseHeights, type Ride } from "./rides.ts";
import { defined } from "./testing.ts";
import { cutIntoTiles } from "./tiles.ts";

const ORIGIN = { latitude: 61.5, longitude: 23.76 };
const projection = new LocalProjection(ORIGIN);

function latLon(point: Point): { lat: number; lon: number } {
  const geo = projection.toGeo(point);
  return { lat: geo.latitude, lon: geo.longitude };
}

const near = (a: Point | undefined, b: Point) => {
  const [x, y] = defined(a);
  assert.ok(Math.hypot(x - b[0], y - b[1]) < 0.01, `${x}, ${y} is not ${b[0]}, ${b[1]}`);
};
const node = (id: number, point: Point, tags: Record<string, string>) => ({ type: "node" as const, id, ...latLon(point), tags });
const way = (id: number, points: Point[], tags: Record<string, string>) => ({ type: "way" as const, id, tags, geometry: points.map(latLon) });
const square = (e: number, n: number, side: number): Point[] => [[e, n], [e + side, n], [e + side, n + side], [e, n + side], [e, n]];

test("the query asks for each kind of landmark in the box", () => {
  const query = landmarkQuery({ south: 61.4, west: 23.6, north: 61.6, east: 23.9 });
  assert.match(query, /\[bbox:61\.4,23\.6,61\.6,23\.9\]/);
  for (const part of ["lighthouse", "seamark:type", "flagpole", "natural=stone", "amenity=fountain", "tourism=artwork", "historic", "power", "waterway", "attraction", "roller_coaster=track", "piste:type", "out geom"]) {
    assert.ok(query.includes(part), part);
  }
});

test("seamarks, and masts, flagpoles, stones, fountains, artworks, memorials and power supports as landmarks", () => {
  const elements: OverpassResponse["elements"] = [
    node(1, [10, 20], { man_made: "lighthouse", "seamark:type": "light_major", "seamark:light:colour": "yellow", "seamark:light:character": "Fl", "seamark:light:period": "5" }),
    node(2, [0, 0], { man_made: "mast", "tower:type": "Communication", "tower:construction": "lattice", height: "36" }),
    node(3, [1, 1], { man_made: "flagpole", "flag:type": "national" }),
    node(4, [2, 2], { natural: "stone", name: "Pirunkivi", height: "10" }),
    way(5, square(30, 30, 4), { amenity: "fountain", tourism: "artwork", name: "Suihkukaivo" }),
    node(6, [3, 3], { tourism: "artwork", artwork_type: "statue", material: "Bronze" }),
    node(7, [4, 4], { historic: "memorial", memorial: "war_memorial" }),
    node(8, [5, 5], { historic: "monument" }),
    node(9, [6, 6], { power: "tower" }),
    node(10, [7, 7], { power: "pole" }),
    // inside, or drawn as a building already
    node(11, [8, 8], { tourism: "artwork", indoor: "yes" }),
    way(12, square(50, 50, 6), { tourism: "artwork", building: "yes" }),
    node(13, [9, 9], { man_made: "tower", "tower:type": "bell_tower" }),
  ];
  const found = parseLandmarks(elements, ORIGIN);
  assert.equal(found.seamarks.length, 1);
  assert.deepEqual(defined(found.seamarks[0].light).phases, [0.5, 4.5]);
  near(found.seamarks[0].point, [10, 20]);
  const byOsm = new Map(found.landmarks.map((l) => [l.osm, l]));
  assert.deepEqual(
    found.landmarks.map((l) => [l.osm, l.kind, l.type]),
    [
      ["n2", "mast", "communication"],
      ["n3", "flagpole", "national"],
      ["n4", "stone", undefined],
      ["w5", "fountain", undefined],
      ["n6", "artwork", "statue"],
      ["n7", "memorial", "war_memorial"],
      ["n8", "memorial", "monument"],
      ["n9", "power_tower", undefined],
      ["n10", "power_pole", undefined],
      ["n13", "tower", "bell_tower"],
    ],
  );
  assert.equal(byOsm.get("n2")?.height, 36);
  assert.equal(byOsm.get("n2")?.construction, "lattice");
  assert.equal(byOsm.get("n4")?.name, "Pirunkivi");
  assert.equal(byOsm.get("n6")?.material, "bronze");
  const fountain = defined(byOsm.get("w5"));
  near(fountain.point, [32, 32]);
  assert.equal(defined(fountain.outline).length, 4);
});

test("piers and dams as lines with a width or as outlines", () => {
  const found = parseLandmarks(
    [
      way(1, [[0, 0], [0, 10]], { man_made: "pier", floating: "yes", surface: "wood" }),
      way(2, square(20, 0, 5), { man_made: "pier", name: "Laituri" }),
      way(3, [[40, 0], [50, 0]], { man_made: "pier", width: "3.5" }),
      way(4, [[60, 0], [70, 0]], { waterway: "dam" }),
      way(5, square(80, 0, 8), { waterway: "weir", material: "concrete" }),
      node(6, [90, 0], { waterway: "weir" }),
    ],
    ORIGIN,
  );
  assert.deepEqual(
    found.piers.map((p) => [p.osm, p.width, p.outline?.length, p.floating, p.surface, p.name]),
    [
      ["w1", PIER_WIDTH_M, undefined, true, "wood", undefined],
      ["w2", undefined, 4, undefined, undefined, "Laituri"],
      ["w3", 3.5, undefined, undefined, undefined, undefined],
    ],
  );
  assert.deepEqual(
    found.dams.map((d) => [d.osm, d.kind, d.width, d.outline?.length, d.material]),
    [
      ["w4", "dam", DAM_WIDTH_M, undefined, undefined],
      ["w5", "weir", undefined, 4, "concrete"],
    ],
  );
});

test("power lines, pistes and rides; a ride's course stays a line when closed, other rides are outlines", () => {
  const found = parseLandmarks(
    [
      way(1, [[0, 0], [100, 0]], { power: "line", voltage: "110000;20000", cables: "3" }),
      way(2, [[0, 0], [0, 50]], { "piste:type": "nordic", "piste:grooming": "classic+skating", "piste:name": "Latu", highway: "path" }),
      way(3, [[0, 0], [10, 0], [10, 10], [0, 0]], { "piste:type": "ice_skate" }),
      way(4, [[0, 0], [10, 0]], { "piste:type": "proposed" }),
      way(5, [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]], { attraction: "train", name: "Juna" }),
      way(6, square(40, 40, 10), { attraction: "carousel", name: "Karuselli" }),
      node(7, [60, 60], { attraction: "roller_coaster", name: "Tornado" }),
      way(8, [[70, 0], [80, 0]], { roller_coaster: "track", layer: "1" }),
      node(9, [1, 1], { attraction: "animal" }),
      way(10, square(90, 90, 6), { attraction: "bumper_car", building: "roof" }),
    ],
    ORIGIN,
  );
  assert.deepEqual(found.powerLines.map((p) => [p.osm, p.kind, p.voltage, p.cables, p.line.length]), [["w1", "line", 110000, 3, 2]]);
  assert.deepEqual(
    found.pistes.map((p) => [p.osm, p.kind, p.grooming, p.name, p.line?.length, p.outline]),
    [
      ["w2", "nordic", "classic+skating", "Latu", 2, undefined],
      ["w3", "ice_skate", undefined, undefined, 4, undefined],
    ],
  );
  const rides = new Map(found.rides.map((r) => [r.osm, r]));
  assert.deepEqual([...rides.keys()], ["w5", "w6", "n7", "w8", "w10"]);
  const train = defined(rides.get("w5"));
  assert.equal(train.kind, "train");
  // closed back to its start
  assert.equal(defined(train.line).length, 5);
  near(defined(train.line)[4], [0, 0]);
  assert.equal(defined(rides.get("w6")).outline?.length, 4);
  assert.equal(defined(rides.get("w8")).kind, "track");
  assert.equal(defined(rides.get("w10")).building, true);
});

test("a course runs at its layer's height in its middle and meets the courses it joins at their mean", () => {
  const course = (osm: string, line: Point[], layer?: number, tunnel?: boolean): Ride => ({ osm, kind: "track", point: line[0], line, ...(layer && { layer }), ...(tunnel && { tunnel }) });
  const rides = [
    course("a", [[0, 0], [10, 0]]),
    course("b", [[10, 0], [30, 0]], 2),
    course("c", [[30, 0], [40, 0]], 1),
    course("d", [[40, 0], [50, 0]], -1, true),
  ];
  assert.equal(setCourseHeights(rides), 4);
  const [a, b, c, d] = rides;
  // a: 1 m on its own, 6.5 where it meets b (12 m)
  assert.deepEqual(a.heights, [1, 1, 6.5]);
  assert.deepEqual(a.line?.[1], [5, 0]);
  assert.deepEqual(b.heights, [6.5, 12, 9]);
  assert.deepEqual(c.heights, [9, 6, 3]);
  // in a tunnel: at the ground
  assert.deepEqual(d.heights, [0, 0, 0]);
});

test("landmarks into the tiles: points to their tile, lines cut with their heights, outlines to their middle's tile", () => {
  const empty: MapFeatures = { roads: [], rails: [], buildings: [], areas: [], trees: [], lamps: [], crossings: [], signals: [], gates: [], barriers: [], playEquipment: [], bridgeDecks: [] };
  const found = parseLandmarks(
    [
      node(1, [10, 10], { man_made: "flagpole" }),
      node(2, [110, 10], { man_made: "lighthouse" }),
      way(3, [[50, 50], [150, 50]], { man_made: "pier" }),
      way(4, square(80, 80, 30), { man_made: "pier" }),
      way(5, [[0, 20], [200, 20]], { roller_coaster: "track", layer: "1" }),
      way(6, [[0, 30], [200, 30]], { power: "line" }),
    ],
    ORIGIN,
  );
  const tiles = cutIntoTiles({ ...empty, ...found }, [{ x: 0, y: 0 }, { x: 1, y: 0 }], 100);
  const [west, east] = tiles;
  assert.deepEqual(west.landmarks?.map((l) => l.osm), ["n1"]);
  assert.deepEqual(east.seamarks?.map((s) => s.osm), ["n2"]);
  // the outline's middle is at 95, 95
  assert.deepEqual(west.piers?.map((p) => [p.osm, p.outline !== undefined]), [["w3", false], ["w4", true]]);
  assert.deepEqual(east.piers?.map((p) => [p.osm, p.outline !== undefined]), [["w3", false]]);
  const ride = defined(east.rides?.[0]);
  assert.equal(Math.round(defined(ride.line)[0][0]), 100);
  assert.deepEqual(ride.heights, [6, 6]);
  assert.equal(west.powerLines?.length, 1);
  assert.equal(east.powerLines?.length, 1);
  assert.deepEqual(west.dams, []);
  // without landmarks, the tiles have no such sections
  assert.equal(cutIntoTiles(empty, [{ x: 0, y: 0 }], 100)[0].seamarks, undefined);
});
