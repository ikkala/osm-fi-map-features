import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point, Polygon } from "./geometry.ts";
import type { Building, MapFeatures, Rail, Road } from "./osm.ts";
import { defined } from "./testing.ts";
import { BED_M, CAR_PARK_CLEARANCE_M, densify, fitRoomsUnderDecks, openPortals, portalWallsAt, RAIL_CLEARANCE_M, raiseToWalls, ROAD_CLEARANCE_M, roomHeight, ROOF_M, setTunnelFloors, setTunnelRooms, uncoverAtGrade, WATER_DEPTH_M } from "./tunnels.ts";

function road(osm: string, line: Point[], extra: Partial<Road> = {}): Road {
  return { osm, kind: "primary", width: 8, layer: 0, bridge: false, tunnel: false, line, ...extra };
}

function features(roads: Road[], rails: Rail[] = []): MapFeatures {
  return { roads, rails, buildings: [], areas: [], trees: [], lamps: [], crossings: [], signals: [], gates: [], barriers: [], playEquipment: [], bridgeDecks: [] };
}

const round = (values: number[] | undefined) => values?.map((v) => Math.round(v * 10) / 10);
const counts = ({ floors, ramps }: { floors: number; ramps: number }) => ({ floors, ramps });

test("densify adds points so none are further apart than the step", () => {
  assert.deepEqual(densify([[0, 0], [25, 0], [30, 0]], 10), [[0, 0], [25 / 3, 0], [50 / 3, 0], [25, 0], [30, 0]]);
});

test("a tunnel's floor goes straight from portal to portal when the ground over it is high enough", () => {
  // portals at 100 and 90 at e = 0 and 200, a hill of 130 over the tunnel between
  const ground = (e: number) => (e <= 0 ? 100 : e >= 200 ? 90 : 130);
  const tunnel = road("w1", [[0, 0], [200, 0]], { tunnel: true, layer: -2 });
  const map = features([road("w2", [[-50, 0], [0, 0]]), tunnel, road("w3", [[200, 0], [250, 0]])]);
  assert.deepEqual(counts(setTunnelFloors(map, ground)), { floors: 1, ramps: 2 });
  assert.equal(tunnel.line.length, 21);
  // the ways out stay at the floor under the portals' walls (the hill's ground raised over the ends), level to the ground on
  const ramps = map.roads.filter((r) => r.floor && !r.tunnel).map((r) => [r.line, round(r.floor)]);
  assert.deepEqual(ramps, [[[[-2, 0], [0, 0]], [100, 100]], [[[200, 0], [202, 0]], [90, 90]]]);
  assert.deepEqual(round(tunnel.floor), tunnel.line.map(([e]) => Math.round((100 - e / 20) * 10) / 10));
});

test("vehicles' tunnels meeting at their points get a room as tall as their tallest maxheight, within reason, and walkways' tunnels by them", () => {
  const entrance = road("w1", [[0, 0], [10, 0]], { kind: "service", tunnel: true, maxHeight: 2.3 });
  const aisle = road("w2", [[10, 0], [30, 0]], { kind: "service", tunnel: true });
  const other = road("w3", [[30, 0], [30, 20]], { kind: "service", tunnel: true, maxHeight: 2.5 });
  const walkway = road("w4", [[30, 20], [40, 20]], { kind: "footway", width: 2.5, tunnel: true });
  const beside = road("w9", [[0, 3], [10, 3]], { kind: "footway", width: 2.5, tunnel: true });
  const apart = road("w10", [[0, 50], [10, 50]], { kind: "footway", width: 2.5, tunnel: true });
  const tall = road("w5", [[100, 0], [110, 0]], { tunnel: true, maxHeight: 6 });
  const low = road("w6", [[200, 0], [210, 0]], { tunnel: true, maxHeight: 1 });
  const street = road("w7", [[0, 0], [-10, 0]], { kind: "service" });
  assert.equal(setTunnelRooms([entrance, aisle, other, walkway, beside, apart, tall, low, street]), 6);
  assert.deepEqual(
    [entrance, aisle, other, walkway, beside, apart, tall, low, street].map(roomHeight),
    [2.5, 2.5, 2.5, 2.5, 2.5, 3, ROAD_CLEARANCE_M, 2.2, ROAD_CLEARANCE_M],
  );
  assert.equal(roomHeight({ osm: "w8", kind: "rail", layer: -1, bridge: false, tunnel: true, line: [] }), RAIL_CLEARANCE_M);
});

test("a low tunnel under a low hill stays at its portals' level, where a road's full room would sink it", () => {
  // portals at 100, the ground over the tunnel 104
  const ground = (e: number) => (e <= 0 || e >= 200 ? 100 : 104);
  const floors = (extra: Partial<Road>) => {
    const tunnel = road("w1", [[0, 0], [200, 0]], { tunnel: true, layer: -1, kind: "service", ...extra });
    setTunnelRooms([tunnel]);
    setTunnelFloors(features([road("w2", [[-50, 0], [0, 0]]), tunnel, road("w3", [[200, 0], [250, 0]])]), ground);
    return defined(tunnel.floor);
  };
  assert.equal(Math.round(Math.min(...floors({ maxHeight: 2.3 })) * 10) / 10, 100);
  assert.ok(Math.min(...floors({})) < 104 - ROAD_CLEARANCE_M - ROOF_M + 0.1);
});

test("a corridor on from a tunnel's end rises out of it as stairs do, and does not lift its floor to the ground", () => {
  // a passage under the tracks (ground 96) with a corridor on into a building at its west end
  const tunnel = road("w1", [[0, 0], [100, 0]], { tunnel: true, layer: -1, kind: "footway", width: 2.5 });
  const corridor = road("w2", [[-14, 0], [0, 0]], { kind: "corridor", width: 3 });
  const map = features([corridor, tunnel, road("w3", [[100, 0], [150, 0]], { kind: "footway", width: 2.5 })]);
  setTunnelFloors(map, (e) => (e > 100 ? 92 : 96));
  // the west end as deep as the room and roof need, not at the ground
  assert.equal(round(tunnel.floor)?.[0], 96 - 3 - ROOF_M);
  // a stretch of the corridor rises from it, as steeply as stairs
  const [rising] = map.roads.filter((r) => r.osm === "w2" && r.floor);
  assert.deepEqual(rising.line[rising.line.length - 1], [0, 0]);
  assert.equal(defined(rising.floor)[rising.line.length - 1], defined(tunnel.floor)[0]);
  assert.ok(Math.hypot(rising.line[0][0], rising.line[0][1]) < 10);
});

test("a portal's floor is the ramp's just outside it, not the top of the portal's wall", () => {
  const ground = (e: number) => (e < 0 ? 95 + e / 2 : 120);
  const tunnel = road("w1", [[0, 0], [100, 0]], { tunnel: true, layer: -1 });
  setTunnelFloors(features([road("w2", [[-20, 0], [0, 0]]), tunnel]), ground);
  assert.equal(round(tunnel.floor)?.[0], 93);
});

