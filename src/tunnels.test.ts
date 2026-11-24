import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point, Polygon } from "./geometry.ts";
import type { Building, MapFeatures, Rail, Road } from "./osm.ts";
import { inTunnel } from "./profile.ts";
import { defined } from "./testing.ts";
import { easedDepth, type KnownFloor } from "./floors.ts";
import { solveHeights } from "./heights.ts";
import { loadLp } from "./lp.ts";
import { BED_M, CAR_PARK_CLEARANCE_M, COVER_M, WALL_FOOTING_M, fitRoomsUnderDecks, openPortals, portalWallsAt, raiseToWalls, roomHeight, setTunnelRooms, tunnelNetwork, uncoverAtGrade, WATER_DEPTH_M } from "./tunnels.ts";
import { CLEARANCE_M, MAX_BEND_M, ROOF_M } from "./ways.ts";

function road(osm: string, line: Point[], extra: Partial<Road> = {}): Road {
  return { osm, kind: "primary", width: 8, layer: 0, bridge: false, tunnel: false, line, ...extra };
}

function features(roads: Road[], rails: Rail[] = []): MapFeatures {
  return { roads, rails, buildings: [], areas: [], trees: [], lamps: [], crossings: [], signals: [], gates: [], barriers: [], playEquipment: [], bridgeDecks: [] };
}

const lp = await loadLp();

/** The tunnels' floors and the ramps out of their portals solved (heights.ts) */
function solveTunnels(map: MapFeatures, ground: (e: number, n: number) => number | undefined, levels: ReadonlyMap<Road | Rail, number[]> = new Map(), known: KnownFloor[] = []) {
  const solved = solveHeights(map, ground, lp, { levels, known });
  return { ...solved, ramps: solved.cuts, walls: solved.network.walls };
}

const round = (values: number[] | undefined) => values?.map((v) => Math.round(v * 10) / 10);
const counts = ({ floors, ramps }: { floors: number; ramps: number }) => ({ floors, ramps });

test("a tunnel's floor goes straight from portal to portal when the ground over it is high enough", () => {
  // portals at 100 and 90 at e = 0 and 200, a hill of 130 over the tunnel between
  const ground = (e: number) => (e <= 0 ? 100 : e >= 200 ? 90 : 130);
  const tunnel = road("w1", [[0, 0], [200, 0]], { tunnel: true, layer: -2 });
  const map = features([road("w2", [[-50, 0], [0, 0]]), tunnel, road("w3", [[200, 0], [250, 0]])]);
  assert.deepEqual(counts(solveTunnels(map, ground)), { floors: 1, ramps: 2 });
  assert.equal(tunnel.line.length, 21);
  // the ways out stay at the floor under the portals' walls (the hill's ground raised over the ends), level to the ground on
  const ramps = map.roads.filter((r) => r.floor && !r.tunnel).map((r) => [r.line, round(r.floor)]);
  assert.deepEqual(ramps.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [[[[-2, 0], [0, 0]], [100, 100]], [[[200, 0], [202, 0]], [90, 90]]]);
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
    [2.5, 2.5, 2.5, 2.5, 2.5, 3, CLEARANCE_M.vehicles, 2.2, CLEARANCE_M.vehicles],
  );
  assert.equal(roomHeight({ osm: "w8", kind: "rail", layer: -1, bridge: false, tunnel: true, line: [] }), CLEARANCE_M.trains);
});

test("a low tunnel under a low hill stays at its portals' level, where a road's full room would sink it", () => {
  // portals at 100, the ground over the tunnel 104
  const ground = (e: number) => (e <= 0 || e >= 200 ? 100 : 104);
  const floors = (extra: Partial<Road>) => {
    const tunnel = road("w1", [[0, 0], [200, 0]], { tunnel: true, layer: -1, kind: "service", ...extra });
    setTunnelRooms([tunnel]);
    solveTunnels(features([road("w2", [[-50, 0], [0, 0]]), tunnel, road("w3", [[200, 0], [250, 0]])]), ground);
    return defined(tunnel.floor);
  };
  assert.equal(Math.round(Math.min(...floors({ maxHeight: 2.3 })) * 10) / 10, 100);
  // a road's room sinks it: its room, roof and cover under the ground, as far in from the portals as they ease in
  assert.ok(Math.min(...floors({})) < 104 - easedDepth(COVER_M + ROOF_M + CLEARANCE_M.vehicles, 100) + 1e-6);
});

test("a corridor on from a tunnel's end rises out of it as stairs do, and does not lift its floor to the ground", () => {
  // a passage under the tracks (ground 96) with a corridor on into a building at its west end
  const tunnel = road("w1", [[0, 0], [100, 0]], { tunnel: true, layer: -1, kind: "footway", width: 2.5 });
  const corridor = road("w2", [[-14, 0], [0, 0]], { kind: "corridor", width: 3 });
  const map = features([corridor, tunnel, road("w3", [[100, 0], [150, 0]], { kind: "footway", width: 2.5 })]);
  solveTunnels(map, (e) => (e > 100 ? 92 : 96));
  // the west end as deep as the room and roof need, not at the ground
  assert.equal(round(tunnel.floor)?.[0], 96 - 3 - ROOF_M - COVER_M);
  // a stretch of the corridor rises from it, as steeply as stairs
  const [rising] = map.roads.filter((r) => r.osm === "w2" && r.floor);
  assert.deepEqual(rising.line[rising.line.length - 1], [0, 0]);
  assert.equal(defined(rising.floor)[rising.line.length - 1], defined(tunnel.floor)[0]);
  assert.ok(Math.hypot(rising.line[0][0], rising.line[0][1]) < 10);
});

test("a portal's floor is the ramp's just outside it, not the top of the portal's wall", () => {
  const ground = (e: number) => (e < 0 ? 95 + e / 2 : 120);
  const tunnel = road("w1", [[0, 0], [100, 0]], { tunnel: true, layer: -1 });
  solveTunnels(features([road("w2", [[-20, 0], [0, 0]]), tunnel]), ground);
  assert.equal(round(tunnel.floor)?.[0], 93);
});

/** A high bridge along a tunnel at e = 0 from n = -10 to 70, as wide as `width`, landing on the ground at 100 */
const along = (width: number) => road("w9", [[0, -10], [0, 70]], { kind: "footway", width, bridge: true, layer: 1 });
const banks = (ground: (e: number, n: number) => number) => (e: number, n: number) => (n < -5 || n > 65 ? 100 : ground(e, n));

test("under a bridge the floor goes level between its portals, not down under the model's span", () => {
  // a footway along under a bridge, portals at 83; the model under the deck spans the gap at 86
  const ground = banks((e: number, n: number) => (n <= 0 || n >= 60 ? 83 : 86));
  const tunnel = road("w1", [[0, 0], [0, 60]], { kind: "footway", width: 5, tunnel: true, layer: -1 });
  solveTunnels(features([road("w2", [[0, -4], [0, 0]], { kind: "footway", width: 2.5 }), tunnel, road("w3", [[0, 60], [0, 64]], { kind: "footway", width: 2.5 }), along(8)]), ground);
  assert.deepEqual(round(tunnel.floor), [83, 83, 83, 83, 83, 83, 83]);
});

