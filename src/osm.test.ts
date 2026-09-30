// OSM parsing and tiling together, on a small hand-made Overpass response.
import assert from "node:assert/strict";
import { test } from "node:test";
import { areaKind, compassDegrees, meters, openPassages, overpassQuery, parseOsm, type Building, type OverpassResponse, type Tree } from "./osm.ts";
import type { Point } from "./geometry.ts";
import { LocalProjection } from "./projection.ts";
import { cutIntoTiles, tilesCovering } from "./tiles.ts";
import { defined } from "./testing.ts";

const origin = { latitude: 61.5, longitude: 23.75 };
const projection = new LocalProjection(origin);

/** lat / lon of a point `east`, `north` meters from origin */
function at(east: number, north: number): { lat: number; lon: number } {
  const geo = projection.toGeo([east, north]);
  return { lat: geo.latitude, lon: geo.longitude };
}

function square(east: number, north: number, size: number) {
  return [at(east, north), at(east + size, north), at(east + size, north + size), at(east, north + size), at(east, north)];
}

const response: OverpassResponse = {
  elements: [
    { type: "way", id: 1, tags: { highway: "residential", name: "Pitkä \"katu\"" }, geometry: [at(-50, 10), at(150, 10)] },
    { type: "way", id: 2, tags: { highway: "footway", bridge: "yes", layer: "1" }, geometry: [at(10, 20), at(20, 20)] },
    { type: "way", id: 3, tags: { highway: "proposed" }, geometry: [at(10, 30), at(20, 30)] },
    { type: "way", id: 4, tags: { building: "apartments", "building:levels": "4", "roof:height": "2" }, geometry: square(10, 40, 20) },
    { type: "way", id: 5, tags: { "building:part": "yes", height: "12 m" }, geometry: square(10, 40, 20) },
    { type: "way", id: 6, tags: { building: "shed" }, geometry: square(80, 40, 5) },
    {
      type: "relation",
      id: 7,
      tags: { type: "multipolygon", natural: "water", name: "Lake" },
      members: [
        // the outer ring is split into two ways, one of them drawn backwards
        { type: "way", role: "outer", geometry: [at(-40, -40), at(40, -40), at(40, 40)] },
        { type: "way", role: "outer", geometry: [at(-40, -40), at(-40, 40), at(40, 40)] },
        { type: "way", role: "inner", geometry: square(-10, -10, 5) },
      ],
    },
  ],
};

test("parseOsm reads roads, buildings and multipolygon areas in meters", () => {
  const { features, warnings } = parseOsm(response.elements, origin);
  assert.deepEqual(warnings, []);
  assert.deepEqual(features.roads.map((r) => r.osm), ["w1", "w2"]);
  const [street, footbridge] = features.roads;
  assert.equal(street.width, 6);
  assert.ok(Math.abs(street.line[0][0] + 50) < 0.01 && Math.abs(street.line[0][1] - 10) < 0.01);
  assert.deepEqual([footbridge.bridge, footbridge.layer], [true, 1]);

  const [house, part, shed] = features.buildings;
  assert.deepEqual([house.height, house.hasParts, house.levels], [4 * 3 + 2, true, 4]);
  assert.deepEqual([part.part, part.height, part.levels], [true, 12, undefined]);
  // a shed gets a guessed gabled roof on top of its storey
  assert.deepEqual([shed.roofShape, shed.hasParts], ["gabled", false]);
  assert.equal(shed.height.toFixed(2), (3 + 2.5 * Math.tan((27 * Math.PI) / 180)).toFixed(2));

  assert.equal(features.areas.length, 1);
  const lake = features.areas[0];
  assert.equal(lake.kind, "water");
  assert.equal(lake.polygon.outer.length, 4);
  assert.equal(lake.polygon.holes.length, 1);
});