test("under a bridge the floor goes level between its portals, not down under the model's span", () => {
  // a footway along under a bridge, portals at 83; the model under the deck spans the gap at 86
  const ground = (e: number, n: number) => (n <= 0 || n >= 60 ? 83 : 86);
  const floors = (underBridge?: (p: Point) => boolean) => {
    const tunnel = road("w1", [[0, 0], [0, 60]], { kind: "footway", width: 5, tunnel: true, layer: -1 });
    setTunnelFloors(features([road("w2", [[0, -20], [0, 0]], { kind: "footway", width: 2.5 }), tunnel, road("w3", [[0, 60], [0, 80]], { kind: "footway", width: 2.5 })]), ground, new Map(), underBridge);
    return round(tunnel.floor);
  };
  assert.ok(Math.min(...(floors() ?? [])) < 83 - 0.5);
  assert.deepEqual(floors(([, n]) => n >= 0 && n <= 60), [83, 83, 83, 83, 83, 83, 83]);
});

test("a street ending at a bridge over a tunnel does not sink its floor under the model's ground there", () => {
  // the tunnel along under the bridge's end, the street's end over its room at the bridge, where the model is low
  const ground = (e: number, n: number) => (n <= 0 || n >= 60 ? 83 : e > 4 ? 88 : 85);
  const floors = (underBridge?: (p: Point) => boolean) => {
    const tunnel = road("w1", [[0, 0], [0, 60]], { kind: "footway", width: 5, tunnel: true, layer: -1 });
    const street = road("w4", [[4, 30], [40, 30]], { kind: "residential", width: 7 });
    setTunnelFloors(features([road("w2", [[0, -20], [0, 0]], { kind: "footway", width: 2.5 }), tunnel, street, road("w3", [[0, 60], [0, 80]], { kind: "footway", width: 2.5 })]), ground, new Map(), underBridge);
    return round(tunnel.floor);
  };
  assert.ok(Math.min(...(floors(([e, n]) => e <= 4 && n >= 0 && n <= 60) ?? [])) >= 83 - 1e-9);
  assert.ok(Math.min(...(floors(([e, n]) => e < 4 && n >= 0 && n <= 60) ?? [])) < 83 - 0.5);
});

test("the floor sinks under a dip in the ground, no steeper than a road tunnel, and not at the portals", () => {
  // level ground at 110 over a tunnel between portals at 100, dipping to 102 at e = 150
  const ground = (e: number) => (e <= 0 || e >= 300 ? 100 : e >= 140 && e <= 160 ? 102 : 110);
  const tunnel = road("w1", [[0, 0], [300, 0]], { tunnel: true, layer: -2 });
  setTunnelFloors(features([road("w2", [[-50, 0], [0, 0]]), tunnel, road("w3", [[300, 0], [350, 0]])]), ground);
  const floor = defined(tunnel.floor);
  const deepest = 102 - ROAD_CLEARANCE_M - ROOF_M;
  assert.equal(Math.round(Math.min(...floor) * 10) / 10, deepest);
  assert.deepEqual([floor[0], floor[floor.length - 1]], [100, 100]);
  for (let i = 1; i < floor.length; i++) {
    const step = Math.hypot(tunnel.line[i][0] - tunnel.line[i - 1][0], tunnel.line[i][1] - tunnel.line[i - 1][1]);
    assert.ok(Math.abs(floor[i] - floor[i - 1]) <= 0.07 * step + 1e-9, `grade at ${i}`);
  }
});

test("past a dip the floor keeps a steady grade to the portal rather than rising up under the ground again", () => {
  // portals at 100 at e = 0 and 400; the ground dips to 96 at e = 90..110 and is 110 elsewhere over the tunnel
  const ground = (e: number) => (e <= 0 || e >= 400 ? 100 : e >= 90 && e <= 110 ? 96 : 110);
  const tunnel = road("w1", [[0, 0], [400, 0]], { tunnel: true, layer: -2 });
  setTunnelFloors(features([road("w2", [[-50, 0], [0, 0]]), tunnel, road("w3", [[400, 0], [450, 0]])]), ground);
  const floor = defined(tunnel.floor);
  const deepest = 96 - ROAD_CLEARANCE_M - ROOF_M;
  assert.equal(Math.round(Math.min(...floor) * 10) / 10, deepest);
  // down to the dip and up from it, never down again: no point is over the line between its neighbours
  const low = floor.indexOf(Math.min(...floor));
  for (let i = 1; i < floor.length; i++) {
    assert.ok(i <= low ? floor[i] <= floor[i - 1] + 1e-9 : floor[i] >= floor[i - 1] - 1e-9, `floor ${floor[i]} at ${tunnel.line[i][0]}`);
  }
  // halfway from the dip to the east portal the floor is about halfway between their floors, far under the
  // 110 - 5.8 the ground alone would allow
  const middle = tunnel.line.findIndex(([e]) => e === 250);
  assert.ok(Math.abs(floor[middle] - (deepest + 100) / 2) < 1, `floor ${floor[middle]} at 250`);
});

test("a tunnel under another one crossing over it runs with its roof under the other's floor", () => {
  // a footway tunnel (layer -1) across a road tunnel (layer -2) at e = 105, both under level ground at 110
  const ground = (e: number, n: number) => (Math.abs(e - 100) <= 60 && Math.abs(n) <= 60 ? 110 : 100);
  const lower = road("w1", [[0, 0], [200, 0]], { tunnel: true, layer: -2 });
  const upper = road("w2", [[105, -100], [105, 100]], { tunnel: true, layer: -1, kind: "footway", width: 2.5 });
  const ways = [lower, upper, road("w3", [[-50, 0], [0, 0]]), road("w4", [[200, 0], [250, 0]])];
  ways.push(road("w5", [[105, -150], [105, -100]], { kind: "footway", width: 2.5 }), road("w6", [[105, 100], [105, 150]], { kind: "footway", width: 2.5 }));
  setTunnelFloors(features(ways), ground);
  const at = (way: Road, e: number, n: number) => defined(way.floor)[way.line.findIndex((p) => p[0] === e && p[1] === n)];
  for (const e of [100, 110]) {
    assert.ok(at(lower, e, 0) + ROAD_CLEARANCE_M + ROOF_M <= at(upper, 105, 0) + 1e-6, `${at(lower, e, 0)} under ${at(upper, 105, 0)}`);
  }
});