test("a tunnel under a bridge's deck goes deep enough for its room and roof under the deck, coming up to its portals no steeper than a road tunnel, the deck staying", () => {
  // a footway 40 m along under a bridge's end, its portals at the ground at 88, the deck over its middle at 88.3
  const floors = (bridged: boolean) => {
    const tunnel = road("w1", [[0, 0], [0, 40]], { kind: "footway", width: 5, tunnel: true, layer: -1 });
    const bridge = road("w9", [[-30, 20], [30, 20]], { kind: "footway", width: 9, bridge: true, layer: 1 });
    solveTunnels(features([road("w2", [[0, -20], [0, 0]], { kind: "footway", width: 2.5 }), tunnel, road("w3", [[0, 40], [0, 60]], { kind: "footway", width: 2.5 }), ...(bridged ? [bridge] : [])]), (e) => (Math.abs(e) >= 30 ? 88.3 : 88));
    return { floor: defined(tunnel.floor), room: roomHeight(tunnel), deck: bridge.deck };
  };
  // without the deck, at the ground's level, and the deck over the roof
  const level = floors(false);
  assert.ok(Math.min(...level.floor) > 88.3 - ROOF_M - level.room);
  // with it, the room and the roof under the deck over the middle
  const under = floors(true);
  const middle = under.floor[Math.floor(under.floor.length / 2)];
  assert.ok(middle <= 88.3 - ROOF_M - under.room + 1e-6, String(middle));
  for (let i = 1; i < under.floor.length; i++) {
    assert.ok(Math.abs(under.floor[i] - under.floor[i - 1]) <= 0.07 * 10 + 1e-6, String(under.floor));
  }
  assert.ok(defined(under.deck).every((h) => Math.abs(h - 88.3) < 1e-6), String(under.deck));
});

test("a street ending at a bridge over a tunnel does not sink its floor under the model's ground there", () => {
  // the tunnel along under the bridge's end, the street's end over its room at the bridge, where the model is low
  const ground = banks((e: number, n: number) => (n <= 0 || n >= 60 ? 83 : e > 4 ? 88 : 85));
  const floors = (width: number) => {
    const tunnel = road("w1", [[0, 0], [0, 60]], { kind: "footway", width: 5, tunnel: true, layer: -1 });
    const street = road("w4", [[4, 30], [40, 30]], { kind: "residential", width: 7 });
    solveTunnels(features([road("w2", [[0, -4], [0, 0]], { kind: "footway", width: 2.5 }), tunnel, street, road("w3", [[0, 60], [0, 64]], { kind: "footway", width: 2.5 }), along(width)]), ground);
    return round(tunnel.floor);
  };
  // the street's end under the deck (its half width and edge reach 4 m off its line), or beside it
  assert.ok(Math.min(...(floors(7) ?? [])) >= 83 - 1e-9);
  assert.ok(Math.min(...(floors(5) ?? [])) < 83 - 0.5);
});

test("the floor sinks under a dip in the ground, no steeper than a road tunnel, and not at the portals", () => {
  // level ground at 110 over a tunnel between portals at 100, dipping to 102 at e = 150
  const ground = (e: number) => (e <= 0 || e >= 300 ? 100 : e >= 140 && e <= 160 ? 102 : 110);
  const tunnel = road("w1", [[0, 0], [300, 0]], { tunnel: true, layer: -2 });
  solveTunnels(features([road("w2", [[-50, 0], [0, 0]]), tunnel, road("w3", [[300, 0], [350, 0]])]), ground);
  const floor = defined(tunnel.floor);
  // as deep as the dip needs, or a bend deeper, to round its bottom
  const deepest = 102 - CLEARANCE_M.vehicles - ROOF_M - COVER_M;
  assert.ok(Math.min(...floor) <= deepest + 1e-6 && Math.min(...floor) >= deepest - MAX_BEND_M - 1e-6, `${Math.min(...floor)}`);
  assert.deepEqual([floor[0], floor[floor.length - 1]], [100, 100]);
  for (let i = 1; i < floor.length; i++) {
    const step = Math.hypot(tunnel.line[i][0] - tunnel.line[i - 1][0], tunnel.line[i][1] - tunnel.line[i - 1][1]);
    assert.ok(Math.abs(floor[i] - floor[i - 1]) <= 0.07 * step + 1e-9, `grade at ${i}`);
  }
});

test("past a dip the floor rises again no steeper than a road tunnel, and bends gently out of the dip and back", () => {
  // portals at 100 at e = 0 and 400; the ground dips to 96 at e = 90..110 and is 110 elsewhere over the tunnel
  const ground = (e: number) => (e <= 0 || e >= 400 ? 100 : e >= 90 && e <= 110 ? 96 : 110);
  const tunnel = road("w1", [[0, 0], [400, 0]], { tunnel: true, layer: -2 });
  const { conflicts } = solveTunnels(features([road("w2", [[-50, 0], [0, 0]]), tunnel, road("w3", [[400, 0], [450, 0]])]), ground);
  const floor = defined(tunnel.floor);
  // the room, roof and cover under the dip, eased in from the west portal 100 m away, are deeper than the grade
  // reaches from the portal: as deep as it reaches, the shortfall told
  const deepest = 96 - easedDepth(CLEARANCE_M.vehicles + ROOF_M + COVER_M, 90);
  assert.ok(Math.min(...floor) <= 100 - 0.07 * 80 && Math.min(...floor) > deepest, `${Math.min(...floor)}`);
  const short = conflicts.find((c) => c.way === "w1" && c.bound === "cover");
  assert.ok(short && short.at[0] >= 80 && short.at[0] <= 120, JSON.stringify(conflicts));
  // far from the dip the floor is back on the line between the portals
  const back = tunnel.line.findIndex(([e]) => e === 300);
  assert.ok(Math.abs(floor[back] - 100) < 1e-6, `floor ${floor[back]} at 300`);
  // in from the portals as far as the cover eases in, the floor comes down as it does
  const inside = tunnel.line.flatMap(([e], i) => (e > 30 && e < 370 ? [i] : []));
  for (const i of inside) {
    assert.ok(Math.abs(floor[i] - floor[i - 1]) <= 0.07 * 10 + 1e-9, `grade at ${tunnel.line[i][0]}`);
    const bend = floor[i] - (floor[i - 1] + floor[i + 1]) / 2;
    assert.ok(Math.abs(bend) <= MAX_BEND_M + 1e-3, `bend ${bend} at ${tunnel.line[i][0]}`);
  }
});

test("a floor under a way crossing over it bends gently: rounded deeper beside it, not a sharp dip", () => {
  // a road tunnel under level ground at 110 from portals at 100, a street at 104 over its middle
  const ground = (e: number) => (e <= 0 || e >= 400 ? 100 : Math.abs(e - 200) <= 4 ? 104 : 110);
  const tunnel = road("w1", [[0, 0], [400, 0]], { tunnel: true, layer: -2 });
  const street = road("w4", [[200, -30], [200, 30]], { kind: "residential", width: 6 });
  solveTunnels(features([road("w2", [[-50, 0], [0, 0]]), tunnel, road("w3", [[400, 0], [450, 0]]), street]), ground);
  const floor = defined(tunnel.floor);
  const under = 104 - CLEARANCE_M.vehicles - ROOF_M - COVER_M;
  assert.ok(Math.min(...floor) <= under + 1e-9);
  for (let i = 1; i + 1 < floor.length; i++) {
    const bend = floor[i] - (floor[i - 1] + floor[i + 1]) / 2;
    assert.ok(Math.abs(bend) <= MAX_BEND_M + 1e-3, `bend ${bend} at ${tunnel.line[i][0]}`);
  }
  // beside the street the floor is deeper than the road tunnel's grade alone takes it
  const beside = tunnel.line.findIndex(([e]) => e === 220);
  assert.ok(floor[beside] < under + 0.07 * 20 - 0.1, `${floor[beside]}`);
});