test("cutIntoTiles cuts roads and areas at tile edges and keeps buildings whole", () => {
  const { features } = parseOsm(response.elements, origin);
  const keys = tilesCovering({ minX: -100, minY: -100, maxX: 100, maxY: 100 }, 100);
  assert.equal(keys.length, 4);
  const tiles = new Map(cutIntoTiles(features, keys, 100).map((tile) => [`${tile.x}_${tile.y}`, tile]));

  // the street runs from -50 to 150 east: a piece in each tile it crosses, cut off at 100
  assert.equal(defined(tiles.get("-1_0")).roads[0].line[0][0].toFixed(2), "-50.00");
  assert.equal(defined(defined(tiles.get("0_0")).roads.find((r) => r.osm === "w1")).line[1][0], 100);
  assert.equal(defined(tiles.get("0_0")).buildings.length, 3);
  // the lake is split into four quarters, the hole only in the south-west one
  assert.deepEqual([...tiles.values()].map((tile) => tile.areas.length), [1, 1, 1, 1]);
  assert.equal(defined(tiles.get("-1_-1")).areas[0].polygon.holes.length, 1);
  assert.equal(defined(tiles.get("0_0")).areas[0].polygon.holes.length, 0);
});

test("parseOsm reads trees, shrubs and tree rows, and what grows in woods and scrub", () => {
  const { features } = parseOsm(
    [
      { type: "node", id: 40, tags: { natural: "tree", leaf_type: "needleleaved", height: "15", genus: "Picea" }, ...at(1, 2) },
      { type: "node", id: 41, tags: { natural: "tree", species: "Betula pendula", circumference: "1.2" }, ...at(5, 2) },
      { type: "node", id: 42, tags: { natural: "shrub" }, ...at(9, 2) },
      { type: "node", id: 43, tags: { highway: "street_lamp" }, ...at(9, 9) },
      // 20 m long: trees at 0, 6.7, 13.3 and 20 m
      { type: "way", id: 44, tags: { natural: "tree_row" }, geometry: [at(0, 50), at(20, 50)] },
      { type: "way", id: 45, tags: { natural: "wood" }, geometry: square(100, 0, 50) },
      { type: "way", id: 46, tags: { natural: "scrub" }, geometry: square(200, 0, 50) },
      { type: "way", id: 47, tags: { leisure: "park" }, geometry: square(300, 0, 50) },
    ],
    origin,
  );
  const [conifer, birch, shrub, ...row] = features.trees;
  assert.deepEqual([conifer.kind, conifer.height, conifer.genus], ["conifer", 15, "picea"]);
  assert.deepEqual([birch.kind, birch.height, birch.genus, birch.trunk], ["broadleaved", 10, "betula", 1.2]);
  assert.deepEqual([shrub.kind, shrub.height], ["shrub", 2]);
  assert.ok(Math.abs(conifer.point[0] - 1) < 0.01 && Math.abs(conifer.point[1] - 2) < 0.01);
  assert.deepEqual(row.map((t) => t.point[0].toFixed(1)), ["0.0", "6.7", "13.3", "20.0"]);
  assert.deepEqual(features.areas.map((a) => [a.kind, a.cover]), [["forest", "trees"], ["forest", "shrubs"], ["grass", undefined]]);
});

test("parseOsm reads street lamps: their mount, height, direction and lamp type", () => {
  const { features } = parseOsm(
    [
      { type: "node", id: 50, tags: { highway: "street_lamp", lamp_mount: "angled_mast", lamp_type: "LED" }, ...at(1, 2) },
      { type: "node", id: 51, tags: { highway: "street_lamp", power: "catenary_mast", support: "pole" }, ...at(3, 2) },
      { type: "node", id: 52, tags: { highway: "street_lamp", support: "wall_mounted", height: "4.5", direction: "NE" }, ...at(5, 2) },
      { type: "node", id: 53, tags: { highway: "street_lamp", lamp_mount: "constructor" }, ...at(7, 2) },
    ],
    origin,
  );
  const [angled, catenary, wall, unknown] = features.lamps;
  assert.deepEqual([angled.mount, angled.height, angled.heightEstimated, angled.lampType], ["angled", 8, true, "led"]);
  assert.ok(Math.abs(angled.point[0] - 1) < 0.01 && Math.abs(angled.point[1] - 2) < 0.01);
  assert.deepEqual([catenary.mount, catenary.height], ["catenary", 8]);
  // north-east is 45° clockwise from north: 45° counter-clockwise from east
  assert.deepEqual([wall.mount, wall.height, wall.heightEstimated, wall.toward], ["wall", 4.5, undefined, 45]);
  assert.deepEqual([unknown.mount, unknown.height], [undefined, 5]);
  assert.equal(features.trees.length, 0);
});

