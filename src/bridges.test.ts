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

test("the ground falling away from a bridge's end leaves the ways leading on as they are", () => {
  const road: BridgeLine = { bridge: false, line: [[0, 0], [10, 0]] };
  const bridge: BridgeLine = { bridge: true, line: [[10, 0], [20, 0], [30, 0]] };
  const lines = [road, bridge];
  setBridgeDecks(lines, heightAt);
  assert.equal(lines.length, 2);
  assert.equal(road.deck, undefined);
});

test("a deck never goes below the ground", () => {
  const hill = (e: number) => (e === 5 ? 120 : 100);
  const bridge: BridgeLine = { bridge: true, line: [[0, 0], [5, 0], [10, 0]] };
  setBridgeDecks([bridge], hill);
  assert.deepEqual(bridge.deck, [100, 120, 100]);
});

test("deckAt interpolates along the nearest segment", () => {
  const line: Point[] = [[0, 0], [10, 0], [10, 10]];
  const deck = [100, 110, 90];
  assert.equal(deckAt(line, deck, [5, 0]), 105);
  assert.equal(deckAt(line, deck, [10, 5]), 100);
  assert.equal(deckAt(line, deck, [0, 0]), 100);
});
