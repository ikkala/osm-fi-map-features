import assert from "node:assert/strict";
import { test } from "node:test";
import { deckAt } from "./bridges.ts";
import { solveHeights, type HeightOptions } from "./heights.ts";
import { RESOLUTION_M, type Point } from "./geometry.ts";
import { loadLp } from "./lp.ts";
import type { MapFeatures, Rail, Road } from "./osm.ts";
import { defined } from "./testing.ts";
import { BEND_SPAN_M, isRoad, MAX_BEND_M, type Way } from "./ways.ts";

const lp = await loadLp();
let ids = 0;
/** A road, a bridge where told so (on layer 1) */
function line(bridge: boolean, points: Point[], extra: Partial<Road> = {}): Road {
  return { osm: `w${++ids}`, kind: "footway", width: 2, layer: bridge ? 1 : 0, bridge, tunnel: false, line: points, ...extra };
}
/** Solves the heights of the roads and rails, the pieces split off pushed onto them */
function solveDecks(roads: Road[], rails: Rail[], heightAt: (e: number, n: number) => number | undefined, options: HeightOptions = {}): void {
  const features: MapFeatures = { roads, rails, buildings: [], areas: [], trees: [], lamps: [], crossings: [], signals: [], gates: [], barriers: [], playEquipment: [], bridgeDecks: [] };
  solveHeights(features, heightAt, lp, options);
}
/** Solves the decks of `lines`, the pieces split off pushed onto them */
function solve(lines: Road[], heightAt: (e: number, n: number) => number | undefined, indoors?: (p: Point) => boolean, through?: (l: Road) => boolean): Road[] {
  solveDecks(lines, [], heightAt, { indoors, through });
  return lines;
}
/** Heights within a centimetre of those expected */
function near(heights: number[] | undefined, expected: number[], within = 0.01): void {
  assert.ok(heights && heights.length === expected.length && heights.every((h, i) => Math.abs(h - expected[i]) <= within), `${heights?.map((h) => h.toFixed(3))} is not ${expected}`);
}
// a river 10 m below the banks between e = 10 and e = 30
const heightAt = (e: number) => (e > 10 && e < 30 ? 90 : e <= 10 ? 100 : 104);

test("a bridge deck runs straight from the ground at one end to the other", () => {
  const bridge = line(true, [[10, 0], [20, 0], [30, 0]]);
  const road = line(false, [[0, 0], [10, 0]]);
  solve([road, bridge], heightAt);
  near(bridge.deck, [100, 102, 104]);
  assert.equal(road.deck, undefined);
});

test("bridge ways that meet end to end form one span, whichever way they are drawn", () => {
  const a = line(true, [[20, 0], [10, 0]]);
  const b = line(true, [[20, 0], [25, 0]]);
  const c = line(true, [[30, 0], [25, 0]]);
  solve([b, c, a], heightAt);
  near(a.deck, [102, 100]);
  near(b.deck, [102, 103]);
  near(c.deck, [104, 103]);
});

test("a short bridge over a hollow wider than it takes its ends' height up the ways leading on", () => {
  // an embankment at 102 with a road cut to 97 under e = 0 .. 7, smoothed out to e = -6 .. 13
  const cut = (e: number) => (e <= -6 || e >= 13 ? 102 : e < 0 ? 97 + (5 * -e) / 6 : e > 7 ? 97 + (5 * (e - 7)) / 6 : 97);
  const west = line(false, [[-40, 0], [0, 0]]);
  const bridge = line(true, [[0, 0], [7, 0]]);
  // drawn towards the bridge
  const east = line(false, [[40, 0], [7, 0]]);
  const lines = [west, bridge, east];
  solve(lines, cut);
  near(bridge.deck, [102, 102]);
  // the approaches are split off, up to where the ground stops rising (6 m on)
  assert.equal(lines.length, 5);
  assert.deepEqual(west.line, [[-40, 0], [-6, 0]]);
  assert.deepEqual(east.line, [[40, 0], [13, 0]]);
  const [westRamp, eastRamp] = lines.slice(3);
  assert.deepEqual([westRamp.line, westRamp.deck, westRamp.bridge], [[[-6, 0], [0, 0]], [102, 102], false]);
  assert.deepEqual([eastRamp.line, eastRamp.deck], [[[13, 0], [7, 0]], [102, 102]]);
});

test("a bridge's end at the bottom of a hollow reaching past it takes its height from where the ground stops rising", () => {
  // the hollow's level bottom at 100 goes on 4 m past the bridge's west end; the bank rises to 110 by e = -18
  const hollow = (e: number) => (e >= -4 ? 100 : e <= -18 ? 110 : 100 + ((-4 - e) * 10) / 14);
  const west = line(false, [[-60, 0], [0, 0]]);
  const bridge = line(true, [[0, 0], [10, 0]]);
  const lines = [west, bridge];
  solve(lines, hollow);
  // the east end, with no way on, stays on the ground
  near(bridge.deck, [110, 100]);
  assert.deepEqual(west.line, [[-60, 0], [-18, 0]]);
});

