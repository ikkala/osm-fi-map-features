import assert from "node:assert/strict";
import { test } from "node:test";
import { deckAt, setBridgeDecks, type BridgeLine } from "./bridges.ts";
import type { Point } from "./geometry.ts";

// a river 10 m below the banks between e = 10 and e = 30
const heightAt = (e: number) => (e > 10 && e < 30 ? 90 : e <= 10 ? 100 : 104);

test("a bridge deck runs straight from the ground at one end to the other", () => {
  const bridge: BridgeLine = { bridge: true, line: [[10, 0], [20, 0], [30, 0]] };
  const road: BridgeLine = { bridge: false, line: [[0, 0], [10, 0]] };
  setBridgeDecks([road, bridge], heightAt);
  assert.deepEqual(bridge.deck, [100, 102, 104]);
  assert.equal(road.deck, undefined);
});

test("bridge ways that meet end to end form one span, whichever way they are drawn", () => {
  const a: BridgeLine = { bridge: true, line: [[20, 0], [10, 0]] };
  const b: BridgeLine = { bridge: true, line: [[20, 0], [25, 0]] };
  const c: BridgeLine = { bridge: true, line: [[30, 0], [25, 0]] };
  setBridgeDecks([b, c, a], heightAt);
  assert.deepEqual(a.deck, [102, 100]);
  assert.deepEqual(b.deck, [102, 103]);
  assert.deepEqual(c.deck, [104, 103]);
});

test("a short bridge over a hollow wider than it takes its ends' height up the ways leading on", () => {
  // an embankment at 102 with a road cut to 97 under e = 0 .. 7, smoothed out to e = -6 .. 13
  const cut = (e: number) => (e <= -6 || e >= 13 ? 102 : e < 0 ? 97 + (5 * -e) / 6 : e > 7 ? 97 + (5 * (e - 7)) / 6 : 97);
  const west: BridgeLine = { bridge: false, line: [[-40, 0], [0, 0]] };
  const bridge: BridgeLine = { bridge: true, line: [[0, 0], [7, 0]] };
  // drawn towards the bridge
  const east: BridgeLine = { bridge: false, line: [[40, 0], [7, 0]] };
  const lines = [west, bridge, east];
  setBridgeDecks(lines, cut);
  assert.deepEqual(bridge.deck, [102, 102]);
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
  const west: BridgeLine = { bridge: false, line: [[-60, 0], [0, 0]] };
  const bridge: BridgeLine = { bridge: true, line: [[0, 0], [10, 0]] };
  const lines = [west, bridge];
  setBridgeDecks(lines, hollow);
  // the east end, with no way on, stays on the ground
  assert.deepEqual(bridge.deck, [110, 100]);
  assert.deepEqual(west.line, [[-60, 0], [-18, 0]]);
});

test("the ground falling away from a bridge's end leaves the ways leading on as they are", () => {
  const road: BridgeLine = { bridge: false, line: [[0, 0], [10, 0]] };
  const bridge: BridgeLine = { bridge: true, line: [[10, 0], [20, 0], [30, 0]] };
  const lines = [road, bridge];
  setBridgeDecks(lines, heightAt);
  assert.equal(lines.length, 2);
  assert.equal(road.deck, undefined);
});

test("a deck runs straight over the model's hump under it (the terrain is cut under the deck)", () => {
  const hill = (e: number) => (e === 5 ? 120 : 100);
  const bridge: BridgeLine = { bridge: true, line: [[0, 0], [5, 0], [10, 0]] };
  setBridgeDecks([bridge], hill);
  assert.deepEqual(bridge.deck, [100, 100, 100]);
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
  const west: BridgeLine = { bridge: true, line: [[0, 0], [50, 0]] };
  const east: BridgeLine = { bridge: true, line: [[50, 0], [100, 0]] };
  const ramp: BridgeLine = { bridge: true, line: [[50, 0], [100, 20]] };
  const lines = [{ bridge: false, line: [[-20, 0], [0, 0]] satisfies Point[] }, west, east, ramp, { bridge: false, line: [[100, 0], [120, 0]] satisfies Point[] }];
  setBridgeDecks(lines, ground);
  const round = (deck: number[] | undefined) => deck?.map((h) => Math.round(h * 100) / 100);
  assert.deepEqual([round(west.deck), round(east.deck), round(ramp.deck)], [[100, 100], [100, 100], [100, 100]]);
});