test("a branching tunnel's junction hangs between its portals", () => {
  // three branches from a junction at (100, 0) to portals at 100, 100 and 94, under ground at 200
  const a = road("w1", [[0, 0], [100, 0]], { tunnel: true, layer: -2 });
  const b = road("w2", [[100, 0], [200, 0]], { tunnel: true, layer: -2 });
  const c = road("w3", [[100, 0], [100, 100]], { tunnel: true, layer: -2, kind: "footway", width: 2 });
  const portal = (osm: string, p: Point, h: number) => ({ way: road(osm, [[p[0] - 1, p[1] - 1], p]), p, h });
  const portals = [portal("w4", [0, 0], 100), portal("w5", [200, 0], 100), portal("w6", [100, 100], 94)];
  const at = (e: number, n: number) => portals.find(({ p }) => Math.hypot(p[0] - e, p[1] - n) < 2)?.h ?? 200;
  setTunnelFloors(features([a, b, c, ...portals.map((p) => p.way)]), at);
  assert.equal(round(a.floor)?.at(-1), 98);
  assert.equal(round(c.floor)?.at(-1), 94);
});

test("tunnels in cuts and tunnels without known ground get no floor", () => {
  const cut = road("w1", [[0, 0], [50, 0]], { tunnel: true, layer: -1, lid: [100, 100] });
  const unknown = road("w2", [[0, 10], [50, 10]], { tunnel: true, layer: -1 });
  assert.deepEqual(counts(setTunnelFloors(features([cut, unknown]), () => undefined)), { floors: 0, ramps: 0 });
  assert.deepEqual([cut.floor, unknown.floor, cut.line.length], [undefined, undefined, 2]);
});

test("a way out of a portal comes down to the floor where the ground by the portal is the top of its wall", () => {
  // the tunnel's floor at 93 (the ground 4 m out); the ground rises to 120 at the portal
  const ground = (e: number) => (e < 0 ? 95 + e / 2 : 120);
  const tunnel = road("w1", [[0, 0], [100, 0]], { tunnel: true, layer: -1 });
  const out = road("w2", [[-20, 0], [0, 0]]);
  const map = features([out, tunnel]);
  assert.deepEqual(counts(setTunnelFloors(map, ground)), { floors: 1, ramps: 1 });
  // the ramp is split off the way: from where a 7 % slope from the floor meets the ground (4 m out) to the portal
  const ramp = defined(map.roads.find((r) => r.osm === "w2" && r.floor));
  assert.deepEqual(ramp.line, [[-4, 0], [0, 0]]);
  assert.deepEqual(ramp.floor, [93, 93]);
  assert.deepEqual([out.line, out.floor], [[[-20, 0], [-4, 0]], undefined]);
});

test("stairs up out of an underpass rise from its floor to the ground, and a lift's way is no portal", () => {
  // an underpass between portals at 100 under ground at 106 (a railway yard); stairs and a lift from a
  // branch up to a platform at 106
  const ground = (e: number) => (e <= 0 || e >= 100 ? 100 : 106);
  const hall = road("w1", [[0, 0], [50, 0], [100, 0]], { tunnel: true, layer: -1, kind: "footway", width: 4 });
  const branch = road("w2", [[50, 0], [50, -6]], { tunnel: true, layer: -1, kind: "footway", width: 2 });
  const stairs = road("w3", [[50, -6], [50, -20]], { kind: "steps", width: 2 });
  const shaft = road("w4", [[20, 0], [20, -3]], { tunnel: true, layer: -1, kind: "footway", width: 2 });
  const fromLift = road("w5", [[20, -3], [25, -3]], { kind: "footway", width: 2 });
  const outs = [road("w6", [[-20, 0], [0, 0]]), road("w7", [[100, 0], [120, 0]])];
  const map = features([hall, branch, stairs, shaft, fromLift, ...outs]);
  const levels = new Map([[hall, [0]], [branch, [0]], [stairs, [0, 1]], [shaft, [0]], [fromLift, [1]]]);
  setTunnelFloors(map, ground, levels);
  // the hall hangs from its portals, not from the stairs' foot, which is as deep as the hall
  assert.deepEqual([round(hall.floor), round(branch.floor)], [hall.line.map(() => 100), [100, 100]]);
  // the stairs rise from it to the ground as stairs do, 0.6 a meter: to 10 m of the 14 on
  const ramp = defined(map.roads.find((r) => r.osm === "w3" && r.floor));
  assert.deepEqual([ramp.line, round(ramp.floor)], [[[50, -6], [50, -16]], [100, 106]]);
  // the lift's way goes on from another storey: the shaft is a dead end, as deep as the hall there
  assert.equal(fromLift.floor, undefined);
  assert.equal(round(shaft.floor)?.at(-1), round(shaft.floor)?.[0]);
});

test("stairs are the portals of an underpass with no other way out, their foot as deep as the way needs", () => {
  const tunnel = road("w1", [[0, 0], [30, 0]], { tunnel: true, layer: -1, kind: "footway", width: 2 });
  const stairs = [road("w2", [[0, 0], [-10, 0]], { kind: "steps", width: 2 }), road("w3", [[30, 0], [40, 0]], { kind: "steps", width: 2 })];
  const map = features([tunnel, ...stairs]);
  setTunnelFloors(map, () => 100);
  assert.deepEqual(round(tunnel.floor), tunnel.line.map(() => 100 - 3 - ROOF_M));
  // rising 0.6 a meter, to the ground 8 m on
  const ramps = map.roads.filter((r) => r.kind === "steps" && r.floor);
  assert.deepEqual(ramps.map((r) => [r.line, round(r.floor)]), [[[[0, 0], [-8, 0]], [96, 100]], [[[30, 0], [38, 0]], [96, 100]]]);
});

test("stairs up out of an underpass where it goes on past them rise from its floor there, once out of its room", () => {
  // an underpass between portals at 100 under ground at 106, stairs up from its middle
  const ground = (e: number) => (e <= 0 || e >= 100 ? 100 : 106);
  const hall = road("w1", [[0, 0], [50, 0], [100, 0]], { tunnel: true, layer: -1, kind: "footway", width: 4 });
  const stairs = road("w2", [[50, 0], [50, -20]], { kind: "steps", width: 2 });
  const map = features([hall, stairs, road("w3", [[-20, 0], [0, 0]]), road("w4", [[100, 0], [120, 0]])]);
  setTunnelFloors(map, ground);
  assert.deepEqual(round(hall.floor), hall.line.map(() => 100));
  // level across the room (2 m and 1 m beside the way), then 0.6 a meter: to the ground 10 m on, met at the 2 m step after
  const ramp = defined(map.roads.find((r) => r.osm === "w2" && r.floor));
  assert.deepEqual([ramp.line, round(ramp.floor)], [[[50, 0], [50, -3], [50, -14]], [100, 100, 106]]);
});