test("the ground falling away from a bridge's end leaves the ways leading on as they are", () => {
  const road = line(false, [[0, 0], [10, 0]]);
  const bridge = line(true, [[10, 0], [20, 0], [30, 0]]);
  const lines = [road, bridge];
  solve(lines, heightAt);
  assert.equal(lines.length, 2);
  assert.equal(road.deck, undefined);
});

test("a deck runs straight over the model's hump under it (the terrain is cut under the deck)", () => {
  const hill = (e: number) => (e === 5 ? 120 : 100);
  const bridge = line(true, [[0, 0], [5, 0], [10, 0]]);
  solve([bridge], hill);
  near(bridge.deck, [100, 100, 100]);
});

test("deckAt interpolates along the nearest segment", () => {
  const line: Point[] = [[0, 0], [10, 0], [10, 10]];
  const deck = [100, 110, 90];
  assert.equal(deckAt(line, deck, [5, 0]), 105);
  assert.equal(deckAt(line, deck, [10, 5]), 100);
  assert.equal(deckAt(line, deck, [0, 0]), 100);
});

test("a junction on a bridge (a ramp leaving it) hangs between the bridge's ends, not on the ground under it", () => {
  // ground 100 at both ends, 80 under the middle, where a ramp leaves the bridge
  const ground = (e: number) => (e <= 0 || e >= 100 ? 100 : 80);
  const west = line(true, [[0, 0], [50, 0]]);
  const east = line(true, [[50, 0], [100, 0]]);
  const ramp = line(true, [[50, 0], [100, 20]]);
  const lines = [line(false, [[-20, 0], [0, 0]]), west, east, ramp, line(false, [[100, 0], [120, 0]])];
  solve(lines, ground);
  const round = (deck: number[] | undefined) => deck?.map((h) => Math.round(h * 100) / 100);
  assert.deepEqual([round(west.deck), round(east.deck), round(ramp.deck)], [[100, 100], [100, 100], [100, 100]]);
});

test("a bridge's end meeting only ways indoors (going into a building) takes no height from the ground: the deck runs level from its other end", () => {
  // a footbridge from a hillside at 120 to a tower on the ground at 100 below, which the ways indoors go into
  const ground = (e: number) => (e <= 0 ? 120 : 100);
  const hillside = line(false, [[-20, 0], [0, 0]]);
  const bridge = line(true, [[0, 0], [70, 0]]);
  solve([hillside, bridge], ground, (p) => p[0] === 70);
  near(bridge.deck, [120, 120]);
  // without them it runs down to the ground at the tower
  const again = line(true, [[0, 0], [70, 0]]);
  solve([line(false, [[-20, 0], [0, 0]]), again], ground);
  near(again.deck, [120, 100]);
});

test("steps from a bridge down to the ground give the deck its height there, the deck rising to it and down again", () => {
  const ground = () => 100;
  const bridge = line(true, [[0, 0], [30, 0], [60, 0], [100, 0]]);
  // 32 steps down from the bridge at e 60 to the ground 20 m off: 32 * 0.16 = 5.12 m
  const steps = line(false, [[60, 0], [60, 20]], { stepCount: 32, incline: "down" });
  solve([bridge, steps], ground);
  const at = (e: number) => Math.round(deckAt(bridge.line, bridge.deck ?? [], [e, 0]) * 100) / 100;
  // up to the steps' height and down again, the crest rounded by raising the deck around it
  assert.deepEqual([at(0), at(100)], [100, 100]);
  assert.ok(Math.abs(at(60) - 105.12) <= 0.01 && at(30) >= 102.56);
});

test("steps drawn up to a bridge count the same, and a height under the line through the others does not bend the deck down", () => {
  const ground = (e: number) => (e >= 100 ? 110 : 100);
  const bridge = line(true, [[0, 0], [50, 0], [100, 0]]);
  // up 12 steps from the ground at 100 m to the bridge's middle: 101.92, under the straight line's 105
  const steps = line(false, [[50, 20], [50, 0]], { stepCount: 12, incline: "up" });
  solve([bridge, steps], ground);
  near(bridge.deck, [100, 105, 110]);
});

test("steps without a count or a way they climb give no height", () => {
  const bridge = line(true, [[0, 0], [50, 0], [100, 0]]);
  const counted = line(false, [[50, 0], [50, 20]], { incline: "down" });
  const unsure = line(false, [[50, 0], [50, -20]], { stepCount: 30 });
  solve([bridge, counted, unsure], () => 100);
  near(bridge.deck, [100, 100, 100]);
});

test("a deck's crest is rounded, so it bends no more than 0.2 m over 10 m either way, and stays near the steps' height", () => {
  const bridge = line(true, [[0, 0], [50, 0], [100, 0]]);
  // 10 steps down from the bridge's middle: 101.6 m, a change of grade of 6.4 % there
  const steps = line(false, [[50, 0], [50, 20]], { stepCount: 10, incline: "down" });
  solve([bridge, steps], () => 100);
  const deck = bridge.deck ?? [];
  const at = (e: number) => deckAt(bridge.line, deck, [e, 0]);
  for (let e = 10; e <= 90; e += 1) {
    assert.ok(Math.abs(at(e) - (at(e - 10) + at(e + 10)) / 2) <= 0.2 + 1e-6, `bends at ${e}`);
  }
  assert.ok(at(50) > 101.6 - 0.3 && at(50) <= 101.6);
  assert.deepEqual([deck[0], deck[deck.length - 1]], [100, 100]);
});