test("a bridge's end meeting only ways indoors (going into a building) takes no height from the ground: the deck runs level from its other end", () => {
  // a footbridge from a hillside at 120 to a tower on the ground at 100 below, which the ways indoors go into
  const ground = (e: number) => (e <= 0 ? 120 : 100);
  const hillside: BridgeLine = { bridge: false, line: [[-20, 0], [0, 0]] };
  const bridge: BridgeLine = { bridge: true, line: [[0, 0], [70, 0]] };
  setBridgeDecks([hillside, bridge], ground, (p) => p[0] === 70);
  assert.deepEqual(bridge.deck, [120, 120]);
  // without them it runs down to the ground at the tower
  const again: BridgeLine = { bridge: true, line: [[0, 0], [70, 0]] };
  setBridgeDecks([{ bridge: false, line: [[-20, 0], [0, 0]] }, again], ground);
  assert.deepEqual(again.deck, [120, 100]);
});

test("steps from a bridge down to the ground give the deck its height there, the deck rising to it and down again", () => {
  const ground = () => 100;
  const bridge: BridgeLine = { bridge: true, line: [[0, 0], [30, 0], [60, 0], [100, 0]] };
  // 32 steps down from the bridge at e 60 to the ground 20 m off: 32 * 0.16 = 5.12 m
  const steps: BridgeLine = { bridge: false, line: [[60, 0], [60, 20]], stepCount: 32, incline: "down" };
  setBridgeDecks([bridge, steps], ground);
  const at = (e: number) => Math.round(deckAt(bridge.line, bridge.deck ?? [], [e, 0]) * 100) / 100;
  // straight up to the crest's curve (e 40 .. 80 here), which rounds it a little under the steps' height
  assert.deepEqual([at(0), at(30), at(100)], [100, 102.56, 100]);
  assert.ok(at(60) > 105.12 - 1.1 && at(60) < 105.12);
});

test("steps drawn up to a bridge count the same, and a height under the line through the others does not bend the deck down", () => {
  const ground = (e: number) => (e >= 100 ? 110 : 100);
  const bridge: BridgeLine = { bridge: true, line: [[0, 0], [50, 0], [100, 0]] };
  // up 12 steps from the ground at 100 m to the bridge's middle: 101.92, under the straight line's 105
  const steps: BridgeLine = { bridge: false, line: [[50, 20], [50, 0]], stepCount: 12, incline: "up" };
  setBridgeDecks([bridge, steps], ground);
  assert.deepEqual(bridge.deck, [100, 105, 110]);
});

test("steps without a count or a way they climb give no height", () => {
  const bridge: BridgeLine = { bridge: true, line: [[0, 0], [50, 0], [100, 0]] };
  const counted: BridgeLine = { bridge: false, line: [[50, 0], [50, 20]], incline: "down" };
  const unsure: BridgeLine = { bridge: false, line: [[50, 0], [50, -20]], stepCount: 30 };
  setBridgeDecks([bridge, counted, unsure], () => 100);
  assert.deepEqual(bridge.deck, [100, 100, 100]);
});

test("a deck's crest is rounded, so it bends no more than 0.2 m over 10 m either way, and stays near the steps' height", () => {
  const bridge: BridgeLine = { bridge: true, line: [[0, 0], [50, 0], [100, 0]] };
  // 10 steps down from the bridge's middle: 101.6 m, a change of grade of 6.4 % there
  const steps: BridgeLine = { bridge: false, line: [[50, 0], [50, 20]], stepCount: 10, incline: "down" };
  setBridgeDecks([bridge, steps], () => 100);
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
  const east: BridgeLine = { bridge: true, line: [[-45, 0], [0, 0]] };
  const through: BridgeLine = { bridge: false, line: [[0, 0], [12, 0]] };
  const west: BridgeLine = { bridge: true, line: [[12, 0], [30, 0]] };
  setBridgeDecks([east, through, west], ground, () => false, (l) => l === through);
  const at = (l: BridgeLine, e: number) => Math.round(deckAt(l.line, l.deck ?? [], [e, 0]) * 100) / 100;
  assert.deepEqual([at(east, -45), at(east, 0), at(through, 6), at(west, 30)], [89, 89.6, 89.68, 90]);
  // a way through a building not between bridges stays on the ground
  const alone: BridgeLine = { bridge: false, line: [[100, 0], [110, 0]] };
  setBridgeDecks([alone], ground, () => false, () => true);
  assert.equal(alone.deck, undefined);
});
