import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point, Polygon } from "./geometry.ts";
import type { Building, MapFeatures, Rail, Road } from "./osm.ts";
import { defined } from "./testing.ts";
import { densify, RAIL_CLEARANCE_M, ROAD_CLEARANCE_M, ROOF_M, setTunnelFloors, uncoverAtGrade, WATER_DEPTH_M } from "./tunnels.ts";

function road(osm: string, line: Point[], extra: Partial<Road> = {}): Road {
  return { osm, kind: "primary", width: 8, layer: 0, bridge: false, tunnel: false, line, ...extra };
}

function features(roads: Road[], rails: Rail[] = []): MapFeatures {
  return { roads, rails, buildings: [], areas: [], trees: [], lamps: [] };
}

const round = (values: number[] | undefined) => values?.map((v) => Math.round(v * 10) / 10);

test("densify adds points so none are further apart than the step", () => {
  assert.deepEqual(densify([[0, 0], [25, 0], [30, 0]], 10), [[0, 0], [25 / 3, 0], [50 / 3, 0], [25, 0], [30, 0]]);
});

test("a tunnel's floor goes straight from portal to portal when the ground over it is high enough", () => {
  // portals at 100 and 90 at e = 0 and 200, a hill of 130 over the tunnel between
  const ground = (e: number) => (e <= 0 ? 100 : e >= 200 ? 90 : 130);
  const tunnel = road("w1", [[0, 0], [200, 0]], { tunnel: true, layer: -2 });
  const map = features([road("w2", [[-50, 0], [0, 0]]), tunnel, road("w3", [[200, 0], [250, 0]])]);
  assert.deepEqual(setTunnelFloors(map, ground), { floors: 1, ramps: 0 });
  assert.equal(tunnel.line.length, 21);
  assert.deepEqual(round(tunnel.floor), tunnel.line.map(([e]) => Math.round((100 - e / 20) * 10) / 10));
});

test("a portal's floor is the ramp's just outside it, not the top of the portal's wall", () => {
  const ground = (e: number) => (e < 0 ? 95 + e / 2 : 120);
  const tunnel = road("w1", [[0, 0], [100, 0]], { tunnel: true, layer: -1 });
  setTunnelFloors(features([road("w2", [[-20, 0], [0, 0]]), tunnel]), ground);
  assert.equal(round(tunnel.floor)?.[0], 93);
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
  assert.deepEqual(setTunnelFloors(features([cut, unknown]), () => undefined), { floors: 0, ramps: 0 });
  assert.deepEqual([cut.floor, unknown.floor, cut.line.length], [undefined, undefined, 2]);
});

test("a way out of a portal comes down to the floor where the ground by the portal is the top of its wall", () => {
  // the tunnel's floor at 93 (the ground 4 m out); the ground rises to 120 at the portal
  const ground = (e: number) => (e < 0 ? 95 + e / 2 : 120);
  const tunnel = road("w1", [[0, 0], [100, 0]], { tunnel: true, layer: -1 });
  const out = road("w2", [[-20, 0], [0, 0]]);
  const map = features([out, tunnel]);
  assert.deepEqual(setTunnelFloors(map, ground), { floors: 1, ramps: 1 });
  // the ramp is split off the way: from where a 7 % slope from the floor meets the ground (4 m out) to the portal
  const ramp = defined(map.roads.find((r) => r.osm === "w2" && r.floor));
  assert.deepEqual(ramp.line, [[-4, 0], [0, 0]]);
  assert.deepEqual(ramp.floor, [93, 93]);
  assert.deepEqual([out.line, out.floor], [[[-20, 0], [-4, 0]], undefined]);
});

test("under water the floor is deeper by the water's depth", () => {
  // the elevation model has the water's surface, 100, over the middle of the tunnel
  const tunnel = road("w1", [[0, 0], [300, 0]], { tunnel: true, layer: -2 });
  const lake: Polygon = { outer: [[100, -50], [200, -50], [200, 50], [100, 50]], holes: [] };
  const map = features([road("w2", [[-50, 0], [0, 0]]), tunnel, road("w3", [[300, 0], [350, 0]])]);
  map.areas.push({ osm: "w4", kind: "water", polygon: lake });
  setTunnelFloors(map, () => 100);
  assert.equal(Math.round(Math.min(...defined(tunnel.floor)) * 10) / 10, 100 - ROAD_CLEARANCE_M - ROOF_M - WATER_DEPTH_M);
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