test("a way through a building between two bridges' ends carries the span on through it, level with them, not down to the ground", () => {
  // a bridge from the ground at 89 m to a building's wall at e 0, through it at e 0 .. 12, and on from 12 to 90 m
  const ground = (e: number) => (e <= -45 ? 89 : e >= 30 ? 90 : 84);
  const east = line(true, [[-45, 0], [0, 0]]);
  const through = line(false, [[0, 0], [12, 0]]);
  const west = line(true, [[12, 0], [30, 0]]);
  solve([east, through, west], ground, () => false, (l) => l === through);
  const at = (l: Road, e: number) => Math.round(deckAt(l.line, l.deck ?? [], [e, 0]) * 100) / 100;
  assert.deepEqual([at(east, -45), at(east, 0), at(through, 6), at(west, 30)], [89, 89.6, 89.68, 90]);
  // a way through a building not between bridges stays on the ground
  const alone = line(false, [[100, 0], [110, 0]]);
  solve([alone], ground, () => false, () => true);
  assert.equal(alone.deck, undefined);
});

test("a way above the ground that is no bridge, where steps come up to its end, is carried at the height they tell", () => {
  // straight steps above the ground from the street at 103.2 m down to where a spiral of 24 steps goes on down to a
  // footway at 98.15 m; the ground under them is 98.9 m
  const ground = (e: number, n: number) => (e <= 0 ? 103.2 : n < -5 ? 98.15 : 98.9);
  const street = line(false, [[-10, 0], [0, 0]]);
  const straight = line(false, [[0, 0], [13, 0]], { layer: 1 });
  const spiral = line(false, [[13, 0], [16, -3], [13, -6], [10, -3], [13, -10]], { stepCount: 24, incline: "down" });
  const footway = line(false, [[13, -10], [20, -10]]);
  solve([street, straight, spiral, footway], ground);
  const at = (l: Road, p: Point) => Math.round(deckAt(l.line, l.deck ?? [], p) * 100) / 100;
  assert.deepEqual([at(straight, [0, 0]), at(straight, [13, 0])], [103.2, 101.99]);
  // the spiral and the ways on the ground keep to the ground, the spiral drawn between the deck and the footway
  assert.deepEqual([spiral.deck, street.deck, footway.deck], [undefined, undefined, undefined]);
});

test("a way above the ground that steps come up to, ending where no way goes on, runs level from where they come up", () => {
  // 16 steps up to a landing at a door
  const landing = line(false, [[0, 0], [2, 0]], { layer: 1 });
  const steps = line(false, [[0, -5], [0, 0]], { layer: 1, stepCount: 16, incline: "up" });
  solve([landing, steps], () => 100);
  assert.deepEqual(landing.deck?.map((h) => Math.round(h * 100) / 100), [102.56, 102.56]);
  assert.equal(steps.deck, undefined);
});

test("steps up to a way above the ground do not lift it where a way on the ground meets them, nor by less than half a metre", () => {
  const onGround = (): Road[] => [
    line(false, [[0, 0], [10, 0]], { layer: 1 }),
    line(false, [[0, -5], [0, 0]], { stepCount: 16, incline: "up" }),
  ];
  const [met, upMet] = onGround();
  const path = line(false, [[0, 0], [-10, 0]]);
  solve([met, upMet, path], () => 100);
  assert.equal(met.deck, undefined);
  // 3 steps up a slope that climbs 0.4 m
  const close = line(false, [[0, 0], [10, 0]], { layer: 1 });
  const few = line(false, [[0, -5], [0, 0]], { stepCount: 3, incline: "up" });
  solve([close, few], (_e, n) => (n < -1 ? 100 : 100.4));
  assert.equal(close.deck, undefined);
});

test("steps lift a way above the ground only from a way on the ground or a dead end: not a landing two flights tell apart", () => {
  // a landing between a flight of 27 steps up from 137 m and one of 40 steps up to a level at 152.6 m: they tell its
  // ends 141.3 m and 146.2 m
  const ground = (e: number) => (e < 0 ? 137 : e > 20 ? 152.6 : 140);
  const lower = line(false, [[-5, 0], [0, 0]], { layer: 1, stepCount: 27, incline: "up" });
  const landing = line(false, [[0, 0], [7, 0]], { layer: 1 });
  const upper = line(false, [[7, 0], [25, 0]], { layer: 1, stepCount: 40, incline: "up" });
  solve([lower, landing, upper], ground);
  assert.deepEqual([lower.deck, landing.deck, upper.deck], [undefined, undefined, undefined]);
});