test("a way ending at a ramp on its way ramps on from the ramp's floor there; a way passing through does not", () => {
  // a footway underpass 12 m long under a street on level ground at 100; the way out west ramps up 40 m
  const tunnel = road("w1", [[0, 0], [12, 0]], { tunnel: true, layer: -1, kind: "footway", width: 2.5 });
  const west = road("w3", [[-60, 0], [-20, 0], [-10, 0], [0, 0]], { kind: "footway", width: 2.5 });
  const joining = road("w5", [[-10, 0], [-10, -30]], { kind: "path", width: 1.5 });
  const across = road("w6", [[-20, -10], [-20, 0], [-20, 10]], { kind: "path", width: 1.5 });
  const map = features([west, tunnel, road("w4", [[12, 0], [72, 0]], { kind: "footway", width: 2.5 }), road("w2", [[6, -20], [6, 20]]), joining, across]);
  setTunnelFloors(map, () => 100);
  const ramp = defined(map.roads.find((r) => r.osm === "w3" && r.floor));
  const at = ramp.line.findIndex(([e]) => e === -10);
  assert.ok(defined(ramp.floor)[at] < 99, `the ramp at ${defined(ramp.floor)[at]}`);
  assert.deepEqual([joining.line[0], defined(joining.floor)[0], defined(joining.floor).at(-1)], [[-10, 0], defined(ramp.floor)[at], 100]);
  assert.equal(across.floor, undefined);
});

test("under water the floor is deeper by the water's depth and a bed over the roof", () => {
  // the elevation model has the water's surface, 100, over the middle of the tunnel
  const tunnel = road("w1", [[0, 0], [300, 0]], { tunnel: true, layer: -2 });
  const lake: Polygon = { outer: [[100, -50], [200, -50], [200, 50], [100, 50]], holes: [] };
  const map = features([road("w2", [[-50, 0], [0, 0]]), tunnel, road("w3", [[300, 0], [350, 0]])]);
  map.areas.push({ osm: "w4", kind: "water", polygon: lake });
  setTunnelFloors(map, () => 100);
  assert.equal(Math.round(Math.min(...defined(tunnel.floor)) * 10) / 10, 100 - ROAD_CLEARANCE_M - ROOF_M - WATER_DEPTH_M - BED_M);
});

test("water over only the side of a tunnel's room takes it under the water's surface there", () => {
  // a river falling across the tunnel: its surface 96 over the room's south side, the ground 100 over its line
  const tunnel = road("w1", [[0, 0], [300, 0]], { tunnel: true, layer: -2 });
  const river: Polygon = { outer: [[100, -50], [200, -50], [200, -3], [100, -3]], holes: [] };
  const map = features([road("w2", [[-50, 0], [0, 0]]), tunnel, road("w3", [[300, 0], [350, 0]])]);
  map.areas.push({ osm: "w4", kind: "water", polygon: river });
  setTunnelFloors(map, (_, n) => (n < -3 ? 96 : 100));
  assert.equal(Math.round(Math.min(...defined(tunnel.floor)) * 10) / 10, 96 - ROAD_CLEARANCE_M - ROOF_M - WATER_DEPTH_M - BED_M);
});

test("tunnels on level ground run at the ground: railways anywhere, roads and paths under buildings", () => {
  const level = () => 100;
  const hill = (e: number) => (e > 20 && e < 80 ? 115 : 100);
  const outer: Point[] = [[20, -20], [80, -20], [80, 20], [20, 20]];
  const arena: Building = { osm: "w9", kind: "stadium", part: false, hasParts: false, height: 20, minHeight: 3, polygon: { outer, holes: [] } };
  const railway: Rail = { osm: "w1", kind: "rail", layer: -1, bridge: false, tunnel: true, line: [[0, 0], [100, 0]] };
  const underArena = road("w2", [[0, 10], [100, 10]], { tunnel: true, layer: -1 });
  const underStreet = road("w3", [[50, -60], [50, 60]], { tunnel: true, layer: -1, kind: "footway", width: 2 });
  const deep = road("w4", [[0, 30], [100, 30]], { tunnel: true, layer: -2 });
  // a deck over the railway mapped as an open roof, 5 m tall
  const deck: Building = { osm: "w8", kind: "roof", part: true, hasParts: false, height: 5, minHeight: 0, shelter: "roof", polygon: { outer: [[85, -5], [95, -5], [95, 5], [85, 5]], holes: [] } };
  // a house on the deck, standing on the ground in OSM
  const house: Building = { osm: "w7", kind: "apartments", part: false, hasParts: false, height: 24, minHeight: 0, polygon: { outer: [[60, -5], [70, -5], [70, 5], [60, 5]], holes: [] } };
  const map = features([underArena, underStreet, deep], [railway]);
  map.buildings.push(arena, deck, house);
  assert.equal(uncoverAtGrade(map, level), 2);
  assert.deepEqual([railway.tunnel, underArena.tunnel, underStreet.tunnel, deep.tunnel], [false, false, true, true]);
  // the arena's walls open for the railway, as tall as a railway tunnel's room
  assert.ok(arena.passages?.some((o) => o.height === RAIL_CLEARANCE_M));
  // the roof over the railway becomes a deck over its room, without the posts of a roof
  assert.deepEqual([deck.shelter, deck.minHeight, deck.height], [undefined, RAIL_CLEARANCE_M, RAIL_CLEARANCE_M + ROOF_M]);
  // the arena, raised 3 m off the ground in OSM, starts over the railway's room, its top where it was
  assert.deepEqual([arena.minHeight, arena.height], [RAIL_CLEARANCE_M, 20]);
  assert.deepEqual([house.minHeight, house.height], [RAIL_CLEARANCE_M, 24]);
  // under a hill a railway stays in its tunnel
  const underHill: Rail = { ...railway, tunnel: true };
  assert.equal(uncoverAtGrade(features([], [underHill]), hill), 0);
});

test("a tunnel's short branch into a building stays in the tunnel it leaves", () => {
  const tunnel = road("w1", [[0, -50], [0, 0], [0, 50]], { tunnel: true, layer: -1, kind: "footway", width: 2.5 });
  // its far end inside the building: one of its two points
  const branch = road("w2", [[0, 0], [1.98, 0]], { tunnel: true, layer: -1, kind: "footway", width: 2.5 });
  const house: Building = { osm: "w9", kind: "yes", part: false, hasParts: false, height: 3, minHeight: 0, polygon: { outer: [[1.5, -5], [10, -5], [10, 5], [1.5, 5]], holes: [] } };
  const map = features([tunnel, branch]);
  map.buildings.push(house);
  assert.equal(uncoverAtGrade(map, () => 100), 0);
  assert.deepEqual([tunnel.tunnel, branch.tunnel], [true, true]);
  // alone it would run at the ground
  const alone = features([road("w3", branch.line, { tunnel: true, layer: -1, kind: "footway", width: 2.5 })]);
  alone.buildings.push({ ...house, passages: undefined });
  assert.equal(uncoverAtGrade(alone, () => 100), 1);
});