test("a tunnel under another one crossing over it runs with its roof under the other's floor", () => {
  // a footway tunnel (layer -1) across a road tunnel (layer -2) at e = 105, both under level ground at 110
  const ground = (e: number, n: number) => (Math.abs(e - 100) <= 60 && Math.abs(n) <= 60 ? 110 : 100);
  const lower = road("w1", [[0, 0], [200, 0]], { tunnel: true, layer: -2 });
  const upper = road("w2", [[105, -100], [105, 100]], { tunnel: true, layer: -1, kind: "footway", width: 2.5 });
  const ways = [lower, upper, road("w3", [[-50, 0], [0, 0]]), road("w4", [[200, 0], [250, 0]])];
  ways.push(road("w5", [[105, -150], [105, -100]], { kind: "footway", width: 2.5 }), road("w6", [[105, 100], [105, 150]], { kind: "footway", width: 2.5 }));
  solveTunnels(features(ways), ground);
  const at = (way: Road, e: number, n: number) => defined(way.floor)[way.line.findIndex((p) => p[0] === e && p[1] === n)];
  for (const e of [100, 110]) {
    assert.ok(at(lower, e, 0) + CLEARANCE_M.vehicles + ROOF_M <= at(upper, 105, 0) + 1e-6, `${at(lower, e, 0)} under ${at(upper, 105, 0)}`);
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
  solveTunnels(features([a, b, c, ...portals.map((p) => p.way)]), at);
  // no higher than it hangs, and the branch at the junction level with the way running through it
  const junction = defined(a.floor).at(-1) ?? Infinity;
  assert.ok(junction <= 98 + 1e-6 && junction > 97, `${junction}`);
  assert.equal(round(c.floor)?.at(-1), 94);
});

test("tunnels in cuts and tunnels without known ground get no floor", () => {
  const cut = road("w1", [[0, 0], [50, 0]], { tunnel: true, layer: -1, lid: [100, 100] });
  const unknown = road("w2", [[0, 10], [50, 10]], { tunnel: true, layer: -1 });
  assert.deepEqual(counts(solveTunnels(features([cut, unknown]), () => undefined)), { floors: 0, ramps: 0 });
  assert.deepEqual([cut.floor, unknown.floor, cut.line.length], [undefined, undefined, 2]);
});

test("a way out of a portal comes down to the floor where the ground by the portal is the top of its wall", () => {
  // the tunnel's floor at 93 (the ground 4 m out); the ground rises to 120 at the portal
  const ground = (e: number) => (e < 0 ? 95 + e / 2 : 120);
  const tunnel = road("w1", [[0, 0], [100, 0]], { tunnel: true, layer: -1 });
  const out = road("w2", [[-20, 0], [0, 0]]);
  const map = features([out, tunnel]);
  assert.deepEqual(counts(solveTunnels(map, ground)), { floors: 1, ramps: 1 });
  // the ramp is split off the way: from where a 7 % slope from the floor meets the ground (4 m out) to the portal
  const ramp = defined(map.roads.find((r) => r.osm === "w2" && r.floor));
  assert.deepEqual([ramp.line[0], ramp.line.at(-1), defined(ramp.floor)[0], defined(ramp.floor).at(-1)], [[-4, 0], [0, 0], 93, 93]);
  ramp.line.forEach(([e], i) => assert.ok(defined(ramp.floor)[i] <= 93 + 0.07 * -e + 1e-6));
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
  solveTunnels(map, ground, levels);
  // the hall hangs from its portals, not from the stairs' foot, which is as deep as the hall
  assert.deepEqual([round(hall.floor), round(branch.floor)], [hall.line.map(() => 100), branch.line.map(() => 100)]);
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
  solveTunnels(map, () => 100);
  assert.deepEqual(round(tunnel.floor), tunnel.line.map(() => 100 - 3 - ROOF_M - COVER_M));
  // rising 0.6 a meter from the floor until they meet the ground, 8 m on
  const ramps = map.roads.filter((r) => r.kind === "steps" && r.floor);
  assert.deepEqual(ramps.map((r) => [r.line, round(r.floor)]), [[[[0, 0], [-6, 0], [-8, 0]], [96 - COVER_M, 99.3, 100]], [[[30, 0], [36, 0], [38, 0]], [96 - COVER_M, 99.3, 100]]]);
});

test("stairs up out of an underpass where it goes on past them rise from its floor there, once out of its room", () => {
  // an underpass between portals at 100 under ground at 106, stairs up from its middle
  const ground = (e: number) => (e <= 0 || e >= 100 ? 100 : 106);
  const hall = road("w1", [[0, 0], [50, 0], [100, 0]], { tunnel: true, layer: -1, kind: "footway", width: 4 });
  const stairs = road("w2", [[50, 0], [50, -20]], { kind: "steps", width: 2 });
  const map = features([hall, stairs, road("w3", [[-20, 0], [0, 0]]), road("w4", [[100, 0], [120, 0]])]);
  solveTunnels(map, ground);
  assert.deepEqual(round(hall.floor), hall.line.map(() => 100));
  // level across the room (2 m and 1 m beside the way), then 0.6 a meter until they meet the ground, 10 m on
  const ramp = defined(map.roads.find((r) => r.osm === "w2" && r.floor));
  assert.deepEqual([ramp.line, round(ramp.floor)], [[[50, 0], [50, -3], [50, -12], [50, -14]], [100, 100, 105.4, 106]]);
});

test("a ramp is local: held at the ground at the first way meeting it, which keeps its own heights", () => {
  // a footway underpass 12 m long under a street on level ground at 100; the way out west meets a path 10 m out
  const tunnel = road("w1", [[0, 0], [12, 0]], { tunnel: true, layer: -1, kind: "footway", width: 2.5 });
  const west = road("w3", [[-60, 0], [-20, 0], [-10, 0], [0, 0]], { kind: "footway", width: 2.5 });
  const joining = road("w5", [[-10, 0], [-10, -30]], { kind: "path", width: 1.5 });
  const across = road("w6", [[-20, -10], [-20, 0], [-20, 10]], { kind: "path", width: 1.5 });
  const map = features([west, tunnel, road("w4", [[12, 0], [72, 0]], { kind: "footway", width: 2.5 }), road("w2", [[6, -20], [6, 20]]), joining, across]);
  solveTunnels(map, () => 100);
  const ramp = defined(map.roads.find((r) => r.osm === "w3" && r.floor));
  assert.deepEqual([ramp.line[0], defined(ramp.floor)[0]], [[-10, 0], 100]);
  assert.ok(Math.min(...defined(ramp.floor)) < 99, `${ramp.floor}`);
  assert.deepEqual([joining.floor, across.floor], [undefined, undefined]);
});

test("under water the floor is deeper by the water's depth and a bed over the roof", () => {
  // the elevation model has the water's surface, 100, over the middle of the tunnel, far enough from the portals for
  // the floor to come down under it
  const tunnel = road("w1", [[0, 0], [600, 0]], { tunnel: true, layer: -2 });
  const lake: Polygon = { outer: [[200, -50], [400, -50], [400, 50], [200, 50]], holes: [] };
  const map = features([road("w2", [[-50, 0], [0, 0]]), tunnel, road("w3", [[600, 0], [650, 0]])]);
  map.areas.push({ osm: "w4", kind: "water", polygon: lake });
  solveTunnels(map, () => 100);
  // in the middle (deeper by a little where it comes down at the water's edge, bending out of its grade)
  assert.equal(Math.round(defined(tunnel.floor)[tunnel.line.findIndex(([e]) => e === 300)] * 10) / 10, 100 - CLEARANCE_M.vehicles - ROOF_M - COVER_M - WATER_DEPTH_M - BED_M);
});

test("water over only the side of a tunnel's room takes it under the water's surface there", () => {
  // a river falling across the tunnel: its surface 96 over the room's south side, the ground 100 over its line
  const tunnel = road("w1", [[0, 0], [600, 0]], { tunnel: true, layer: -2 });
  const river: Polygon = { outer: [[200, -50], [400, -50], [400, -3], [200, -3]], holes: [] };
  const map = features([road("w2", [[-50, 0], [0, 0]]), tunnel, road("w3", [[600, 0], [650, 0]])]);
  map.areas.push({ osm: "w4", kind: "water", polygon: river });
  solveTunnels(map, (_, n) => (n < -3 ? 96 : 100));
  assert.equal(Math.round(defined(tunnel.floor)[tunnel.line.findIndex(([e]) => e === 300)] * 10) / 10, 96 - CLEARANCE_M.vehicles - ROOF_M - COVER_M - WATER_DEPTH_M - BED_M);
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
  assert.deepEqual([railway, underArena, underStreet, deep].map(inTunnel), [false, false, true, true]);
  assert.deepEqual([railway.tunnel, underArena.atGrade], [true, true]);
  // the arena's walls open for the railway, as tall as a railway tunnel's room
  assert.ok(arena.passages?.some((o) => o.height === CLEARANCE_M.trains));
  // the roof over the railway becomes a deck over its room, without the posts of a roof
  assert.deepEqual([deck.shelter, deck.minHeight, deck.height], [undefined, CLEARANCE_M.trains, CLEARANCE_M.trains + ROOF_M]);
  // the arena, raised 3 m off the ground in OSM, starts over the railway's room, its top where it was
  assert.deepEqual([arena.minHeight, arena.height], [CLEARANCE_M.trains, 20]);
  assert.deepEqual([house.minHeight, house.height], [CLEARANCE_M.trains, 24]);
  // under a hill a railway stays in its tunnel
  const underHill: Rail = { osm: "w1", kind: "rail", layer: -1, bridge: false, tunnel: true, line: railway.line };
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
  assert.deepEqual([tunnel, branch].map(inTunnel), [true, true]);
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
  solveTunnels(map, () => 100);
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
    solveTunnels(map, () => 100);
    return round(tunnel.floor)?.[0];
  };
  const roof = (outer: Point[]): Building => ({ osm: "w4", kind: "roof", part: false, hasParts: false, height: 5, minHeight: 0, shelter: "roof", polygon: { outer, holes: [] } });
  assert.ok((floorWith([]) ?? Infinity) <= 100 - CLEARANCE_M.vehicles - ROOF_M - COVER_M + 1e-6);
  assert.equal(floorWith([roof([[0, -3], [20, -3], [20, 3], [0, 3]])]), 100);
  // a roof over the tunnel's middle only, over its end where no way leads on, or over its portal but not most of
  // it (the inside of a building going on), covers no ramp
  assert.ok((floorWith([roof([[-2, -3], [8, -3], [8, 3], [-2, 3]])], 6) ?? Infinity) <= 100 - CLEARANCE_M.vehicles - ROOF_M - COVER_M + 1e-6);
  assert.ok((floorWith([roof([[5, -3], [15, -3], [15, 3], [5, 3]])]) ?? Infinity) <= 100 - CLEARANCE_M.vehicles - ROOF_M - COVER_M + 1e-6);
  assert.ok((floorWith([roof([[15, -3], [20, -3], [20, 3], [15, 3]])]) ?? Infinity) <= 100 - CLEARANCE_M.vehicles - ROOF_M - COVER_M + 1e-6);
});