test("the end of a way above the ground that a way on the ground passes through takes the ground's height there", () => {
  // as the stairs to the spiral, but the street passes through their top
  const ground = (e: number, n: number) => (e <= 0 ? 103.2 : n < -5 ? 98.15 : 98.9);
  const street = line(false, [[0, -10], [0, 0], [0, 10]]);
  const straight = line(false, [[0, 0], [13, 0]], { layer: 1 });
  const spiral = line(false, [[13, 0], [16, -3], [13, -6], [10, -3], [13, -10]], { stepCount: 24, incline: "down" });
  solve([street, straight, spiral], ground);
  assert.deepEqual(straight.deck?.map((h) => Math.round(h * 100) / 100), [103.2, 101.99]);
  assert.equal(street.deck, undefined);
});

test("a boardwalk's deck follows the ground a little over it, not straight from one end to the other", () => {
  // a hollow 2 m deep and 20 m across at its bottom, much wider than the boardwalk keeps level over
  const ground = (e: number) => (e <= 10 || e >= 40 ? 100 : e < 15 ? 100 - (2 * (e - 10)) / 5 : e > 35 ? 100 - (2 * (40 - e)) / 5 : 98);
  const boardwalk = line(true, [[0, 0], [50, 0]], { boardwalk: true });
  const path = line(false, [[50, 0], [60, 0]]);
  solve([boardwalk, path], ground);
  const deck = defined(boardwalk.deck);
  const at = (e: number) => Math.round(deckAt(boardwalk.line, deck, [e, 0]) * 100) / 100;
  assert.deepEqual([at(0), at(5), at(12.5), at(25), at(37.5), at(50)], [100.3, 100.3, 99.3, 98.3, 99.3, 100.3]);
  // points where it bends, and none along its level stretches
  assert.ok(boardwalk.line.length > 2 && boardwalk.line.length < 12);
  assert.equal(path.deck, undefined);
});

test("a boardwalk keeps level over a ditch narrower than it spans", () => {
  const ditch = (e: number) => (e > 18 && e < 22 ? 99 : 100);
  const boardwalk = line(true, [[0, 0], [20, 0], [40, 0]], { boardwalk: true });
  solve([boardwalk], ditch);
  near(boardwalk.deck, [100.3, 100.3, 100.3]);
  assert.equal(boardwalk.line.length, 3);
});

test("a bridge way ending on another bridge's inner point takes the deck's height there, not the ground's under it", () => {
  // the ground 100 at the bridge's ends, 80 under it and where the way leaving it mid-span comes down
  const ground = (e: number) => (e <= 0 || e >= 100 ? 100 : 80);
  const bridge = line(true, [[0, 0], [50, 0], [100, 0]]);
  const leaving = line(true, [[50, 0], [50, 30]]);
  // listed first, so its deck waits for the one it ends on
  solve([leaving, bridge], ground);
  near(bridge.deck, [100, 100, 100]);
  near(leaving.deck, [100, 80]);
});

test("a bridge ending on a boardwalk starts at the boardwalk's deck", () => {
  // a footbridge over a brook at e = 25 on from a boardwalk
  const ground = (e: number) => (e > 22 && e < 28 ? 97 : 100);
  const boardwalk = line(true, [[0, 0], [20, 0]], { boardwalk: true });
  const footbridge = line(true, [[20, 0], [30, 0]]);
  solve([footbridge, boardwalk], ground);
  near(footbridge.deck, [100.3, 100]);
  near(boardwalk.deck, [100.3, 100.3]);
});

test("a boardwalk with a floor (a ramp down to a tunnel) is decked as a bridge, its points kept, and no longer told a boardwalk", () => {
  const ground = () => 100;
  const ramp = line(true, [[0, 0], [20, 0]], { boardwalk: true, floor: [100, 99] });
  solve([ramp], ground);
  assert.deepEqual([ramp.line, ramp.deck, ramp.boardwalk], [[[0, 0], [20, 0]], [100, 100], undefined]);
});

test("a deck rises over a way under it to the room OSM tells, never dipping, its landings and approaches rising as far as that needs at their grade, the way keeping to the ground", () => {
  // level ground at 100; a 60 m footbridge from e = 0 to e = 60 over a path at e = 50 with 5 m of room told: the
  // deck's top at 106 over it
  const flat = () => 100;
  const west = line(false, [[-100, 0], [0, 0]]);
  const bridge = line(true, [[0, 0], [60, 0]]);
  const east = line(false, [[60, 0], [160, 0]]);
  const under = line(false, [[50, -50], [50, 50]], { clearance: 5 });
  const lines = solve([west, bridge, east, under], flat);
  const deck = defined(bridge.deck);
  const at = (e: number) => deckAt(bridge.line, deck, [e, 0]);
  // within the simplified deck's tolerance
  assert.ok(at(50) >= 106 - 0.05);
  for (let e = 2; e <= 58; e += 2) {
    assert.ok(at(e) >= (at(e - 2) + at(e + 2)) / 2 - 1e-6, `dips at ${e}`);
  }
  assert.ok(lines.filter((l) => l.osm === under.osm).every((l) => l.floor === undefined && l.deck === undefined));
  // the approaches raised, down to the ground at their users' grade
  const ramps = lines.filter((l) => !l.bridge && l.deck);
  assert.equal(ramps.length, 2);
  for (const ramp of ramps) {
    const deck = defined(ramp.deck);
    const along = ramp.line.map(([e]) => e);
    deck.slice(1).forEach((h, i) => assert.ok(Math.abs(h - deck[i]) <= 0.08 * Math.abs(along[i + 1] - along[i]) + 1e-6, `${along} ${deck}`));
    assert.ok(Math.abs(Math.min(...deck) - 100) < 1e-6);
  }
});