test("under a way crossing over it the floor is deep enough under that way, falling to it from the portals", () => {
  // a footway underpass 12 m long under a street across its middle, on level ground at 100
  const tunnel = road("w1", [[0, 0], [12, 0]], { tunnel: true, layer: -1, kind: "footway", width: 2.5 });
  const street = road("w2", [[6, -20], [6, 20]]);
  const west = road("w3", [[-60, 0], [0, 0]], { kind: "footway", width: 2.5 });
  const east = road("w4", [[12, 0], [72, 0]], { kind: "footway", width: 2.5 });
  // a street crossing at the same level beyond the portal, and a deep tunnel crossing under it, are not over it
  const beyond = road("w5", [[-40, -20], [-40, 20]]);
  const under = road("w6", [[3, -20], [3, 20]], { tunnel: true, layer: -2 });
  const map = features([west, tunnel, east, street, beyond, under]);
  setTunnelFloors(map, () => 100);
  const depth = 3 + ROOF_M;
  const floor = defined(tunnel.floor);
  const middle = tunnel.line.findIndex(([e]) => e === 6);
  // the tunnel's points either side of the street are deep enough under it
  for (const [i, [e]] of tunnel.line.entries()) {
    assert.ok(floor[i] <= 100 - depth + 0.07 * Math.abs(e - 6) + 1e-9, `floor ${floor[i]} at ${e}`);
  }
  assert.ok(middle < 0 || floor[middle] <= 100 - depth);
  // the ways leading on ramp down to the portals
  const ramps = map.roads.filter((r) => (r.osm === "w3" || r.osm === "w4") && r.floor);
  assert.equal(ramps.length, 2);
  assert.equal(beyond.floor, undefined);
});

test("a tunnel under a bridge's deck gets the room the deck leaves over its floor under its roof, within reason", () => {
  const tunnel = road("w1", [[0, 0], [12, 0]], { tunnel: true, layer: -1, kind: "cycleway", width: 2.5, floor: [89.1, 88.8] });
  const deep = road("w2", [[0, 10], [12, 10]], { tunnel: true, layer: -1, kind: "footway", width: 2.5, floor: [80, 80] });
  const low = road("w3", [[0, 20], [12, 20]], { tunnel: true, layer: -1, kind: "footway", width: 2.5, floor: [90, 90] });
  const deckOver = ([e]: Point) => (e >= 4 && e <= 8 ? { deck: 92.4 } : undefined);
  assert.equal(fitRoomsUnderDecks([tunnel, deep, low], deckOver), 2);
  // its floor under the deck's ends at 89.0 and 88.9: 92.4 less the roof's 1 m and 89.0
  assert.ok(Math.abs(defined(tunnel.room) - 2.4) < 1e-9, `${tunnel.room}`);
  assert.equal(deep.room, undefined);
  assert.equal(low.room, 2.2);
});

test("a way beside a tunnel under an open roof over its portal is not over it: the tunnel is a covered cut there", () => {
  // a ramp 20 m long from a portal on level ground at 100 into a garage, and a footway along it over its room's side
  const floorWith = (roof: Building[], footwayEnd = 25) => {
    const tunnel = road("w1", [[0, 0], [20, 0]], { tunnel: true, layer: -1, kind: "service", width: 4 });
    const footway = road("w3", [[-5, -4], [footwayEnd, -4]], { kind: "footway", width: 2.5 });
    const map = { ...features([road("w2", [[-20, 0], [0, 0]], { kind: "service", width: 4 }), tunnel, footway]), buildings: roof };
    setTunnelFloors(map, () => 100);
    return round(tunnel.floor)?.[0];
  };
  const roof = (outer: Point[]): Building => ({ osm: "w4", kind: "roof", part: false, hasParts: false, height: 5, minHeight: 0, shelter: "roof", polygon: { outer, holes: [] } });
  assert.equal(floorWith([]), 100 - ROAD_CLEARANCE_M - ROOF_M);
  assert.equal(floorWith([roof([[0, -3], [20, -3], [20, 3], [0, 3]])]), 100);
  // a roof over the tunnel's middle only, over its end where no way leads on, or over its portal but not most of
  // it (the inside of a building going on), covers no ramp
  assert.equal(floorWith([roof([[-2, -3], [8, -3], [8, 3], [-2, 3]])], 6), 100 - ROAD_CLEARANCE_M - ROOF_M);
  assert.equal(floorWith([roof([[5, -3], [15, -3], [15, 3], [5, 3]])]), 100 - ROAD_CLEARANCE_M - ROOF_M);
  assert.equal(floorWith([roof([[15, -3], [20, -3], [20, 3], [15, 3]])]), 100 - ROAD_CLEARANCE_M - ROOF_M);
});

test("a roof over stairs up out of a tunnel (a platform's) covers no cut", () => {
  // an underpass 10 m long from a portal on level ground at 100, stairs up from its end under a platform's roof,
  // and a path over its room's side there
  const floorAt = (buildings: Building[]) => {
    const tunnel = road("w1", [[0, 0], [10, 0]], { tunnel: true, layer: -1, kind: "footway", width: 3 });
    const stairs = road("w2", [[10, 0], [20, 0]], { kind: "steps", width: 2 });
    const path = road("w3", [[6, -3], [20, -3]], { kind: "footway", width: 2 });
    setTunnelFloors({ ...features([road("w4", [[-20, 0], [0, 0]], { kind: "footway", width: 3 }), tunnel, stairs, path]), buildings }, () => 100);
    return round(tunnel.floor)?.at(-1);
  };
  const outer: Point[] = [[5, -5], [25, -5], [25, 5], [5, 5]];
  assert.equal(floorAt([{ osm: "w5", kind: "roof", part: false, hasParts: false, height: 4, minHeight: 0, shelter: "roof", polygon: { outer, holes: [] } }]), 100 - 3 - ROOF_M);
});

test("a tunnel's floor under a wavy hill does not rise with its waves, and is deep enough", () => {
  // a hill of 130 with waves of 2 m every 20 m; portals at 100 at e = 0 and 200
  const ground = (e: number) => (e <= 0 || e >= 200 ? 100 : 104 + 2 * Math.sin((e * Math.PI) / 20));
  const tunnel = road("w1", [[0, 0], [200, 0]], { tunnel: true, layer: -2 });
  const map = features([road("w2", [[-50, 0], [0, 0]]), tunnel, road("w3", [[200, 0], [250, 0]])]);
  setTunnelFloors(map, ground);
  const floor = defined(tunnel.floor);
  // no point over the line between its neighbours (the ground's humps); the floor may still bend down
  for (let i = 1; i + 1 < floor.length; i++) {
    const bend = floor[i] - (floor[i - 1] + floor[i + 1]) / 2;
    assert.ok(bend <= 0.1 + 1e-3, `bend ${bend.toFixed(2)} at ${tunnel.line[i][0]}`);
  }
  // deep enough everywhere: the room and roof under the ground around each point
  for (const [i, [e]] of tunnel.line.entries()) {
    if (e > 30 && e < 170) {
      assert.ok(floor[i] <= Math.min(ground(e - 5), ground(e), ground(e + 5)) - ROAD_CLEARANCE_M - ROOF_M + 1e-9);
    }
  }
});

