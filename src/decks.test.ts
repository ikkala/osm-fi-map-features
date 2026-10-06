import assert from "node:assert/strict";
import { test } from "node:test";
import { deckAt } from "./bridges.ts";
import { setOutlineDecks, standOnDecks, type DeckLine } from "./decks.ts";
import type { Point } from "./geometry.ts";
import type { BridgeDeck, BridgeOutline } from "./osm.ts";

// a bridge 102 m long and 20 m wide along e
const outline: BridgeOutline = { osm: "w1", name: "Silta", polygon: { outer: [[-1, -10], [101, -10], [101, 10], [-1, 10]], holes: [] } };

function ways(): { road: DeckLine; footway: DeckLine; ramp: DeckLine; beside: DeckLine } {
  return {
    // the road's deck from its ends' ground, and a footway beside it whose ends are lower
    road: { bridge: true, line: [[0, 0], [100, 0]], deck: [100, 100] },
    footway: { bridge: true, line: [[0, 5], [100, 5]], deck: [98, 98] },
    // a way from the road's middle and back, which took its ends' height from the river under it
    ramp: { bridge: true, line: [[30, 0], [50, -5], [70, 0]], deck: [90, 90, 90] },
    // a bridge off the outline
    beside: { bridge: true, line: [[0, 30], [100, 30]], deck: [80, 80] },
  };
}

const round = (h: number) => Math.round(h * 100) / 100;

test("the ways on a bridge's outline get one deck, keeping their own at their free ends", () => {
  const { road, footway, ramp, beside } = ways();
  const { decks, ways: on } = setOutlineDecks([outline], [road, footway, ramp, beside]);
  assert.equal(on, 3);
  const at = (w: DeckLine, p: Point) => round(deckAt(w.line, w.deck ?? [], p));
  assert.deepEqual([at(footway, [0, 5]), at(footway, [5, 5]), at(footway, [50, 5]), at(footway, [100, 5])], [98, 98.67, 100, 98]);
  assert.deepEqual([at(ramp, [30, 0]), at(ramp, [50, -5])], [100, 100]);
  assert.deepEqual([at(road, [0, 0]), at(road, [50, 0])], [100, 100]);
  assert.deepEqual(beside.deck, [80, 80]);
  // the ways get points every 5 m
  assert.equal(footway.line.length, 21);
  assert.ok(decks.length > 0);
});

/** The triangles of deck pieces, as corners */
function triangles(decks: BridgeDeck[]): [Point, Point, Point][] {
  return decks.flatMap((deck) => {
    const result: [Point, Point, Point][] = [];
    for (let i = 0; i + 2 < deck.triangles.length; i += 3) {
      result.push([deck.vertices[deck.triangles[i]], deck.vertices[deck.triangles[i + 1]], deck.vertices[deck.triangles[i + 2]]]);
    }
    return result;
  });
}

const area = ([a, b, c]: [Point, Point, Point]) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;

test("an outline is cut across the bridge into pieces of triangles with the deck's height at their corners", () => {
  const { road, footway, ramp } = ways();
  const { decks } = setOutlineDecks([outline], [road, footway, ramp]);
  assert.equal(decks.length, 26);
  assert.equal(Math.round(triangles(decks).reduce((sum, t) => sum + area(t), 0)), 102 * 20);
  for (const deck of decks) {
    assert.equal(deck.osm, "w1");
    assert.equal(deck.name, "Silta");
    assert.equal(deck.heights.length, deck.vertices.length);
  }
  // no piece is longer than 4 m
  for (const deck of decks) {
    const es = deck.vertices.map(([e]) => e);
    assert.ok(Math.max(...es) - Math.min(...es) <= 4 + 1e-9);
  }
  // the middle of the bridge is at the road's deck, all the way across
  const middle = decks.flatMap((d) => d.heights.filter((_, i) => d.vertices[i][0] > 40 && d.vertices[i][0] < 60));
  assert.ok(middle.length > 0 && middle.every((h) => round(h) === 100));
});