test("a deck high enough over the way under it stays as it is", () => {
  const bridge = line(true, [[10, 0], [20, 0], [30, 0]]);
  const road = line(false, [[0, 0], [10, 0]]);
  const under = line(false, [[20, -20], [20, 20]], { clearance: 1 });
  solve([road, bridge, under], heightAt);
  near(bridge.deck, [100, 102, 104]);
  assert.equal(road.deck, undefined);
  assert.equal(under.floor, undefined);
});

test("an approach is held at the ground where a way of other users crosses it", () => {
  // as above, but a street crossing the west approach at grade 5 m out
  const flat = () => 100;
  const west = line(false, [[-100, 0], [-5, 0], [0, 0]]);
  const street = line(false, [[-5, -20], [-5, 0], [-5, 20]], { kind: "residential", width: 6 });
  const bridge = line(true, [[0, 0], [60, 0]]);
  const east = line(false, [[60, 0], [160, 0]]);
  const under = line(false, [[50, -50], [50, 50]], { clearance: 5 });
  const lines = solve([west, street, bridge, east, under], flat);
  assert.deepEqual(street.deck, undefined);
  const ramp = defined(lines.find((l) => !l.bridge && l.deck && l.line.some(([e]) => e < 0)));
  assert.ok(ramp.line.every(([e]) => e >= -5 - 1e-6));
  assert.ok(Math.abs(deckAt(ramp.line, defined(ramp.deck), [-5, 0]) - 100) < 0.06);
});

test("bridge lines meeting end to end where a way on the ground leads on land there: two decks, not one over it", () => {
  // two ramps down from the banks to a path in the hollow between them
  const valley = (e: number) => 100 + Math.abs(e - 20) / 5;
  const a = line(true, [[0, 0], [10, 0], [20, 0]]);
  const b = line(true, [[20, 0], [30, 0], [40, 0]]);
  const path = line(false, [[20, 0], [20, -30]]);
  const lines = [line(false, [[-20, 0], [0, 0]]), a, b, line(false, [[40, 0], [60, 0]]), path];
  solve(lines, valley);
  // both land on the ground at the path, not over it
  assert.ok(Math.abs(defined(a.deck)[2] - 100) < 1e-9 && Math.abs(defined(b.deck)[0] - 100) < 1e-9);
  assert.equal(path.deck, undefined);
});

// Ways under the decks: a road bridge along e at n = 0 landing at 100 at e = ±30 (no way leading on, so its deck stays
// level at 100), over ground at `level`
function road(osm: string, points: Point[], extra: Partial<Road> = {}): Road {
  return { osm, kind: "residential", width: 6, layer: 0, bridge: false, tunnel: false, line: points, ...extra };
}
const bridge = () => road("w1", [[-30, 0], [30, 0]], { layer: 1, bridge: true });
const under = (level: number) => (e: number) => (Math.abs(e) >= 30 ? 100 : level);
/** Solves them, the roads and the rails, and the cut stretches of `osm` */
function cut(roads: Road[], level: number, rails: Rail[] = []): { cuts: (osm: string) => Way[] } {
  solveDecks(roads, rails, under(level));
  return { cuts: (osm) => [...roads, ...rails].filter((w) => w.osm === osm && w.floor) };
}

test("a way under a bridge too low over it goes down into a cut under it, the deck staying straight", () => {
  const deck = bridge();
  const path = road("w2", [[0, -60], [0, 60]], { kind: "footway", width: 2.5 });
  const ways = [deck, path];
  const [floor] = cut(ways, 98).cuts("w2");
  near(deck.deck, [100, 100]);
  // the room for people (2.7 m) and the deck's 1 m under the deck: 96.3, ramping up at 8 % to the ground
  assert.ok(floor && floor.floor && isRoad(floor));
  // as deep as the room needs, or a bend deeper, to round its bottom
  assert.ok(Math.min(...floor.floor) <= 96.3 + 0.02 && Math.min(...floor.floor) >= 96.3 - MAX_BEND_M);
  // its room in the cut that much, so its roof stays under the deck
  assert.ok(floor.room !== undefined && Math.abs(floor.room - 2.7) < 0.02);
  assert.ok(Math.abs(floor.floor[0] - 98) <= 0.05 && Math.abs(floor.floor[floor.floor.length - 1] - 98) <= 0.05);
  // under the deck (its 6 m, 0.5 m edges and a meter more) at the bottom; the ramps 1.7 m / 8 % long or more
  const n = floor.line.map(([, y]) => y);
  assert.ok(Math.min(...n) < -4.5 - 1.7 / 0.08 + 2 && Math.max(...n) > 4.5 + 1.7 / 0.08 - 2);
  assert.equal(ways.filter((w) => w.osm === "w2").length, 3);
});