// a footway underpass from x = 0 to 40 under ground at 104, out at its east end into a cut by a 0.5 m way
const underpass = () => road("w1", [[0, 0], [40, 0]], { tunnel: true, layer: -1, kind: "footway", width: 2.5 });
const stub = () => road("w3", [[40, 0], [40.5, 0]], { kind: "pedestrian", width: 5 });

test("a way going on past a portal from a short way out of it is not over the tunnel", () => {
  // the cut beyond the portal at 100, and a street over the tunnel's middle
  const ground = (e: number) => (e <= 40 ? 104 : 100);
  const tunnel = underpass();
  const onward = road("w4", [[40.5, 0], [80, 0]], { kind: "cycleway", width: 2.5 });
  const map = features([road("w2", [[-20, 0], [0, 0]]), tunnel, stub(), onward, road("w5", [[20, -20], [20, 20]])]);
  setTunnelFloors(map, ground);
  // the portal's floor is the cut's, not 4 m under it
  assert.equal(round(tunnel.floor)?.at(-1), 100);
});

test("a ramp goes on past a short way out of a portal, up to the ground 8 m from the portal", () => {
  // the cut beyond the portal at 102; a street over the tunnel by the portal takes the floor down to 100
  const ground = (e: number) => (e <= 40 ? 104 : 102);
  const tunnel = underpass();
  const short = stub();
  const onward = road("w4", [[40.5, 0], [80, 0]], { kind: "cycleway", width: 2.5 });
  const map = features([road("w2", [[-20, 0], [0, 0]]), tunnel, short, onward, road("w5", [[36, -20], [36, 20]])]);
  setTunnelFloors(map, ground);
  assert.equal(round(tunnel.floor)?.at(-1), 100);
  // the short way rises 7 % of its 0.5 m, and the way on from it, short of where 7 % would meet the ground, to it 8 m out
  assert.deepEqual(round(short.floor), [100, 100]);
  const ramp = defined(map.roads.find((r) => r.osm === "w4" && r.floor));
  assert.deepEqual([ramp.line, round(ramp.floor)], [[[40.5, 0], [48, 0]], [100, 102]]);
  assert.deepEqual(onward.line, [[48, 0], [80, 0]]);
});

test("the ground over a tunnel's end is raised to the ground in from it, where the model slopes down to the portal", () => {
  // the model smooths the portal's wall over the tunnel's last 4 m, down to the cut at 100
  const ground = (e: number) => (e <= 36 ? 104 : e >= 40 ? 100 : 104 - (e - 36));
  const tunnel = underpass();
  // a cycleway over the portal, 1.2 m in from it
  const over = road("w4", [[38.8, -20], [38.8, 20]], { kind: "cycleway", width: 2.5 });
  const map = features([road("w2", [[-20, 0], [0, 0]]), tunnel, stub(), road("w5", [[40.5, 0], [80, 0]]), over]);
  const { walls } = setTunnelFloors(map, ground);
  const wallsAt = portalWallsAt(walls);
  // over the room from the portal 6 m in, as high as the ground there; not beyond the portal, nor beside the room off the cycleway
  assert.deepEqual([wallsAt(38, 0), wallsAt(34.5, 2), wallsAt(40.5, 0), wallsAt(35, 2.5), wallsAt(20, 0)], [104, 104, undefined, undefined, undefined]);
  assert.deepEqual([raiseToWalls(ground, wallsAt)(38.8, 0), raiseToWalls(ground, wallsAt)(42, 0)], [104, 100]);
  // the floor is room and roof under the raised ground under the cycleway, not under the slope
  assert.equal(round(tunnel.floor)?.at(-1), 100);
});

test("a ramp does not go on where a way passes through the short way's end: the short way rises to the ground there", () => {
  const ground = (e: number) => (e <= 40 ? 104 : 102);
  const short = stub();
  const across = road("w6", [[40.5, -20], [40.5, 0], [40.5, 20]], { kind: "service", width: 4 });
  const map = features([road("w2", [[-20, 0], [0, 0]]), underpass(), short, road("w4", [[40.5, 0], [80, 0]], { kind: "cycleway", width: 2.5 }), across, road("w5", [[36, -20], [36, 20]])]);
  setTunnelFloors(map, ground);
  assert.deepEqual(round(short.floor), [100, 102]);
  assert.equal(map.roads.filter((r) => r.osm === "w4" && r.floor).length, 0);
});

test("a ramp goes on only past a way short enough to leave 4 m of the 8 to rise in; a longer way rises to the ground itself", () => {
  const ground = (e: number) => (e <= 40 ? 104 : 102);
  const longer = road("w3", [[40, 0], [46.5, 0]], { kind: "footway", width: 2.5 });
  const map = features([road("w2", [[-20, 0], [0, 0]]), underpass(), longer, road("w4", [[46.5, 0], [80, 0]], { kind: "cycleway", width: 2.5 }), road("w5", [[36, -20], [36, 20]])]);
  setTunnelFloors(map, ground);
  assert.deepEqual(round(longer.floor), [100, 102]);
  assert.equal(map.roads.filter((r) => r.osm === "w4" && r.floor).length, 0);
});

test("a way over a portal is level over the cut in front of it, wider than the tunnel, and the cut stays", () => {
  // the cut 12 m wide, its wall smoothed over the tunnel's last 4 m and beside it
  const ground = (e: number, n: number) => (Math.abs(n) > 6 || e <= 36 ? 104 : e >= 40 ? 100 : 104 - (e - 36));
  const over = road("w4", [[38.8, -20], [38.8, 20]], { kind: "cycleway", width: 2.5 });
  const map = features([road("w2", [[-20, 0], [0, 0]]), underpass(), stub(), road("w5", [[40.5, 0], [80, 0]]), over]);
  const at = raiseToWalls(ground, portalWallsAt(setTunnelFloors(map, ground).walls));
  // under the cycleway over the room and beside it, as far as the cut reaches; the cut in front of the portal
  assert.deepEqual([at(38.8, 0), at(38.8, 4.5), at(38.8, -5.5), at(38.8, 9), at(41, 4), at(42, 0)], [104, 104, 104, 104, 100, 100]);
});