test("a roof over stairs up out of a tunnel (a platform's) covers no cut", () => {
  // an underpass 10 m long from a portal on level ground at 100, stairs up from its end under a platform's roof,
  // and a path over its room's side there
  const floorAt = (buildings: Building[]) => {
    const tunnel = road("w1", [[0, 0], [10, 0]], { tunnel: true, layer: -1, kind: "footway", width: 3 });
    const stairs = road("w2", [[10, 0], [20, 0]], { kind: "steps", width: 2 });
    const path = road("w3", [[6, -3], [20, -3]], { kind: "footway", width: 2 });
    solveTunnels({ ...features([road("w4", [[-20, 0], [0, 0]], { kind: "footway", width: 3 }), tunnel, stairs, path]), buildings }, () => 100);
    return round(tunnel.floor)?.at(-1);
  };
  const outer: Point[] = [[5, -5], [25, -5], [25, 5], [5, 5]];
  assert.equal(floorAt([{ osm: "w5", kind: "roof", part: false, hasParts: false, height: 4, minHeight: 0, shelter: "roof", polygon: { outer, holes: [] } }]), 100 - 3 - ROOF_M - COVER_M);
});

test("a tunnel's floor under a wavy hill does not rise with its waves, and is deep enough", () => {
  // a hill of 130 with waves of 2 m every 20 m; portals at 100 at e = 0 and 200
  const ground = (e: number) => (e <= 0 || e >= 200 ? 100 : 104 + 2 * Math.sin((e * Math.PI) / 20));
  const tunnel = road("w1", [[0, 0], [200, 0]], { tunnel: true, layer: -2 });
  const map = features([road("w2", [[-50, 0], [0, 0]]), tunnel, road("w3", [[200, 0], [250, 0]])]);
  solveTunnels(map, ground);
  const floor = defined(tunnel.floor);
  // no point over the line between its neighbours (the ground's humps); the floor may still bend down
  for (let i = 1; i + 1 < floor.length; i++) {
    const bend = floor[i] - (floor[i - 1] + floor[i + 1]) / 2;
    assert.ok(bend <= MAX_BEND_M + 1e-3, `bend ${bend.toFixed(2)} at ${tunnel.line[i][0]}`);
  }
  // deep enough everywhere: the room, roof and cover under the ground around each point, eased in from the portals
  for (const [i, [e]] of tunnel.line.entries()) {
    if (e > 0 && e < 200) {
      const depth = easedDepth(CLEARANCE_M.vehicles + ROOF_M + COVER_M, Math.min(e, 200 - e));
      assert.ok(floor[i] <= Math.min(ground(e - 5), ground(e), ground(e + 5)) - depth + 1e-9);
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
  solveTunnels(map, ground);
  // the portal's floor is the cut's, not 4 m under it
  assert.ok((round(tunnel.floor)?.at(-1) ?? 0) > 99);
});

test("a ramp goes on through a joint past a short way out of a portal, as far as it rises at TUNNEL_GRADE to the ground", () => {
  // the cut beyond the portal at 102; a street over the tunnel by the portal takes the floor down to 100 less the cover
  const ground = (e: number) => (e <= 40 ? 104 : 102);
  const tunnel = underpass();
  const short = stub();
  const onward = road("w4", [[40.5, 0], [80, 0]], { kind: "cycleway", width: 2.5 });
  const map = features([road("w2", [[-20, 0], [0, 0]]), tunnel, short, onward, road("w5", [[36, -20], [36, 20]])]);
  solveTunnels(map, ground);
  const portal = defined(tunnel.floor).at(-1) ?? Infinity;
  assert.ok(portal <= 100 - COVER_M + 1e-6, `${portal}`);
  // the short way and the way on from it one ramp, rising no steeper than 7 % to the ground, where it ends
  assert.deepEqual([defined(short.floor)[0], short.line.at(-1)], [portal, [40.5, 0]]);
  const ramp = defined(map.roads.find((r) => r.osm === "w4" && r.floor));
  const floor = defined(ramp.floor);
  assert.ok(Math.abs(floor[0] - (defined(short.floor).at(-1) ?? 0)) < 1e-9 && Math.abs((floor.at(-1) ?? 0) - 102) < 1e-6);
  const along = ramp.line.map(([e]) => e);
  floor.slice(1).forEach((h, i) => assert.ok(h - floor[i] <= 0.07 * (along[i + 1] - along[i]) + 1e-6, `${floor}`));
  assert.ok((along.at(-1) ?? 0) >= 40.5 + (102 - portal) / 0.07 - 1);
});

test("the ground over a tunnel's end is raised to the ground in from it, where the model slopes down to the portal", () => {
  // the model smooths the portal's wall over the tunnel's last 4 m, down to the cut at 100
  const ground = (e: number) => (e <= 36 ? 104 : e >= 40 ? 100 : 104 - (e - 36));
  const tunnel = underpass();
  // a cycleway over the portal, 1.2 m in from it
  const over = road("w4", [[38.8, -20], [38.8, 20]], { kind: "cycleway", width: 2.5 });
  const map = features([road("w2", [[-20, 0], [0, 0]]), tunnel, stub(), road("w5", [[40.5, 0], [80, 0]]), over]);
  const { walls } = solveTunnels(map, ground);
  const wallsAt = portalWallsAt(walls);
  // over the room from the portal 6 m in, as high as the ground there; not beyond the portal, nor beside the room off the cycleway
  assert.deepEqual([wallsAt(38, 0), wallsAt(34.5, 2), wallsAt(40.5, 0), wallsAt(35, 2.5), wallsAt(20, 0)], [104, 104, undefined, undefined, undefined]);
  assert.deepEqual([raiseToWalls(ground, wallsAt)(38.8, 0), raiseToWalls(ground, wallsAt)(42, 0)], [104, 100]);
  // the floor is room, roof and cover under the raised ground under the cycleway, not under the slope
  const portal = round(tunnel.floor)?.at(-1) ?? 0;
  assert.ok(portal <= 100 - COVER_M && portal > 99, `${portal}`);
});

test("a ramp is held at the ground where a way passes through the short way's end: the short way rises to the ground there", () => {
  const ground = (e: number) => (e <= 40 ? 104 : 102);
  const short = stub();
  const across = road("w6", [[40.5, -20], [40.5, 0], [40.5, 20]], { kind: "service", width: 4 });
  const map = features([road("w2", [[-20, 0], [0, 0]]), underpass(), short, road("w4", [[40.5, 0], [80, 0]], { kind: "cycleway", width: 2.5 }), across, road("w5", [[36, -20], [36, 20]])]);
  solveTunnels(map, ground);
  assert.equal(defined(short.floor).at(-1), 102);
  assert.deepEqual([across.floor, map.roads.filter((r) => r.osm === "w4" && r.floor).length], [undefined, 0]);
});

test("a way over a portal is level over the cut in front of it, wider than the tunnel, and the cut stays", () => {
  // the cut 12 m wide, its wall smoothed over the tunnel's last 4 m and beside it
  const ground = (e: number, n: number) => (Math.abs(n) > 6 || e <= 36 ? 104 : e >= 40 ? 100 : 104 - (e - 36));
  const over = road("w4", [[38.8, -20], [38.8, 20]], { kind: "cycleway", width: 2.5 });
  const map = features([road("w2", [[-20, 0], [0, 0]]), underpass(), stub(), road("w5", [[40.5, 0], [80, 0]]), over]);
  const at = raiseToWalls(ground, portalWallsAt(solveTunnels(map, ground).walls));
  // under the cycleway over the room and beside it, as far as the cut reaches; the cut in front of the portal
  assert.deepEqual([at(38.8, 0), at(38.8, 4.5), at(38.8, -5.5), at(38.8, 9), at(41, 4), at(42, 0)], [104, 104, 104, 104, 100, 100]);
});

test("a way beside a portal, only its width reaching over the room, keeps its ground", () => {
  // the ground over the tunnel a meter over a street along it, the street's kerb over the room's side
  const ground = (e: number, n: number) => (Math.abs(n) > 3 ? 103 : e <= 36 ? 104 : e >= 40 ? 100 : 104 - (e - 36));
  const street = road("w4", [[0, 5.5], [60, 5.5]]);
  const map = features([road("w2", [[-20, 0], [0, 0]]), underpass(), stub(), road("w5", [[40.5, 0], [80, 0]]), street]);
  const at = raiseToWalls(ground, portalWallsAt(solveTunnels(map, ground).walls));
  assert.deepEqual([at(38, 0), at(36, 5.5), at(30, 5.5), at(45, 5.5)], [104, 103, 103, 103]);
});

test("a levelled way falls evenly to the model where its reach ends with the ground lower still, not in a step", () => {
  // a street across the portal, the ground beside the tunnel a little lower than over it, the cut in front
  const ground = (e: number, n: number) => (Math.abs(n) > 3 ? 102 : e <= 36 ? 104 : e >= 40 ? 100 : 104 - (e - 36));
  const street = road("w4", [[38, -30], [38, 30]]);
  const map = features([road("w2", [[-20, 0], [0, 0]]), underpass(), stub(), road("w5", [[40.5, 0], [80, 0]]), street]);
  const at = raiseToWalls(ground, portalWallsAt(solveTunnels(map, ground).walls));
  // level where its width is over the wall (6.25 m either side), then down over the reach's 10 m, the model beyond
  assert.deepEqual([at(38, 0), at(38, -6), at(38, -11), at(38, -16), at(38, -18), at(38, 11), at(38, 18)], [104, 104, 103, 102, 102, 103, 102]);
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
    solveTunnels(features([footway, cycleway, ...outs]), ground);
    return [defined(footway.floor), defined(cycleway.floor)];
  };
  // rooms 2.25 m and 3 m to either side: one hall 3.5 m apart
  const [footway, cycleway] = pair(3.5);
  assert.deepEqual(round(cycleway), round(footway));
  assert.deepEqual([round(footway)?.[0], round(footway)?.at(-1)], [100, 98]);
  const [, apart] = pair(20);
  assert.equal(round(apart)?.[0], 100.3);
});

test("a hall makes no two points of one way one: beside one point of another, a way's points keep their own floors", () => {
  // under ground at 110 from portals at 100, a footway whose plan puts two points 0.9 m apart at 100 and 99, both
  // beside the end of a cycleway along it
  const footway = road("w1", [[0, 0], [79.55, 0], [80.45, 0], [160, 0]], { tunnel: true, layer: -1, kind: "footway", width: 2.5 });
  const cycleway = road("w2", [[80, 3], [160, 3]], { tunnel: true, layer: -1, kind: "cycleway", width: 3 });
  const outs = [road("w3", [[-20, 0], [0, 0]]), road("w4", [[160, 0], [180, 0]]), road("w5", [[160, 3], [180, 3]])];
  const known: KnownFloor[] = [
    { p: [79.55, 0], floor: 100, name: "w1" },
    { p: [80.45, 0], floor: 99, name: "w1" },
  ];
  solveTunnels(features([footway, cycleway, ...outs]), (e) => (e <= 0 || e >= 160 ? 100 : 110), new Map(), known);
  const at = (e: number) => defined(footway.floor)[footway.line.findIndex((p) => p[0] === e && p[1] === 0)];
  assert.deepEqual([at(79.55), at(80.45)], [100, 99]);
});

test("a tunnel of two ways, one going on from the other, gets the floors it gets as one way: they are not side by side", () => {
  // under ground rising from 100 to 110 m along e, from a portal at either end
  const ground = (e: number) => 100 + Math.min(Math.max(e, 0), 200) / 20;
  const floors = (lines: Point[][]) => {
    const ways = lines.map((line, i) => road(`w${i + 1}`, line, { kind: "trunk", width: 10, tunnel: true, layer: -1 }));
    solveTunnels(features([road("w8", [[-20, 0], [0, 0]]), ...ways, road("w9", [[200, 0], [220, 0]])]), ground);
    return round(ways.flatMap((way, i) => defined(way.floor).slice(i > 0 ? 1 : 0)));
  };
  assert.deepEqual(floors([[[0, 0], [100, 0]], [[100, 0], [200, 0]]]), floors([[[0, 0], [100, 0], [200, 0]]]));
});

test("stairs' feet in one hall have its floor, their stairs rising from it", () => {
  // two underpasses side by side from portals at 100 and 100.3, under a yard at 106, each up stairs at its end
  const pair = (gap: number) => {
    const ground = (e: number, n: number) => (e <= 0 ? (n < gap / 2 ? 100 : 100.3) : 106);
    const footway = road("w1", [[0, 0], [60, 0]], { tunnel: true, layer: -1, kind: "footway", width: 2.5 });
    const cycleway = road("w2", [[0, gap], [60, gap]], { tunnel: true, layer: -1, kind: "cycleway", width: 4 });
    const stairs = [road("w3", [[60, 0], [60, -15]], { kind: "steps", width: 2 }), road("w4", [[60, gap], [60, gap + 15]], { kind: "steps", width: 2 })];
    const outs = [road("w5", [[-20, 0], [0, 0]]), road("w6", [[-20, gap], [0, gap]])];
    solveTunnels(features([footway, cycleway, ...stairs, ...outs]), ground);
    return [defined(footway.floor), defined(cycleway.floor)];
  };
  const [footway, cycleway] = pair(3.5);
  assert.deepEqual(round(cycleway.slice(1)), round(footway.slice(1)));
  const [, apart] = pair(20);
  assert.ok(Math.abs(apart[0] - 100.3) < 1e-6);
});

test("a trunk link beside the trunk in one hall has its floor, however far apart the ground over them would set them, its portal coming down to it", () => {
  // a trunk and its link side by side from portals at 100 and 101.2, under ground at 110 and 108.8 over them
  const ground = (e: number, n: number) => (e <= 0 ? (n < 3 ? 100 : 101.2) : e >= 300 ? 100 : n < 3 ? 110 : 108.8);
  const trunk = road("w1", [[0, 0], [300, 0]], { kind: "trunk", width: 7, tunnel: true, layer: -1 });
  const link = road("w2", [[0, 6], [300, 6]], { kind: "trunk_link", width: 5, tunnel: true, layer: -1 });
  const outs = [road("w3", [[-20, 0], [0, 0]]), road("w4", [[300, 0], [320, 0]]), road("w5", [[-20, 6], [0, 6]]), road("w6", [[300, 6], [320, 6]])];
  solveTunnels(features([trunk, link, ...outs]), ground);
  // but at the link's portal, 1.2 m higher, which comes down as far as the floor's bend in from it needs
  assert.deepEqual(round(link.floor?.slice(1)), round(trunk.floor?.slice(1)));
  const floor = defined(link.floor);
  assert.ok(floor[0] < 101.2 - 0.5 && Math.abs(floor[1] - (floor[0] + floor[2]) / 2) <= MAX_BEND_M + 1e-6, `${floor}`);
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
    solveTunnels(features([a, b, ...outs, ...crossing]), ground);
    return [a.floor, b.floor].map((floor) => floor?.map((v) => Math.round(v * 100) / 100));
  };
  assert.deepEqual(floors(false), floors(true));
});