test("a cut's ramps ease out of its bottom, with only the points its floor's shape needs: it bends no more than MAX_BEND_M from the line BEND_SPAN_M either side", () => {
  for (const [kind, width] of [["footway", 2.5], ["primary", 6]] as const) {
    const way = road("w2", [[0, -100], [0, 100]], { kind, width });
    const [floor] = cut([bridge(), way], 98.5).cuts("w2");
    assert.ok(floor?.floor);
    assert.ok(floor.line.length <= 40, `${kind}: ${floor.line.length} points`);
    const heights = floor.floor;
    const n = floor.line.map(([, y]) => y);
    const at = (y: number) => {
      const i = n.findIndex((v, k) => k + 1 < n.length && v <= y && n[k + 1] >= y);
      return heights[i] + ((heights[i + 1] - heights[i]) * (y - n[i])) / (n[i + 1] - n[i] || 1);
    };
    for (let y = n[0] + BEND_SPAN_M; y <= n[n.length - 1] - BEND_SPAN_M; y += 0.5) {
      // its points kept within half the resolution of its heights
      assert.ok(Math.abs(at(y) - (at(y - BEND_SPAN_M) + at(y + BEND_SPAN_M)) / 2) <= MAX_BEND_M + RESOLUTION_M / 2, `${kind} at ${y}`);
    }
  }
});

test("a cut is local: held at the ground where a way meets it, its ramp rising before it, the way crossing keeping its own heights", () => {
  // 1.7 m down for a person's room: ramps at 8 % end 21 m past the bottom; a street across the ramp 32 m out
  const path = road("w2", [[0, -60], [0, 32], [0, 60]], { kind: "footway", width: 2.5 });
  const street = road("w3", [[-30, 32], [0, 32], [30, 32]]);
  const ways = [bridge(), path, street];
  const solved = cut(ways, 98);
  const [floor] = solved.cuts("w2");
  assert.ok(floor?.floor);
  assert.ok(Math.min(...floor.floor) <= 96.3 + 0.02);
  assert.ok(Math.max(...floor.line.map(([, n]) => n)) <= 32 + 1e-6);
  assert.equal(street.floor, undefined);
  // a path on another layer across the other ramp holds it there too
  const other = road("w4", [[0, -60], [0, -10], [0, 60]], { kind: "footway", width: 2.5 });
  const above = road("w5", [[-20, -10], [0, -10], [20, -10]], { kind: "footway", width: 2.5, layer: 1 });
  const held = [bridge(), other, above];
  const cuts = cut(held, 98).cuts("w4");
  assert.ok(cuts.every((w) => w.line.every(([, n], i) => n > -10 + 1e-6 || (n === -10 && Math.abs(defined(w.floor)[i] - 98) < 1e-6))));
});

test("a way whose room would need a cut deeper than 3 m goes down 3 m, the deck staying on its landings' line, the rest missed; one ending under the bridge is held at its end", () => {
  const deck = bridge();
  const deep = road("w2", [[0, -60], [0, 60]], { kind: "primary" });
  const ending = road("w3", [[10, -60], [10, 1]], { kind: "footway", width: 2.5 });
  const ways = [deck, deep, ending];
  // a road needs 4.2 m and the deck's 1 m: 94.8, 4.2 m under the ground at 99; 3 m deep, at 96, it has 3 m under a
  // level deck
  const solved = cut(ways, 99);
  const [floor] = solved.cuts("w2");
  assert.ok(floor?.floor && isRoad(floor) && floor.room !== undefined);
  const lowest = Math.min(...floor.floor);
  assert.ok(lowest >= 96 - 0.02 && lowest <= 96 + 0.05 && Math.abs(deckAt(deck.line, defined(deck.deck), [0, 0]) - 100) < 1e-6);
  assert.ok(Math.abs(floor.room - 3) < 0.06, `${floor.room}`);
  assert.ok(solved.cuts("w3").every((w) => w.line.every(([e, n], i) => e !== 10 || n !== 1 || Math.abs(defined(w.floor)[i] - 99) < 1e-6)));
});

test("ways joined end to end under a bridge go down as one, across where they meet, with no step there", () => {
  // a railway in two ways meeting under the bridge
  const a: Rail = { osm: "w2", kind: "rail", layer: 0, bridge: false, tunnel: false, line: [[0, -200], [0, 1]] };
  const b: Rail = { osm: "w3", kind: "rail", layer: 0, bridge: false, tunnel: false, line: [[0, 1], [0, 200]] };
  const solved = cut([bridge()], 97, [a, b]);
  const [ofA, ofB] = [solved.cuts("w2"), solved.cuts("w3")].map((list) => defined(list[0]?.floor));
  assert.ok(Math.abs(ofA[ofA.length - 1] - ofB[0]) < 1e-9 && ofB[0] < 97 - 1);
});