test("a levelled way's ground is raised around its ends too, a portal's wall only from its face in", () => {
  const walls = [
    { line: [[40, 0], [34, 0]] satisfies Point[], half: 2, top: 104 },
    { line: [[38, -5], [38, 5]] satisfies Point[], half: 1, top: 104, round: true },
  ];
  const at = portalWallsAt(walls);
  assert.deepEqual([at(40.5, 0), at(38, 5.8), at(38, 6.5)], [undefined, 104, undefined]);
});

test("tunnels side by side in one hall get one floor, the lower, at their portals too; apart they keep their own", () => {
  // a footway and a cycleway along e under ground at 110, from portals at 100 (the footway's) and 100.3 to 98
  const pair = (gap: number) => {
    const ground = (e: number, n: number) => (e <= 0 ? (n < gap / 2 ? 100 : 100.3) : e >= 200 ? 98 : 110);
    const footway = road("w1", [[0, 0], [200, 0]], { tunnel: true, layer: -1, kind: "footway", width: 2.5 });
    const cycleway = road("w2", [[0, gap], [200, gap]], { tunnel: true, layer: -1, kind: "cycleway", width: 4 });
    const outs = [road("w3", [[-20, 0], [0, 0]]), road("w4", [[200, 0], [220, 0]]), road("w5", [[-20, gap], [0, gap]]), road("w6", [[200, gap], [220, gap]])];
    setTunnelFloors(features([footway, cycleway, ...outs]), ground);
    return [defined(footway.floor), defined(cycleway.floor)];
  };
  // rooms 2.25 m and 3 m to either side: one hall 3.5 m apart
  const [footway, cycleway] = pair(3.5);
  assert.deepEqual(round(cycleway), round(footway));
  assert.deepEqual([round(footway)?.[0], round(footway)?.at(-1)], [100, 98]);
  const [, apart] = pair(20);
  assert.equal(round(apart)?.[0], 100.3);
});

test("stairs' feet in one hall stay where they are, so their stairs rise no steeper", () => {
  // two underpasses side by side from portals at 100 and 100.3, under a yard at 106, each up stairs at its end
  const pair = (gap: number) => {
    const ground = (e: number, n: number) => (e <= 0 ? (n < gap / 2 ? 100 : 100.3) : 106);
    const footway = road("w1", [[0, 0], [60, 0]], { tunnel: true, layer: -1, kind: "footway", width: 2.5 });
    const cycleway = road("w2", [[0, gap], [60, gap]], { tunnel: true, layer: -1, kind: "cycleway", width: 4 });
    const stairs = [road("w3", [[60, 0], [60, -15]], { kind: "steps", width: 2 }), road("w4", [[60, gap], [60, gap + 15]], { kind: "steps", width: 2 })];
    const outs = [road("w5", [[-20, 0], [0, 0]]), road("w6", [[-20, gap], [0, gap]])];
    setTunnelFloors(features([footway, cycleway, ...stairs, ...outs]), ground);
    return [defined(footway.floor), defined(cycleway.floor)];
  };
  const [footway, cycleway] = pair(3.5);
  const [, apart] = pair(20);
  assert.equal(round(cycleway)?.at(-1), round(apart)?.at(-1));
  assert.deepEqual(round(cycleway.slice(0, -1)), round(footway.slice(0, -1)));
});

test("a tunnel's floor does not depend on tunnels crossing elsewhere: each group of tunnels that touch goes through the passes on its own", () => {
  // a footway beside a road tunnel in one hall, under a hill with steps in it; far north a tunnel under another
  const bumps = [3, 3, 5.7, 18.6, 0.2, 17.8];
  const ground = (e: number, n: number) => (n > 500 ? 100 : e <= 0 ? (n > 3.5 ? 97.8 : 96.4) : e >= 60 ? (n > 3.5 ? 102.9 : 97.3) : 100 + bumps[Math.min(5, Math.floor(e / 10))]);
  const floors = (far: boolean) => {
    const a = road("w1", [[0, 0], [60, 0]], { tunnel: true, layer: -1 });
    const b = road("w2", [[0, 7], [46, 7]], { tunnel: true, layer: -1, kind: "footway", width: 2.5 });
    const outs = [road("w3", [[-20, 0], [0, 0]]), road("w4", [[60, 0], [80, 0]]), road("w5", [[-20, 7], [0, 7]])];
    const crossing = far
      ? [road("w6", [[0, 1000], [100, 1000]], { tunnel: true, layer: -1 }), road("w7", [[55, 950], [55, 1050]], { tunnel: true, layer: -2 }), road("w8", [[-20, 1000], [0, 1000]]), road("w9", [[100, 1000], [120, 1000]]), road("w10", [[55, 930], [55, 950]]), road("w11", [[55, 1050], [55, 1070]])]
      : [];
    setTunnelFloors(features([a, b, ...outs, ...crossing]), ground);
    return [a.floor, b.floor].map((floor) => floor?.map((v) => Math.round(v * 100) / 100));
  };
  assert.deepEqual(floors(false), floors(true));
});

test("a ramp down from a portal in a building goes down at one steady grade, however steep; from a portal in the open, as before", () => {
  // a 25 m ramp down from a street at 100 on level ground, to a dead end where a corridor goes on
  const floors = (building: "over" | "small" | "none") => {
    const ramp = road("w1", [[0, 0], [25, 0]], { kind: "service", width: 4, tunnel: true, layer: -1 });
    const corridor = road("w2", [[25, 0], [25, 20]], { kind: "corridor", width: 3, tunnel: true, layer: -1 });
    const map = features([road("w3", [[-20, 0], [0, 0]], { kind: "service", width: 4 }), ramp, corridor]);
    // a house over the ramp, or a small one only around its portal, which the ramp goes away from
    const outer: Point[] = building === "over" ? [[0, -10], [30, -10], [30, 30], [0, 30]] : [[-3, -3], [3, -3], [3, 3], [-3, 3]];
    if (building !== "none") {
      map.buildings.push({ osm: "w9", kind: "apartments", part: false, hasParts: false, height: 20, minHeight: 0, polygon: { outer, holes: [] } });
    }
    const { basements } = setTunnelFloors(map, () => 100);
    const floor = defined(ramp.floor);
    const along = ramp.line.map(([e]) => e);
    return { grades: floor.slice(1).map((f, i) => (floor[i] - f) / (along[i + 1] - along[i])), basements: basements.map((w) => w.osm) };
  };
  const steady = floors("over");
  // a car park's room under the house
  const grade = (100 - (100 - (ROOF_M + CAR_PARK_CLEARANCE_M) * (25 / 30))) / 25;
  for (const g of steady.grades) {
    assert.ok(Math.abs(g - grade) < 0.01, `${g} is the steady ${grade}`);
  }
  // they go down into a basement, the corridor on from the ramp too
  assert.deepEqual(steady.basements, ["w1", "w2"]);
  // in the open, past the first step down no steeper than 7 %
  const open = floors("none");
  assert.ok(open.grades[0] > grade);
  for (const g of open.grades.slice(1)) {
    assert.ok(g <= 0.07 + 1e-9, `${g}`);
  }
  assert.deepEqual(open.basements, []);
  assert.deepEqual(floors("small"), open);
});