test("a ramp down from a portal in a building goes down as the cover eases in under the house, as from a portal in the open", () => {
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
    const { basements } = solveTunnels(map, () => 100);
    const floor = defined(ramp.floor);
    const along = ramp.line.map(([e]) => e);
    return { grades: floor.slice(1).map((f, i) => (floor[i] - f) / (along[i + 1] - along[i])), basements: basements.map((w) => w.osm) };
  };
  const steady = floors("over");
  // down as a car park's room, roof and cover ease in under the house, at its end 25 m in
  const depth = easedDepth(COVER_M + ROOF_M + CAR_PARK_CLEARANCE_M, 25);
  assert.ok(Math.abs(steady.grades.reduce((sum, g) => sum + g * (25 / steady.grades.length), 0) - depth) < 0.01);
  // they go down into a basement, the corridor on from the ramp too
  assert.deepEqual(steady.basements, ["w1", "w2"]);
  // in the open the same, for a road's room
  const open = floors("none");
  assert.ok(Math.abs(open.grades.reduce((sum, g) => sum + g * (25 / open.grades.length), 0) - easedDepth(COVER_M + ROOF_M + CLEARANCE_M.vehicles, 25)) < 0.01);
  assert.deepEqual(open.basements, []);
  assert.deepEqual(floors("small"), open);
});