test("paths meeting under a bridge, each in a cut of its own there, meet at one height; a path crossing a cut keeps to the ground", () => {
  const path = road("w2", [[0, -60], [0, 2], [0, 12], [0, 60]], { kind: "footway", width: 2.5 });
  // a cycleway joining it under the deck, and a footway across it where its ramp is
  const joining = road("w3", [[0, 2], [80, 2]], { kind: "cycleway", width: 3 });
  const across = road("w4", [[-40, 12], [0, 12], [40, 12]], { kind: "footway", width: 2.5 });
  const ways = [bridge(), path, joining, across];
  cut(ways, 98);
  const floorAt = (osm: string, p: Point) => {
    for (const way of ways.filter((w) => w.osm === osm && w.floor)) {
      const i = way.line.findIndex(([e, n]) => e === p[0] && n === p[1]);
      if (i >= 0 && way.floor) {
        return way.floor[i];
      }
    }
    return undefined;
  };
  // at one height where they meet, down in their cuts under the deck, which stays on its landings' line
  const met = floorAt("w2", [0, 2]) ?? 98;
  assert.equal(floorAt("w3", [0, 2]) ?? 98, met);
  assert.ok(met < 98 - 0.5 && Math.abs(deckAt(ways[0].line, defined(ways[0].deck), [0, 0]) - 100) < 1e-6, `${met}`);
  // the path across keeps to the ground
  assert.ok(ways.filter((w) => w.osm === "w4").every((w) => w.floor === undefined));
});

test("a way under a bridge with room enough stays on its ground", () => {
  const path = road("w2", [[0, -60], [0, 60]], { kind: "footway", width: 2.5 });
  assert.deepEqual(cut([bridge(), path], 95).cuts("w2"), []);
});

test("a way under a deck leaving the room OSM tells (its maxheight, the bridge's min_height) stays on the ground, with no cut", () => {
  // the deck's underside 4 m over the ground at 96, less than a road's 4.2 m
  const tagged = road("w2", [[0, -60], [0, 60]], { kind: "primary", clearance: 4 });
  assert.deepEqual(cut([bridge(), tagged], 95).cuts("w2"), []);
  const told = road("w1", [[-30, 0], [30, 0]], { layer: 1, bridge: true, roomUnder: 4 });
  const plain = road("w3", [[0, -60], [0, 60]], { kind: "primary" });
  assert.deepEqual(cut([told, plain], 95).cuts("w3"), []);
  // under a deck lower than that the deck misses it: the way still keeps to the ground
  const short = road("w4", [[0, -60], [0, 60]], { kind: "primary", clearance: 4 });
  assert.deepEqual(cut([bridge(), short], 98).cuts("w4"), []);
});

test("a railway under a deck keeps its users' least room: the deck rises for it, its approaches as steep as that needs", () => {
  // a railway under a footbridge landing on paths at 100, the ground under it 97: a train's least room 4.8 m and the
  // deck's 1 m need the deck at 102.8 or the railway in a cut
  const footbridge = road("w1", [[-10, 0], [10, 0]], { kind: "footway", width: 3, layer: 1, bridge: true });
  const west = road("w5", [[-60, 0], [-10, 0]], { kind: "footway", width: 3 });
  const east = road("w6", [[10, 0], [60, 0]], { kind: "footway", width: 3 });
  const tram: Rail = { osm: "w2", kind: "rail", layer: 0, bridge: false, tunnel: false, line: [[0, -200], [0, 200]] };
  const roads = [footbridge, west, east];
  const rails = [tram];
  solveDecks(roads, rails, (e) => (Math.abs(e) >= 10 ? 100 : 97));
  const lowest = Math.min(97, ...rails.flatMap((w) => w.floor ?? []));
  const deck = deckAt(footbridge.line, defined(footbridge.deck), [0, 0]);
  assert.ok(deck - 1 - lowest >= 4.8 - 0.01, `${deck} over ${lowest}`);
});

test("a way between two spans is an approach of both: raised from either landing, it reaches both decks", () => {
  // two footbridges over paths with 4 m of room told, 30 m apart on level ground
  const flat = () => 100;
  const ways = [
    line(false, [[-100, 0], [0, 0]]),
    line(true, [[0, 0], [20, 0]]),
    line(false, [[20, 0], [50, 0]]),
    line(true, [[50, 0], [70, 0]]),
    line(false, [[70, 0], [170, 0]]),
    line(false, [[10, -30], [10, 30]], { clearance: 4 }),
    line(false, [[60, -30], [60, 30]], { clearance: 4 }),
  ];
  const [, a, between, b] = ways;
  solve(ways, flat);
  const middle = ways.filter((w) => w.osm === between.osm);
  const heightAt = (p: Point) => Math.max(...middle.map((w) => (w.deck && w.line.some((q) => q[0] === p[0] && q[1] === p[1]) ? deckAt(w.line, w.deck, p) : 100)));
  assert.ok(Math.abs(heightAt([20, 0]) - defined(a.deck)[defined(a.deck).length - 1]) < 1e-6);
  assert.ok(Math.abs(heightAt([50, 0]) - defined(b.deck)[0]) < 1e-6);
  assert.ok(defined(a.deck)[0] > 100.5 && defined(b.deck)[0] > 100.5);
});