test("a ramp down into a basement opens the walls it crosses with its room over their lowest ground, from its floor there", () => {
  // a house from e = 0 to 20, n = 0 to 30, the ramp in at its corner from a way at 100 and under its east wall
  const house = (): Building => ({ osm: "w9", kind: "apartments", part: false, hasParts: false, height: 20, minHeight: 0, polygon: { outer: [[0, 0], [20, 0], [20, 30], [0, 30]], holes: [] } });
  const approach = road("w2", [[-10, -10], [0, 0]], { kind: "service", width: 4 });
  const ground = () => 100;
  const shallow = house();
  const ramp = road("w1", [[0, 0], [25, 25]], { kind: "service", width: 4, tunnel: true, layer: -1, floor: [100, 95] });
  assert.equal(openPortals([shallow], [ramp], [ramp, approach], ground) > 0, true);
  const openings = defined(shallow.passages);
  const at = (o: (typeof openings)[number]) => [(o.from[0] + o.to[0]) / 2, (o.from[1] + o.to[1]) / 2];
  const portal = openings.filter((o) => Math.hypot(...at(o)) < 4);
  const east = openings.filter((o) => o.from[0] === 20 && o.to[0] === 20);
  assert.ok(portal.length > 0 && east.length > 0);
  assert.equal(portal.length + east.length, openings.length);
  // the floor at the opening's middle, a little in from the portal
  for (const o of portal) {
    assert.ok(Math.abs((o.ground ?? 0) - 100) < 0.3, `${o.ground}`);
  }
  // under the east wall at e = 20 the floor is 4/5 down the ramp
  for (const o of east) {
    assert.ok(Math.abs((o.ground ?? 0) - 96) < 0.2, `${o.ground}`);
  }
  for (const o of openings) {
    assert.equal(o.height, roomHeight(ramp));
  }
  assert.equal(shallow.passageRooms, undefined);
  // deeper there, its room under the house's lowest ground: the east wall stays whole
  const deep = house();
  const steep = road("w1", [[0, 0], [25, 25]], { kind: "service", width: 4, tunnel: true, layer: -1, floor: [100, 85] });
  openPortals([deep], [steep], [steep, approach], ground);
  assert.ok(defined(deep.passages).every((o) => Math.hypot(...at(o)) < 4));
  // a short piece of wall left beside the opening, up to a corner, opens too; a long one stays
  const notched: Building = { ...house(), polygon: { outer: [[0, 0], [3, 0], [3, -1], [20, -1], [20, 30], [0, 30]], holes: [] } };
  openPortals([notched], [ramp], [ramp, approach], ground);
  const ends = defined(notched.passages).flatMap((o) => [o.from, o.to]);
  assert.ok(ends.some(([e, n]) => e === 3 && n === 0), `${JSON.stringify(ends)} reach the corner at (3, 0)`);
  assert.ok(!ends.some(([e, n]) => e === 0 && n === 30), "the long west wall stays");
  // a way without a floor, or crossing no wall: none
  const closed = house();
  const noFloor = road("w5", [[0, 0], [25, 25]], { kind: "service", width: 4, tunnel: true, layer: -1 });
  const inside = road("w6", [[5, 5], [15, 15]], { kind: "corridor", width: 3, tunnel: true, layer: -1, floor: [95, 95] });
  assert.equal(openPortals([closed], [noFloor, inside], [noFloor, inside, approach], ground), 0);
  assert.equal(closed.passages, undefined);
});

test("from a portal in a building the floor eases in only under it: beyond its walls the room and roof are under the ground", () => {
  // a 40 m ramp down from a street at 100 on level ground, in through a house from e = -3 to 12, out under the open
  // ground to a corridor going on
  const floors = (inHouse: boolean) => {
    const ramp = road("w1", [[0, 0], [40, 0]], { kind: "service", width: 4, tunnel: true, layer: -1 });
    const corridor = road("w2", [[40, 0], [40, 20]], { kind: "corridor", width: 3, tunnel: true, layer: -1 });
    const map = features([road("w3", [[-20, 0], [0, 0]], { kind: "service", width: 4 }), ramp, corridor]);
    if (inHouse) {
      map.buildings.push({ osm: "w9", kind: "apartments", part: false, hasParts: false, height: 20, minHeight: 0, polygon: { outer: [[-3, -10], [12, -10], [12, 10], [-3, 10]], holes: [] } });
    }
    setTunnelFloors(map, () => 100);
    return { ramp, floor: defined(ramp.floor) };
  };
  const { ramp, floor } = floors(true);
  ramp.line.forEach(([e], i) => {
    if (e > 12) {
      assert.ok(floor[i] + roomHeight(ramp) + ROOF_M <= 100 + 1e-6, `at ${e} the roof's top ${floor[i] + roomHeight(ramp) + ROOF_M} is under the ground`);
    }
  });
  // from a portal in the open, eased in as before: 20 m in, not yet as deep as its room and roof
  const open = floors(false);
  const at20 = open.floor[open.ramp.line.findIndex(([e]) => e >= 20)];
  assert.ok(100 - at20 < roomHeight(open.ramp) + ROOF_M - 0.5, `${at20}`);
});

test("the tunnels going down into a car park under a building get a car park's room, unless a road leads in", () => {
  const house: Building = { osm: "w9", kind: "apartments", part: false, hasParts: false, height: 20, minHeight: 0, polygon: { outer: [[-3, -10], [40, -10], [40, 30], [-3, 30]], holes: [] } };
  const map = (kind: string, inHouse: boolean) => {
    const ramp = road("w1", [[0, 0], [25, 0]], { kind, width: 4, tunnel: true, layer: -1 });
    const corridor = road("w2", [[25, 0], [25, 20]], { kind: "corridor", width: 3, tunnel: true, layer: -1 });
    const m = features([road("w3", [[-20, 0], [0, 0]], { kind: "service", width: 4 }), ramp, corridor]);
    if (inHouse) {
      m.buildings.push(house);
    }
    setTunnelFloors(m, () => 100);
    return [ramp, corridor].map(roomHeight);
  };
  assert.deepEqual(map("service", true), [CAR_PARK_CLEARANCE_M, CAR_PARK_CLEARANCE_M]);
  assert.deepEqual(map("residential", true), [ROAD_CLEARANCE_M, 3]);
  assert.deepEqual(map("service", false), [ROAD_CLEARANCE_M, 3]);
});