test("a ramp in through a house's front at a point of its outline, the front going on straight past it, opens it on both sides", () => {
  // the front along n = 0 from e = -6 to 6, a point at e = 0 where the ramp goes in north
  const house: Building = { osm: "w9", kind: "apartments", part: false, hasParts: false, height: 20, minHeight: 0, polygon: { outer: [[-6, 0], [0, 0], [6, 0], [6, 30], [-6, 30]], holes: [] } };
  const approach = road("w2", [[0, -10], [0, 0]], { kind: "service", width: 4 });
  const ramp = road("w1", [[0, 0], [0, 25]], { kind: "service", width: 4, tunnel: true, layer: -1, floor: [100, 95] });
  openPortals([house], [ramp], [ramp, approach], () => 100);
  const front = defined(house.passages).filter((o) => o.from[1] === 0 && o.to[1] === 0);
  const width = front.reduce((sum, o) => sum + Math.abs(o.to[0] - o.from[0]), 0);
  assert.ok(width >= 4 + 2 * 1 - 1e-6, `${JSON.stringify(front)}: as wide as the room`);
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

test("from a portal in a building the floor eases in only under it: beyond its walls the cover is the open ground's, missed as far as the floor cannot bend down to it", () => {
  // a 40 m ramp down from a street at 100 on level ground, in through a house from e = -3 to 12, out under the open
  // ground to a corridor going on
  const floors = (inHouse: boolean) => {
    const ramp = road("w1", [[0, 0], [40, 0]], { kind: "service", width: 4, tunnel: true, layer: -1 });
    const corridor = road("w2", [[40, 0], [40, 20]], { kind: "corridor", width: 3, tunnel: true, layer: -1 });
    const map = features([road("w3", [[-20, 0], [0, 0]], { kind: "service", width: 4 }), ramp, corridor]);
    if (inHouse) {
      map.buildings.push({ osm: "w9", kind: "apartments", part: false, hasParts: false, height: 20, minHeight: 0, polygon: { outer: [[-3, -10], [12, -10], [12, 10], [-3, 10]], holes: [] } });
    }
    const { conflicts } = solveTunnels(map, () => 100);
    return { ramp, floor: defined(ramp.floor), conflicts };
  };
  const { ramp, floor, conflicts } = floors(true);
  const short = conflicts.find((c) => c.way === "w1" && c.bound === "cover");
  assert.ok(short && short.at[0] > 12, JSON.stringify(conflicts));
  ramp.line.forEach(([e], i) => {
    if (e > 12) {
      assert.ok(floor[i] + roomHeight(ramp) + ROOF_M + COVER_M <= 100 + (short?.by ?? 0) + 1e-6, `at ${e} the floor ${floor[i]}`);
    }
  });
  // from a portal in the open, eased in as before: 20 m in, not yet as deep as its room, roof and cover
  const open = floors(false);
  const at20 = open.floor[open.ramp.line.findIndex(([e]) => e >= 20)];
  assert.ok(100 - at20 < roomHeight(open.ramp) + ROOF_M + COVER_M - 0.5, `${at20}`);
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
    solveTunnels(m, () => 100);
    return [ramp, corridor].map(roomHeight);
  };
  assert.deepEqual(map("service", true), [CAR_PARK_CLEARANCE_M, CAR_PARK_CLEARANCE_M]);
  assert.deepEqual(map("residential", true), [CLEARANCE_M.vehicles, 3]);
  assert.deepEqual(map("service", false), [CLEARANCE_M.vehicles, 3]);
  // a ramp with a lane each way is two lanes wide in a car park; elsewhere its kind's width; a width OSM tags holds
  const ramp = (inHouse: boolean, tagged = false) => {
    const way = road("w1", [[0, 0], [25, 0]], { kind: "service", width: 4, tunnel: true, layer: -1, lanes: 2, ...(tagged && { widthTagged: true as const }) });
    const m = features([road("w3", [[-20, 0], [0, 0]], { kind: "service", width: 4 }), way]);
    if (inHouse) {
      m.buildings.push(house);
    }
    solveTunnels(m, () => 100);
    return way.width;
  };
  assert.equal(ramp(true), 6.5);
  assert.equal(ramp(false), 4);
  assert.equal(ramp(true, true), 4);
});

test("a basement's ramp opens a wall as wide as its room, and where its room reaches only the wall's footings", () => {
  // a house from e = 0 to 20, n = -10 to 10, the ramp in at its west wall and out under its east wall along n = 0
  const house = (): Building => ({ osm: "w9", kind: "apartments", part: false, hasParts: false, height: 20, minHeight: 0, polygon: { outer: [[0, -10], [20, -10], [20, 10], [0, 10]], holes: [] } });
  const approach = road("w2", [[-10, 0], [0, 0]], { kind: "service", width: 4 });
  const east = (floorThere: number) => {
    const b = house();
    const ramp = road("w1", [[0, 0], [30, 0]], { kind: "service", width: 4, tunnel: true, layer: -1, room: CAR_PARK_CLEARANCE_M, floor: [100, 100 - (100 - floorThere) * 1.5] });
    openPortals([b], [ramp], [ramp, approach], () => 100);
    return (b.passages ?? []).filter((o) => o.from[0] === 20 && o.to[0] === 20);
  };
  // the room's top 0.5 m under the lowest ground, over the footings' bottom: open, the room's width
  const footing = east(100 - CAR_PARK_CLEARANCE_M - 0.5);
  assert.equal(footing.length, 1);
  assert.ok(Math.abs(Math.abs(footing[0].to[1] - footing[0].from[1]) - (4 + 2)) < 0.01, JSON.stringify(footing));
  // under the footings: whole
  assert.deepEqual(east(100 - CAR_PARK_CLEARANCE_M - WALL_FOOTING_M - 0.5), []);
});

test("a car park's floors stay at its level under its building, also under low ground beyond its walls: the roof is a lid there, the shortfall told", () => {
  // a ramp in through a house's wall at e = 0 from a street at 100, on to an aisle going out under its north wall at
  // n = 30, the ground beyond it 4 m lower
  const ramp = road("w1", [[0, 0], [25, 0]], { kind: "service", width: 4, tunnel: true, layer: -1 });
  const aisle = road("w2", [[25, 0], [25, 60]], { kind: "service", service: "parking_aisle", width: 5, tunnel: true, layer: -1 });
  const map = features([road("w3", [[-20, 0], [0, 0]], { kind: "service", width: 4 }), ramp, aisle]);
  map.buildings.push({ osm: "w9", kind: "apartments", part: false, hasParts: false, height: 20, minHeight: 0, polygon: { outer: [[-3, -10], [40, -10], [40, 30], [-3, 30]], holes: [] } });
  const { conflicts } = solveTunnels(map, (_, n) => (n > 36 ? 96 : 100));
  // the car park's room, roof and cover under the house's lowest ground
  const level = 100 - (COVER_M + ROOF_M + CAR_PARK_CLEARANCE_M);
  assert.ok(Math.min(...defined(aisle.floor)) >= level - 1e-6, `${aisle.floor}`);
  const short = conflicts.find((c) => c.way === "w2" && c.bound === "cover");
  assert.ok(short && short.at[1] > 36 && Math.abs(short.by - 4) < 0.1, JSON.stringify(conflicts));
});

test("a portal stays at its height: a hollow too near it for the floor to bend down to it leaves the roof a lid, the shortfall told", () => {
  // a road tunnel 200 m long under ground at 106 from portals at 100, a hollow down to 95 at e = 18..22
  const ground = (e: number) => (e <= 0 || e >= 200 ? 100 : e >= 18 && e <= 22 ? 95 : 106);
  const tunnel = road("w1", [[0, 0], [200, 0]], { tunnel: true, layer: -2 });
  const { conflicts } = solveTunnels(features([road("w2", [[-50, 0], [0, 0]]), tunnel, road("w3", [[200, 0], [250, 0]])]), ground);
  const floor = defined(tunnel.floor);
  assert.deepEqual([floor[0], floor.at(-1)], [100, 100]);
  // bending no more than MAX_BEND_M between its heights 10 m before and after
  for (let i = 1; i + 1 < floor.length; i++) {
    assert.ok(Math.abs(floor[i] - (floor[i - 1] + floor[i + 1]) / 2) <= MAX_BEND_M + 1e-6, `bend at ${tunnel.line[i][0]}`);
  }
  const short = conflicts.filter((c) => c.way === "w1" && c.bound === "cover");
  assert.ok(short.length > 0 && short.every((c) => c.at[0] >= 10 && c.at[0] <= 30), JSON.stringify(conflicts));
});

test("a way's floor bends no more than MAX_BEND_M through a junction too, where a branch to a lower portal pulls it down", () => {
  // a trunk between portals at 100 under ground at 130, a branch from its middle to a portal at 94 100 m away
  const trunk = road("w1", [[0, 0], [200, 0], [400, 0]], { tunnel: true, layer: -2 });
  const branch = road("w2", [[200, 0], [200, 100]], { tunnel: true, layer: -2 });
  const portal = (osm: string, p: Point, h: number) => ({ way: road(osm, [[p[0] - 1, p[1] + 1], p]), p, h });
  const portals = [portal("w4", [0, 0], 100), portal("w5", [400, 0], 100), portal("w6", [200, 100], 94)];
  const at = (e: number, n: number) => portals.find(({ p }) => Math.hypot(p[0] - e, p[1] - n) < 2)?.h ?? 130;
  solveTunnels(features([trunk, branch, ...portals.map((p) => p.way)]), at);
  const floor = defined(trunk.floor);
  const junction = trunk.line.findIndex(([e]) => e === 200);
  assert.ok(floor[junction] < 99, `${floor[junction]}`);
  for (let i = 1; i + 1 < floor.length; i++) {
    assert.ok(Math.abs(floor[i] - (floor[i - 1] + floor[i + 1]) / 2) <= MAX_BEND_M + 1e-6, `bend ${floor[i] - (floor[i - 1] + floor[i + 1]) / 2} at ${trunk.line[i][0]}`);
  }
});

test("at a junction a branch keeps the floor of the way running through it as far as their rooms overlap, which keeps its grade", () => {
  // a road tunnel between portals at 100 and 92 under ground at 130, a footway branching off it square at e = 100
  const main = road("w1", [[0, 0], [100, 0], [200, 0]], { tunnel: true, layer: -2 });
  const branch = road("w2", [[100, 0], [100, -100]], { tunnel: true, layer: -2, kind: "footway", width: 2.5 });
  const portal = (osm: string, p: Point, h: number) => ({ way: road(osm, [[p[0] - 1, p[1] - 1], p]), p, h });
  const portals = [portal("w4", [0, 0], 100), portal("w5", [200, 0], 92), portal("w6", [100, -100], 96)];
  const at = (e: number, n: number) => portals.find(({ p }) => Math.hypot(p[0] - e, p[1] - n) < 2)?.h ?? 130;
  solveTunnels(features([main, branch, ...portals.map((p) => p.way)]), at);
  const floor = defined(main.floor);
  // the way through goes on at its grade past the junction
  const [before, junction, after] = [90, 100, 110].map((e) => floor[main.line.findIndex(([x]) => x === e)]);
  assert.ok(Math.abs(junction - (before + after) / 2) < 0.1, `${[before, junction, after]}`);
  // the branch's floor where it leaves the way's room is the way's beside it
  const edge = branch.line.findIndex(([, n]) => n < 0 && n > -10);
  assert.ok(edge > 0 && Math.abs(defined(branch.floor)[edge] - junction) < 1e-6, `${branch.line[edge]} ${branch.floor}`);
});

test("a known floor holds the tunnel's point nearest it, deeper or shallower than the ground asks, the floor around graded to it", () => {
  // a road tunnel 200 m long under level ground at 100, its portals at 100
  const floors = (known: { p: Point; floor: number }[]) => {
    const tunnel = road("w1", [[0, 0], [200, 0]], { tunnel: true, layer: -2 });
    const map = features([road("w2", [[-50, 0], [0, 0]]), tunnel, road("w3", [[200, 0], [250, 0]])]);
    const result = solveTunnels(map, () => 100, new Map(), known);
    return { floor: defined(tunnel.floor), line: tunnel.line, known: result.known };
  };
  const plain = floors([]);
  const middle = plain.line.findIndex(([e]) => e === 100);
  // 20 m deeper in the middle, 2 m off the line: held there, and no steeper than 7 % around it
  const deep = floors([{ p: [100, 2], floor: plain.floor[middle] - 20 }]);
  assert.equal(deep.known, 1);
  assert.equal(deep.floor[middle], plain.floor[middle] - 20);
  deep.floor.forEach((f, i) => {
    assert.ok(f >= deep.floor[middle] - 1e-9 && f <= plain.floor[i] + 1e-9, `${f} at ${deep.line[i][0]}`);
    if (i > 0) {
      const grade = Math.abs(f - deep.floor[i - 1]) / (deep.line[i][0] - deep.line[i - 1][0]);
      // in from the portals as far as the cover eases in, the floor comes down as it does
      assert.ok(grade <= 0.07 + 1e-9 || deep.line[i][0] <= 30 || deep.line[i][0] >= 170, `${grade} at ${deep.line[i][0]}`);
    }
  });
  // shallower than the ground asks: held there too
  const shallow = floors([{ p: [100, 0], floor: 98 }]);
  assert.equal(shallow.floor[middle], 98);
  // too far from the tunnel: none
  assert.equal(floors([{ p: [100, 20], floor: 50 }]).known, 0);
});

test("a known floor with the tunnel's name holds that tunnel's point, not another tunnel's passing nearer", () => {
  // a road tunnel under level ground at 100 m, and a service tunnel crossing it half a meter off its point at 100 m
  const floorAt100 = (name?: string) => {
    const main = road("w1", [[0, 0], [200, 0]], { tunnel: true, layer: -2, name: "Main" });
    const service = road("w4", [[100.5, -30], [100.5, 30]], { kind: "service", width: 4, tunnel: true, layer: -1 });
    const map = features([road("w2", [[-50, 0], [0, 0]]), main, road("w3", [[200, 0], [250, 0]]), road("w5", [[100.5, -80], [100.5, -30]]), service, road("w6", [[100.5, 30], [100.5, 80]])]);
    solveTunnels(map, () => 100, new Map(), [{ p: [100.6, 0.5], floor: 80, name }]);
    return defined(main.floor)[main.line.findIndex(([e]) => e === 100)];
  };
  assert.notEqual(floorAt100(), 80);
  assert.equal(floorAt100("Main"), 80);
  // a tunnel without a name by its way's OSM element
  assert.equal(floorAt100("w1"), 80);
});

test("between two known floors of a tunnel's name, and on to its portals, the floor runs straight, past a junction too", () => {
  // a road tunnel of two ways, one going on from the other, under level ground at 100 m, and a branch out of it at
  // 100 m to a portal of its own
  const west = road("w1", [[0, 0], [100, 0]], { tunnel: true, layer: -2, name: "Main" });
  const east = road("w9", [[100, 0], [200, 0]], { tunnel: true, layer: -2, name: "Main" });
  const branch = road("w7", [[100, 0], [100, -60]], { kind: "trunk_link", width: 6, tunnel: true, layer: -2 });
  const map = features([road("w2", [[-50, 0], [0, 0]]), west, east, road("w3", [[200, 0], [250, 0]]), branch, road("w8", [[100, -60], [100, -110]])]);
  solveTunnels(map, () => 100, new Map(), [
    { p: [50, 0], floor: 80, name: "Main" },
    { p: [150, 0], floor: 84, name: "Main" },
  ]);
  const line = [...west.line, ...east.line.slice(1)];
  const floor = [...defined(west.floor), ...defined(east.floor).slice(1)];
  const [first, last] = [floor[0], floor[floor.length - 1]];
  line.forEach(([e], i) => {
    const straight = e <= 50 ? first + ((80 - first) * e) / 50 : e <= 150 ? 80 + (4 * (e - 50)) / 100 : 84 + ((last - 84) * (e - 150)) / 50;
    assert.ok(Math.abs(floor[i] - straight) < 1e-6, `${floor[i]} at ${e}`);
  });
});