test("an outline with no bridge way with a deck on it gets no deck", () => {
  const road: DeckLine = { bridge: false, line: [[0, 0], [100, 0]] };
  assert.deepEqual(setOutlineDecks([outline], [road]), { decks: [], ways: 0 });
});

test("trees and lamps on a deck stand on it; lamps on a way's deck already keep theirs", () => {
  const { road, footway } = ways();
  const { decks } = setOutlineDecks([outline], [road, footway]);
  const trees: { point: Point; base?: number }[] = [{ point: [50, 8] }, { point: [50, 20] }];
  const lamps: { point: Point; base?: number }[] = [{ point: [50, -8] }, { point: [60, 0], base: 101 }];
  assert.deepEqual(standOnDecks(decks, trees, lamps), { trees: 1, lamps: 1 });
  assert.deepEqual(trees.map((t) => t.base && round(t.base)), [100, undefined]);
  assert.deepEqual(lamps.map((l) => l.base && round(l.base)), [100, 101]);
});

test("an outline with a notch (two decks side by side) gets no triangles over the gap", () => {
  // two decks 9.5 m wide with a gap of 1 m between them, joined at e = 0 .. 10
  const notched: BridgeOutline = {
    osm: "r2",
    polygon: { outer: [[0, -10], [100, -10], [100, -0.5], [10, -0.5], [10, 0.5], [100, 0.5], [100, 10], [0, 10]], holes: [] },
  };
  const south: DeckLine = { bridge: true, line: [[0, -6], [100, -6]], deck: [100, 100] };
  const north: DeckLine = { bridge: true, line: [[0, 6], [100, 6]], deck: [100, 100] };
  const { decks } = setOutlineDecks([notched], [south, north]);
  for (const [a, b, c] of triangles(decks)) {
    const centroid: Point = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
    assert.ok(centroid[0] < 10 || Math.abs(centroid[1]) > 0.5, `a triangle over the gap at ${centroid.join(", ")}`);
  }
  // the decks are covered whole, and the gap not at all
  assert.equal(Math.round(triangles(decks).reduce((sum, t) => sum + area(t), 0)), 100 * 20 - 90 * 1);
});

test("an outline with a hole gets no triangles over the hole", () => {
  const holed: BridgeOutline = {
    osm: "r3",
    polygon: { outer: [[0, -10], [100, -10], [100, 10], [0, 10]], holes: [[[40, -3], [40, 3], [60, 3], [60, -3]]] },
  };
  const road: DeckLine = { bridge: true, line: [[0, -6], [100, -6]], deck: [100, 100] };
  const { decks } = setOutlineDecks([holed], [road]);
  for (const [a, b, c] of triangles(decks)) {
    const [e, n] = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
    assert.ok(!(e > 40 && e < 60 && n > -3 && n < 3), `a triangle over the hole at ${e}, ${n}`);
  }
  assert.equal(Math.round(triangles(decks).reduce((sum, t) => sum + area(t), 0)), 100 * 20 - 20 * 6);
});

test("an outline's deck is straight from its ends' highest decks, not bent where the ways' decks cross", () => {
  // a road level at 100 and a cycleway rising from 98 to 102 across the same outline
  const square: Point[] = [[0, -10], [100, -10], [100, 10], [0, 10]];
  const level: DeckLine = { bridge: true, line: [[0, 0], [100, 0]], deck: [100, 100] };
  const rising: DeckLine = { bridge: true, line: [[0, 5], [100, 5]], deck: [98, 102] };
  setOutlineDecks([{ osm: "w9", polygon: { outer: square, holes: [] } }], [level, rising]);
  // in the middle, away from the free ends: halfway between 100 and 102 (sampled inside the outline, a meter in)
  assert.ok(Math.abs(deckAt(level.line, level.deck ?? [], [50, 0]) - 101) < 0.05);
});