test("parseOsm reads the painted crossings, traffic signals and gates, and fences, walls and hedges", () => {
  const { features, streetNodes } = parseOsm(
    [
      { type: "node", id: 60, tags: { highway: "crossing", crossing: "uncontrolled", "crossing:markings": "zebra" }, ...at(1, 0) },
      { type: "node", id: 61, tags: { highway: "crossing", crossing: "traffic_signals" }, ...at(2, 0) },
      { type: "node", id: 62, tags: { highway: "crossing", crossing: "unmarked" }, ...at(3, 0) },
      { type: "node", id: 63, tags: { highway: "crossing", "crossing:markings": "no" }, ...at(4, 0) },
      { type: "node", id: 64, tags: { highway: "traffic_signals", "traffic_signals:direction": "backward" }, ...at(5, 0) },
      { type: "node", id: 65, tags: { barrier: "gate", width: "4" }, ...at(6, 0) },
      { type: "way", id: 66, tags: { barrier: "fence", fence_type: "Wood" }, geometry: [at(0, 10), at(20, 10)] },
      { type: "way", id: 67, tags: { barrier: "wall", wall: "noise_barrier" }, geometry: [at(0, 20), at(20, 20)] },
      { type: "way", id: 68, tags: { barrier: "hedge", height: "2" }, geometry: [at(0, 30), at(20, 30)] },
      { type: "way", id: 69, tags: { barrier: "kerb" }, geometry: [at(0, 40), at(20, 40)] },
    ],
    origin,
  );
  assert.deepEqual(
    streetNodes.map((s) => [s.kind, s.point[0].toFixed(1)]),
    [["crossing", "1.0"], ["crossing", "2.0"], ["signal", "5.0"], ["gate", "6.0"]],
  );
  assert.deepEqual([streetNodes[2], streetNodes[3]].map((s) => (s.kind === "signal" ? s.direction : s.kind === "gate" ? s.width : undefined)), ["backward", 4]);
  assert.deepEqual(
    features.barriers.map((b) => [b.osm, b.kind, b.height, b.heightEstimated, b.material]),
    [["w66", "fence", 1.2, true, "wood"], ["w67", "wall", 3, true, "noise_barrier"], ["w68", "hedge", 2, undefined, undefined]],
  );
});

test("trees go to the tile of their trunk and lamps to the tile of their foot, south to north", () => {
  const tree = (e: number, n: number): Tree => ({ point: [e, n], kind: "broadleaved", height: 8.04 });
  const trees = [tree(50, 60), tree(150, 10), { ...tree(20, 30), genus: "tilia" }, { ...tree(20, 80), trunk: 2.54 }];
  const lamps = [{ point: [150, 70] satisfies Point, height: 8 }, { point: [150, 20] satisfies Point, height: 5 }];
  const features = { roads: [], rails: [], buildings: [], areas: [], trees, lamps, crossings: [], signals: [], gates: [], barriers: [], bridgeDecks: [] };
  const [west, east] = cutIntoTiles(features, [{ x: 0, y: 0 }, { x: 1, y: 0 }], 100);
  assert.deepEqual(west.trees.map((t) => t.point), [[20, 30], [50, 60], [20, 80]]);
  assert.deepEqual(east.trees.map((t) => t.point), [[150, 10]]);
  assert.deepEqual([west.lamps, east.lamps.map((l) => l.point)], [[], [[150, 20], [150, 70]]]);
});

test("meters parses OSM lengths", () => {
  assert.equal(meters("12"), 12);
  assert.equal(meters("12,5 m"), 12.5);
  assert.equal(meters("10 ft")?.toFixed(3), "3.048");
  assert.equal(meters("about 12"), undefined);
});

test("areaKind prefers the first matching rule", () => {
  assert.equal(areaKind({ leisure: "park", natural: "water" }), "water");
  assert.equal(areaKind({ "area:highway": "footway" }), "paved");
  assert.equal(areaKind({ landuse: "residential" }), undefined);
});