test("a steep short bridge keeps its landings: its deck as steep as they are, nothing around it raised", () => {
  // a track bridge rising 2.3 m over 10 m between its landings on the ground
  const slope = (e: number) => (e <= 0 ? 100 : e >= 10 ? 102.3 : 99);
  const west = line(false, [[-50, 0], [0, 0]], { kind: "track", width: 3 });
  const bridge = line(true, [[0, 0], [10, 0]], { kind: "track", width: 3 });
  const east = line(false, [[10, 0], [60, 0]], { kind: "track", width: 3 });
  const lines = solve([west, bridge, east], slope);
  near(bridge.deck, [100, 102.3]);
  assert.equal(lines.length, 3);
  assert.deepEqual([west.deck, east.deck], [undefined, undefined]);
});

test("a raise never spreads into the network: an approach is held at the ground at the first junction on its line", () => {
  const flat = () => 100;
  // a path off the bridge's west landing, branching 10 m out
  const ways = [
    line(false, [[-10, 0], [0, 0]]),
    line(false, [[-100, 0], [-10, 0]]),
    line(false, [[-10, 0], [-10, -100]]),
    line(true, [[0, 0], [60, 0]]),
    line(false, [[60, 0], [160, 0]]),
    line(false, [[50, -50], [50, 50]], { clearance: 5 }),
  ];
  solve(ways, flat);
  const raised = ways.filter((w) => !w.bridge && w.deck);
  assert.ok(raised.length >= 2);
  assert.ok(raised.every((w) => w.line.every(([e, n]) => n === 0 && (e >= -10 - 1e-6 || e >= 60))), JSON.stringify(raised.map((w) => w.line)));
  const west = defined(raised.find((w) => w.line.some(([e]) => e < 0)));
  assert.ok(Math.abs(deckAt(west.line, defined(west.deck), [-10, 0]) - 100) < 1e-6);
});

test("ways side by side under a deck each go down for their room: a road's cut as deep as a cut goes, the cycleway beside it to its own", () => {
  const street = road("w2", [[0, -60], [0, 60]], { kind: "secondary", width: 7 });
  const cycleway = road("w3", [[6, -60], [6, 60]], { kind: "cycleway", width: 3 });
  const deck = bridge();
  const ways = [deck, street, cycleway];
  const solved = cut(ways, 98.5);
  const top = deckAt(deck.line, defined(deck.deck), [3, 0]) - 1;
  const lowest = (osm: string) => Math.min(98.5, ...solved.cuts(osm).flatMap((w) => w.floor ?? []));
  assert.ok(Math.abs(top - 99) < 1e-6 && Math.abs(lowest("w2") - (98.5 - 3)) < 0.05 && top - lowest("w3") >= 2.7 - 0.02, `${top} ${lowest("w2")} ${lowest("w3")}`);
});

test("a tramway under a deck goes down into a cut where it can; where a way of another layer meeting it holds it, its bed goes down under the deck instead (trackbeds.ts), the deck staying on its landings' line", () => {
  const tram = (): Rail => ({ osm: "w2", kind: "tram", layer: 0, bridge: false, tunnel: false, line: [[0, -200], [0, 6], [0, 200]] });
  const free = [tram()];
  cut([bridge()], 97, free);
  assert.ok(free.some((r) => r.floor && Math.min(...r.floor) < 97 - 1));
  // a street across it by the deck: the deck's underside 2 m over the ground, which the bed 3 m down makes 5 m
  const street = () => road("w3", [[-20, 6], [0, 6], [20, 6]], { layer: 1 });
  const held = [tram()];
  const deck = bridge();
  solveDecks([deck, street()], held, under(97));
  assert.ok(held.every((r) => r.floor === undefined || Math.min(...r.floor) > 97 - 0.5));
  near(deck.deck, [100, 100]);
  // 0.5 m over the ground it is not enough: the deck stays, the rest of the room missed
  const higher = bridge();
  const rails = [tram()];
  solveDecks([higher, street()], rails, under(98.5));
  near(higher.deck, [100, 100]);
});

test("a cut does not take the room of a way beside it: where their rooms overlap they share a height, here the ground's", () => {
  // a cycleway beside the street north of the deck, not under it, on no cut's way
  const street = road("w2", [[0, -60], [0, 60]], { kind: "secondary", width: 7 });
  const cycleway = road("w3", [[5, 10], [5, 60]], { kind: "cycleway", width: 3 });
  const ways = [bridge(), street, cycleway];
  const solved = cut(ways, 98.5);
  const cuts = solved.cuts("w2");
  assert.ok(cuts.length > 0 && cycleway.floor === undefined);
  const beside = cuts.flatMap((w) => w.line.flatMap((p, i) => (p[1] >= 10 ? [defined(w.floor)[i]] : [])));
  assert.ok(beside.every((h) => h >= 98.5 - 0.06), `${beside}`);
});
