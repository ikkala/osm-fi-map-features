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

test("the ways on a bridge's outline get one straight deck, also at their free ends", () => {
  const { road, footway, ramp, beside } = ways();
  const { decks, ways: on } = setOutlineDecks([outline], [road, footway, ramp, beside]);
  assert.equal(on, 3);
  const at = (w: DeckLine, p: Point) => round(deckAt(w.line, w.deck ?? [], p));
  assert.deepEqual([at(footway, [0, 5]), at(footway, [5, 5]), at(footway, [50, 5]), at(footway, [100, 5])], [100, 100, 100, 100]);
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

test("the ways leading on from an outline's ways meet its deck: an approach's deck is tilted, a way on the ground gets a ramp", () => {
  const { road, footway } = ways();
  // the footway's ends were at 98, the ground there; the deck is at 100
  const west: DeckLine = { bridge: false, line: [[-40, 5], [0, 5]] };
  const east: DeckLine = { bridge: false, line: [[100, 5], [110, 5]], deck: [98, 98] };
  const lines = [road, footway, west, east];
  setOutlineDecks([outline], lines, () => 98, () => 0.08);
  // 2 m up at 8 %: a ramp 25 m long split off the way on the ground
  assert.equal(lines.length, 5);
  assert.deepEqual(west.line, [[-40, 5], [-25, 5]]);
  assert.equal(west.deck, undefined);
  const ramp = lines[4];
  assert.equal(ramp.line[0][0], -25);
  assert.equal(ramp.line[ramp.line.length - 1][0], 0);
  assert.deepEqual([ramp.deck?.[0], ramp.deck?.[ramp.line.length - 1]], [98, 100]);
  // the approach goes from the deck down to where it ended
  assert.deepEqual(east.deck, [100, 98]);
});

test("a way on the ground higher than the deck it meets goes down to it in a cut", () => {
  const { road, footway } = ways();
  const west: DeckLine = { bridge: false, line: [[-40, 5], [0, 5]] };
  const lines = [road, footway, west];
  setOutlineDecks([outline], lines, (e) => (e <= 0 ? 101 : 98), () => 0.08);
  const ramp = lines[3];
  assert.equal(ramp.deck, undefined);
  assert.equal(ramp.line[0][0], -12.5);
  assert.deepEqual([ramp.floor?.[0], ramp.floor?.[ramp.line.length - 1]], [101, 100]);
});

test("a way on an outline reaching on past it goes from the deck at the outline's edge to its own end", () => {
  const { road } = ways();
  // reaching 29 m past the outline's east edge, down to 94 at its end
  const long: DeckLine = { bridge: true, line: [[0, -5], [130, -5]], deck: [100, 94] };
  setOutlineDecks([outline], [road, long]);
  const at = (p: Point) => round(deckAt(long.line, long.deck ?? [], p));
  assert.equal(at([50, -5]), 100);
  assert.equal(at([130, -5]), 94);
  // straight from the last point inside to the end
  assert.ok(Math.abs(at([115, -5]) - (100 + (94 - 100) * (115 - 100) / 30)) < 0.05);
});

test("a way on the ground in a hollow at the deck's end ramps up to it, even where the ground beyond is higher", () => {
  const { road, footway } = ways();
  const west: DeckLine = { bridge: false, line: [[-40, 5], [0, 5]] };
  const lines = [road, footway, west];
  // 98 at the bridge's end, rising to 101 beyond
  setOutlineDecks([outline], lines, (e) => (e >= -10 ? 98 : 101), () => 0.08);
  const ramp = lines[3];
  assert.equal(ramp.floor, undefined);
  assert.deepEqual([ramp.deck?.[0], ramp.deck?.[ramp.line.length - 1]], [101, 100]);
});

test("a ramp that would cross another way on the ground is not made", () => {
  const { road, footway } = ways();
  const west: DeckLine = { bridge: false, line: [[-40, 5], [0, 5]] };
  // a railway across where the ramp would be
  const rails: DeckLine = { bridge: false, line: [[-10, -20], [-10, 20]] };
  const lines = [road, footway, west, rails];
  setOutlineDecks([outline], lines, () => 98, () => 0.08);
  assert.equal(lines.length, 4);
  assert.equal(west.deck, undefined);
  assert.deepEqual(west.line, [[-40, 5], [0, 5]]);
});

test("a way on the ground ending on a ramp meets it in turn", () => {
  const { road, footway } = ways();
  const west: DeckLine = { bridge: false, line: [[-40, 5], [-5, 5], [0, 5]] };
  // stairs down from the ramp 5 m from the bridge's end
  const stairs: DeckLine = { bridge: false, line: [[-5, 5], [-5, 9]] };
  const lines = [road, footway, west, stairs];
  setOutlineDecks([outline], lines, () => 98, () => 0.08);
  // the ramp is at 100 - 2 * 5 / 25 = 99.6 there; the stairs go down from it to the ground at their other end
  assert.ok(stairs.deck);
  assert.ok(Math.abs(stairs.deck[0] - 99.6) < 0.01);
  assert.equal(stairs.deck[stairs.deck.length - 1], 98);
});

test("a way on a sloping outline reaching a little past it goes on at the same slope", () => {
  const road: DeckLine = { bridge: true, line: [[0, 0], [100, 0]], deck: [100, 110] };
  const footway: DeckLine = { bridge: true, line: [[0, 5], [104, 5]], deck: [100, 110.4] };
  setOutlineDecks([outline], [road, footway]);
  const at = (x: number) => deckAt(footway.line, footway.deck ?? [], [x, 5]);
  assert.ok(Math.abs((at(104) - at(100)) / 4 - (at(100) - at(50)) / 50) < 0.001);
});

test("an outline's deck keeps a crest its ways' decks have, bending one way only, rounded as a bridge's", () => {
  const crest: DeckLine = { bridge: true, line: [[0, 0], [50, 0], [100, 0]], deck: [100, 104, 100] };
  // a footway beside it with a dip, which the deck does not follow
  const dip: DeckLine = { bridge: true, line: [[0, 5], [50, 5], [100, 5]], deck: [100, 99, 100] };
  setOutlineDecks([outline], [crest, dip]);
  const at = (w: DeckLine, p: Point) => deckAt(w.line, w.deck ?? [], p);
  // the grade turns from 8 % up to 8 % down over a curve as long as the stretches beside it allow (50 m), so the
  // crest is 1 m under where the straight stretches meet
  assert.ok(Math.abs(at(crest, [50, 0]) - 103) < 0.1, `${at(crest, [50, 0])}`);
  assert.ok(Math.abs(at(dip, [50, 5]) - 103) < 0.1);
  assert.ok(Math.abs(at(dip, [25, 5]) - 102) < 0.1);
  // and bends evenly: 10 m either side of the crest it is 0.2 m off the line between, not 0.8 m
  const bend = at(crest, [50, 0]) - (at(crest, [40, 0]) + at(crest, [60, 0])) / 2;
  assert.ok(bend < 0.25, `bends ${bend} m`);
});

test("a way reaching a little past an outline where its ways end at different heights goes on at the deck's slope, not plunging", () => {
  const road: DeckLine = { bridge: true, line: [[0, 0], [100, 0]], deck: [100, 100] };
  // a track ending half a meter on, a meter lower, and one reaching 3 m past the outline
  const low: DeckLine = { bridge: true, line: [[0, 8], [100.5, 8]], deck: [100, 99] };
  const past: DeckLine = { bridge: true, line: [[0, -5], [104, -5]], deck: [100, 100] };
  setOutlineDecks([outline], [road, low, past]);
  const at = (p: Point) => deckAt(past.line, past.deck ?? [], p);
  assert.ok(Math.abs(at([104, -5]) - 100) < 0.2, `at the end ${at([104, -5])}`);
});

test("an outline wider than long (a wide road over a narrow one) has its deck along its ways, not across them", () => {
  // 60 m across, 36 m along the two carriageways, which rise 1.2 m over it
  const wide: BridgeOutline = { osm: "w2", polygon: { outer: [[-30, -1], [30, -1], [30, 35], [-30, 35]], holes: [] } };
  const west: DeckLine = { bridge: true, line: [[-8, 0], [-8, 34]], deck: [100, 101.2] };
  const east: DeckLine = { bridge: true, line: [[8, 0], [8, 34]], deck: [100, 101.2] };
  setOutlineDecks([wide], [west, east]);
  // (the highest deck within 2 m of an end is the deck's height there, a little over the lower end's)
  const near = (w: DeckLine, p: Point, h: number) => assert.ok(Math.abs(deckAt(w.line, w.deck ?? [], p) - h) < 0.1, `${deckAt(w.line, w.deck ?? [], p)} at ${p}, not ${h}`);
  near(west, [-8, 0], 100);
  near(west, [-8, 17], 100.6);
  near(west, [-8, 34], 101.2);
  near(east, [8, 0], 100);
  near(east, [8, 34], 101.2);
});

test("an outline whose ways run many ways (a junction on a bridge) has its deck along its longer side", () => {
  // 60 m along e, 50 m across; a way along it rising 3 m, and two longer ones across it, level at its heights there
  const junction: BridgeOutline = { osm: "w3", polygon: { outer: [[-1, -25], [61, -25], [61, 25], [-1, 25]], holes: [] } };
  const along: DeckLine = { bridge: true, line: [[0, 0], [50, 0]], deck: [100, 103] };
  const west: DeckLine = { bridge: true, line: [[15, -24], [15, 24]], deck: [100.9, 100.9] };
  const east: DeckLine = { bridge: true, line: [[45, -24], [45, 24]], deck: [102.7, 102.7] };
  setOutlineDecks([junction], [along, west, east]);
  const near = (w: DeckLine, p: Point, h: number) => assert.ok(Math.abs(deckAt(w.line, w.deck ?? [], p) - h) < 0.15, `${deckAt(w.line, w.deck ?? [], p)} at ${p}, not ${h}`);
  near(along, [0, 0], 100);
  near(along, [25, 0], 101.5);
  near(along, [50, 0], 103);
});