test("overpassQuery asks for every area rule key", () => {
  const query = overpassQuery({ south: 1, west: 2, north: 3, east: 4 });
  assert.match(query, /\[bbox:1,2,3,4\]/);
  assert.match(query, /way\["natural"~"\^\(water\|sand\|/);
  assert.match(query, /way\["area:highway"\];/);
  assert.match(query, /node\[natural~"\^\(tree\|shrub\)\$"\];/);
  assert.match(query, /way\[natural=tree_row\];/);
});

/** A width x depth rectangle (east x north) with its south-west corner at east, north */
function rectangle(east: number, north: number, width: number, depth: number) {
  return [at(east, north), at(east + width, north), at(east + width, north + depth), at(east, north + depth), at(east, north)];
}

test("pitched roofs: shape, ridge direction and height from OSM or guessed", () => {
  const tan = Math.tan((27 * Math.PI) / 180);
  const { features } = parseOsm(
    [
      // a house 10 m long east-west and 6 m deep: a guessed gabled roof on two storeys
      { type: "way", id: 30, tags: { building: "house" }, geometry: rectangle(0, 0, 10, 6) },
      { type: "way", id: 31, tags: { building: "house", "roof:orientation": "across" }, geometry: rectangle(20, 0, 10, 6) },
      // a skillion roof sloping down to the south, and a hipped one inside a tagged height
      { type: "way", id: 32, tags: { building: "yes", "roof:shape": "skillion", "roof:direction": "S", "building:levels": "1" }, geometry: rectangle(40, 0, 10, 6) },
      { type: "way", id: 33, tags: { building: "apartments", "roof:shape": "hipped", height: "8" }, geometry: rectangle(60, 0, 30, 20) },
      // roof:levels=0 is not a flat roof; roof:height is kept
      { type: "way", id: 34, tags: { building: "house", "roof:shape": "gabled", "roof:levels": "0", "building:levels": "1" }, geometry: rectangle(0, 20, 10, 6) },
      { type: "way", id: 35, tags: { building: "house", "roof:shape": "gabled", "roof:height": "2.5", "building:levels": "1" }, geometry: rectangle(20, 20, 10, 6) },
      // no guess for an L-shaped house, apartments, a tagged flat roof or a building part
      {
        type: "way",
        id: 36,
        tags: { building: "house" },
        geometry: [at(0, 40), at(10, 40), at(10, 44), at(4, 44), at(4, 50), at(0, 50), at(0, 40)],
      },
      { type: "way", id: 37, tags: { building: "apartments" }, geometry: rectangle(20, 40, 10, 6) },
      { type: "way", id: 38, tags: { building: "house", "roof:shape": "flat" }, geometry: rectangle(40, 40, 10, 6) },
      { type: "way", id: 39, tags: { "building:part": "house" }, geometry: rectangle(60, 40, 10, 6) },
    ],
    origin,
  );
  const get = (osm: string) => defined(features.buildings.find((b) => b.osm === osm));
  const roof = (osm: string) => {
    const b = get(osm);
    return [b.roofShape, b.roofAngle === undefined ? undefined : Math.round(b.roofAngle) % 180, b.roofHeight?.toFixed(2)];
  };
  assert.deepEqual(roof("w30"), ["gabled", 0, (3 * tan).toFixed(2)]);
  assert.equal(get("w30").height.toFixed(2), (6 + 3 * tan).toFixed(2));
  // across: the ridge runs north-south and spans the 10 m side
  assert.deepEqual(roof("w31"), ["gabled", 90, (5 * tan).toFixed(2)]);
  const skillion = get("w32");
  assert.deepEqual([skillion.roofShape, Math.round(defined(skillion.roofAngle))], ["skillion", 270]);
  assert.equal(skillion.height.toFixed(2), (3 + 6 * Math.tan((10 * Math.PI) / 180)).toFixed(2));
  assert.deepEqual([get("w33").height, get("w33").roofHeight], [8, 4]);
  assert.deepEqual(roof("w34"), ["gabled", 0, (3 * tan).toFixed(2)]);
  assert.deepEqual([get("w35").height, get("w35").roofHeight], [5.5, 2.5]);
  for (const osm of ["w36", "w37", "w38", "w39"]) {
    assert.deepEqual(roof(osm), [undefined, undefined, undefined], osm);
  }
});

test("a way through a building opens its walls and is drawn on the ground", () => {
  const { features } = parseOsm(
    [
      { type: "way", id: 40, tags: { building: "apartments", "building:levels": "4" }, geometry: rectangle(0, 0, 20, 10) },
      // a footway straight through west to east, a service road at 45 degrees with a maxheight
      { type: "way", id: 41, tags: { highway: "footway", tunnel: "building_passage" }, geometry: [at(-5, 5), at(25, 5)] },
      { type: "way", id: 42, tags: { highway: "service", tunnel: "building_passage", maxheight: "3.5" }, geometry: [at(5, -3), at(18, 10)] },
      { type: "way", id: 43, tags: { highway: "footway", tunnel: "yes" }, geometry: [at(0, -20), at(10, -20)] },
    ],
    origin,
  );
  const house = defined(features.buildings.find((b) => b.osm === "w40"));
  const round = (p: number[]) => p.map((v) => Math.round(v * 10) / 10);
  const openings = defined(house.passages).map((o) => [...round([...o.from, ...o.to]), o.height]);
  assert.deepEqual(
    openings.sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    [
      // the footway is 2.5 m wide (5 +- 1.25, rounded down); the west wall runs north to south
      [0, 6.2, 0, 3.7, 3],
      // the service road crosses the south wall at (8, 0) and the north wall (running west) at (18, 10),
      // 4 m wide at 45 degrees
      [5.2, 0, 10.8, 0, 3.5],
      [20, 3.7, 20, 6.2, 3],
      [20, 10, 15.2, 10, 3.5],
    ],
  );
  // a passage over a straight corner in the middle of a wall opens both edges
  const { features: gate } = parseOsm(
    [
      { type: "way", id: 44, tags: { building: "yes" }, geometry: [at(40, 20), at(45, 20), at(50, 20), at(50, 26), at(40, 26), at(40, 20)] },
      { type: "way", id: 45, tags: { highway: "pedestrian", tunnel: "building_passage" }, geometry: [at(45.25, 15), at(45.25, 30)] },
    ],
    origin,
  );
  const gateOpenings = defined(gate.buildings[0].passages).map((o) => round([...o.from, ...o.to]));
  assert.deepEqual(
    gateOpenings.sort((a, b) => a[1] - b[1] || a[0] - b[0]),
    [
      [42.8, 20, 45, 20],
      [45, 20, 47.8, 20],
      [47.8, 26, 42.8, 26],
    ],
  );

  const tunnel = (osm: string) => defined(features.roads.find((r) => r.osm === osm)).tunnel;
  assert.deepEqual([tunnel("w41"), tunnel("w42"), tunnel("w43")], [false, false, true]);
});

test("a tunnel through a building is taken for a passage, a ramp into it or a deep tunnel is not", () => {
  const { features } = parseOsm(
    [
      { type: "way", id: 50, tags: { building: "yes", "building:levels": "3" }, geometry: rectangle(0, 0, 20, 10) },
      { type: "way", id: 51, tags: { highway: "service", tunnel: "yes", layer: "-1" }, geometry: [at(-1, 5), at(21, 5)] },
      { type: "way", id: 52, tags: { highway: "service", tunnel: "yes", layer: "-1" }, geometry: [at(10, -5), at(10, 6)] },
      { type: "way", id: 53, tags: { highway: "footway", tunnel: "yes", layer: "-2" }, geometry: [at(5, -5), at(5, 15)] },
    ],
    origin,
  );
  const road = (osm: string) => defined(features.roads.find((r) => r.osm === osm));
  assert.deepEqual([road("w51").tunnel, road("w52").tunnel, road("w53").tunnel], [false, true, true]);
  // only the west and east walls open, for w51
  assert.deepEqual(defined(features.buildings[0].passages).map((o) => Math.round(o.from[0])).sort((a, b) => a - b), [0, 20]);
});

test("a way through a building gets a room walled off from the building's insides", () => {
  const building = (outer: Point[], holes: Point[][] = []): Building => ({
    osm: "w1",
    kind: "apartments",
    part: false,
    hasParts: false,
    height: 15,
    minHeight: 0,
    polygon: { outer, holes },
  });
  const round = (points: Point[]) => points.flatMap((p) => p.map((v) => Math.round(v * 10) / 10));
  const rooms = (b: Building) =>
    defined(b.passageRooms).map((room) => ({ sections: room.sections.map(round), closed: room.closed, walls: room.walls.map(round) }));

  // into a courtyard: the room goes from the street through the building, not on into the courtyard
  const block = building(
    [[0, 0], [30, 0], [30, 30], [0, 30]],
    [[[10, 10], [10, 20], [20, 20], [20, 10]]],
  );
  openPassages([block], [{ line: [[15, -5], [15, 15]], width: 2, height: 3 }]);
  assert.deepEqual(rooms(block), [
    {
      sections: [[14, 0, 16, 0], [14, 10, 16, 10]],
      closed: [false, false],
      walls: [[14, 0, 14, 10], [16, 10, 16, 0]],
    },
  ]);
  assert.equal(defined(block.passageRooms)[0].height, 3);

  // turning left inside and ending there: a mitred corner, and a wall across the end
  const house = building([[0, 0], [20, 0], [20, 10], [0, 10]]);
  openPassages([house], [{ line: [[-5, 5], [10, 5], [10, 8]], width: 2, height: 3 }]);
  assert.deepEqual(rooms(house), [
    {
      sections: [[0, 6, 0, 4], [9, 6, 11, 4], [9, 8, 11, 8]],
      closed: [false, true],
      walls: [[0, 6, 9, 6], [9, 6, 9, 8], [9, 8, 11, 8], [11, 8, 11, 4], [11, 4, 0, 4]],
    },
  ]);

  // ways crossing inside are one space: neither room has walls in the other
  const cross = building([[0, 0], [20, 0], [20, 10], [0, 10]]);
  openPassages(
    [cross],
    [
      { line: [[-5, 5], [25, 5]], width: 2, height: 3 },
      { line: [[10, -5], [10, 15]], width: 2, height: 4 },
    ],
  );
  assert.deepEqual(
    rooms(cross).map((room) => room.walls),
    [
      [[0, 6, 9, 6], [11, 6, 20, 6], [20, 4, 11, 4], [9, 4, 0, 4]],
      [[9, 0, 9, 4], [9, 6, 9, 10], [11, 10, 11, 6], [11, 4, 11, 0]],
    ],
  );

  // a tunnel in a cut under a building (no height) only opens its walls
  const station = building([[0, 0], [20, 0], [20, 10], [0, 10]]);
  openPassages([station], [{ line: [[-5, 5], [25, 5]], width: 2, height: 0 }]);
  assert.equal(station.passageRooms, undefined);
});

test("compassDegrees reads degrees and compass points", () => {
  assert.equal(compassDegrees("SE"), 135);
  assert.equal(compassDegrees("nnw"), 337.5);
  assert.equal(compassDegrees("-90"), 270);
  assert.equal(compassDegrees("uphill"), undefined);
});

test("an open roof over a road is lifted above vehicles; stop shelters get their own height", () => {
  const { features } = parseOsm(
    [
      { type: "way", id: 20, tags: { highway: "primary" }, geometry: [at(0, 5), at(30, 5)] },
      { type: "way", id: 21, tags: { highway: "footway" }, geometry: [at(0, 25), at(30, 25)] },
      // over the road, over the footway only, and over the road with a tagged height
      { type: "way", id: 22, tags: { building: "roof", "building:levels": "1" }, geometry: square(10, 0, 10) },
      { type: "way", id: 23, tags: { building: "roof" }, geometry: square(10, 20, 10) },
      { type: "way", id: 24, tags: { building: "roof", height: "3.5" }, geometry: square(10, 0, 10) },
      { type: "way", id: 25, tags: { building: "yes", amenity: "shelter", shelter_type: "public_transport" }, geometry: square(40, 0, 3) },
    ],
    origin,
  );
  const height = (osm: string) => defined(features.buildings.find((b) => b.osm === osm)).height;
  assert.deepEqual([height("w22"), height("w23"), height("w24"), height("w25")], [5, 3, 3.5, 2.7]);
  assert.equal(defined(features.buildings.find((b) => b.osm === "w25")).shelter, "public_transport");
});

test("a part that starts above the ground with nothing under it gets its building filled in under it", () => {
  const { features } = parseOsm(
    [
      { type: "way", id: 30, tags: { building: "commercial", height: "10", "building:colour": "white" }, geometry: square(0, 0, 40) },
      // a dome on the second floor, and a tower from the ground with a deck on it
      { type: "way", id: 31, tags: { "building:part": "yes", "building:min_level": "2", height: "14" }, geometry: square(5, 5, 10) },
      { type: "way", id: 32, tags: { "building:part": "yes", height: "60" }, geometry: square(25, 25, 4) },
      { type: "way", id: 33, tags: { "building:part": "yes", min_height: "50", height: "55" }, geometry: square(22, 22, 10) },
      // a balcony, and upper floors over an arcade that a footway runs through
      { type: "way", id: 34, tags: { "building:part": "balcony", min_height: "3", height: "4" }, geometry: square(5, 30, 3) },
      { type: "way", id: 35, tags: { "building:part": "yes", "building:min_level": "1", height: "10" }, geometry: square(30, 2, 8) },
      { type: "way", id: 36, tags: { highway: "footway" }, geometry: [at(34, -5), at(34, 15)] },
      // the rest from the ground, so the parts cover over half of the outline
      { type: "way", id: 37, tags: { "building:part": "yes", height: "10" }, geometry: rectangle(0, 20, 20, 20) },
      { type: "way", id: 38, tags: { "building:part": "yes", height: "10" }, geometry: rectangle(15, 0, 10, 20) },
    ],
    origin,
  );
  const fillers = features.buildings.filter((b) => b.osm === "w30" && b.part);
  assert.equal(fillers.length, 1);
  const [filler] = fillers;
  assert.deepEqual([filler.kind, filler.minHeight, filler.height, filler.colour], ["commercial", 0, 6, "white"]);
  assert.ok(Math.abs(filler.polygon.outer[0][0] - 5) < 0.01);
});

test("an outline whose parts cover under half of it is drawn as well", () => {
  const { features } = parseOsm(
    [
      // a 40 x 40 m block with parts only for two low wings (2 x 200 m² of 1600)
      { type: "way", id: 40, tags: { building: "apartments", "building:levels": "8" }, geometry: square(0, 0, 40) },
      { type: "way", id: 41, tags: { "building:part": "yes", "building:levels": "2" }, geometry: rectangle(0, 0, 20, 10) },
      { type: "way", id: 42, tags: { "building:part": "yes", "building:levels": "2" }, geometry: rectangle(20, 30, 20, 10) },
      // overlapping parts count once: two over the same half are not enough
      { type: "way", id: 43, tags: { building: "yes" }, geometry: square(100, 0, 20) },
      { type: "way", id: 44, tags: { "building:part": "yes" }, geometry: rectangle(100, 0, 9, 20) },
      { type: "way", id: 45, tags: { "building:part": "roof", min_height: "3" }, geometry: rectangle(100, 0, 8, 20) },
    ],
    origin,
  );
  const get = (osm: string) => defined(features.buildings.find((b) => b.osm === osm && !b.part));
  assert.equal(get("w40").hasParts, false);
  assert.equal(get("w43").hasParts, false);
});

test("a road under construction is drawn as the road it will be", () => {
  const { features } = parseOsm(
    [
      { type: "way", id: 40, tags: { highway: "construction", construction: "secondary", tunnel: "yes", layer: "-1" }, geometry: [at(0, 0), at(50, 0)] },
      { type: "way", id: 41, tags: { highway: "construction" }, geometry: [at(0, 10), at(50, 10)] },
    ],
    origin,
  );
  assert.deepEqual(
    features.roads.map((r) => [r.osm, r.kind, r.width, r.tunnel, r.layer]),
    [["w40", "secondary", 8, true, -1]],
  );
});

test("a bridge's outline (man_made=bridge) is kept apart for its deck, not drawn as an area", () => {
  const { features, bridgeOutlines } = parseOsm(
    [
      { type: "way", id: 1, tags: { man_made: "bridge", name: "Silta", layer: "1" }, geometry: square(0, 0, 10) },
      {
        type: "relation",
        id: 2,
        tags: { type: "multipolygon", man_made: "bridge" },
        members: [{ type: "way", role: "outer", geometry: square(20, 0, 10) }],
      },
    ],
    origin,
  );
  assert.deepEqual(bridgeOutlines.map((b) => [b.osm, b.name, b.polygon.outer.length]), [["w1", "Silta", 4], ["r2", undefined, 4]]);
  assert.deepEqual([features.areas, features.buildings, features.bridgeDecks], [[], [], []]);
  assert.match(overpassQuery({ south: 0, west: 0, north: 1, east: 1 }), /way\[man_made=bridge\];[\s\S]*relation\[man_made=bridge\]\[type=multipolygon\];/);
});
