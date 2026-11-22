import assert from "node:assert/strict";
import { test } from "node:test";
import { DeckIndex, UNDER_SIDE_M } from "./deckIndex.ts";
import type { Point } from "./geometry.ts";
import type { BridgeDeck, Road } from "./osm.ts";
import { DECK_EDGE_M } from "./ways.ts";

function road(osm: string, line: Point[], extra: Partial<Road> = {}): Road {
  return { osm, kind: "residential", width: 6, layer: 0, bridge: false, tunnel: false, line, ...extra };
}

const square = (e: number): Point[] => [
  [e, -5],
  [e + 10, -5],
  [e + 10, 5],
  [e, 5],
];

test("a point is under a bridge within its way's width and edges, or in its outline with a bridge way in it", () => {
  const outlines = [square(50), square(100)].map((outer, i) => ({ osm: `w${9 + i}`, polygon: { outer, holes: [] } }));
  // the bridge reaches into the first outline; a street on the ground crosses the second
  const index = new DeckIndex([road("w1", [[-30, 0], [52, 0]], { layer: 1, bridge: true }), road("w2", [[-30, 20], [30, 20]]), road("w3", [[95, 0], [115, 0]])], outlines);
  const points: Point[] = [[0, 3.4], [0, -3.6], [0, 20], [58, 4], [45, 4], [105, 0]];
  assert.deepEqual(
    points.map((p) => index.under(p)),
    [true, false, false, true, false, false],
  );
});

test("the deck over a point is a bridge way's over its layer, as far as its edge and UNDER_SIDE_M past it", () => {
  const index = new DeckIndex([road("w1", [[-30, 0], [30, 0]], { layer: 1, bridge: true, deck: [100, 102] })]);
  assert.deepEqual(index.over([0, 0], 0), { deck: 101, osm: "w1" });
  assert.equal(index.over([0, 3 + DECK_EDGE_M + UNDER_SIDE_M - 0.01], 0)?.deck, 101);
  assert.equal(index.over([0, 3 + DECK_EDGE_M + UNDER_SIDE_M + 0.01], 0), undefined);
  assert.equal(index.over([0, 0], 1), undefined);
  // past the deck's ends a point is in front of it
  assert.equal(index.over([29.5, 0], 0)?.osm, "w1");
  assert.equal(index.over([30.5, 0], 0), undefined);
});

test("an outline's deck as built is over its points, the lower where a bridge way's is there too, and none where it leaves the outline open", () => {
  const outline = { osm: "w9", polygon: { outer: square(-5), holes: [] } };
  const built: BridgeDeck[] = [{ osm: "w9", vertices: square(-5).slice(0, 3), triangles: [0, 1, 2], heights: [99, 99, 99] }];
  const bridge = road("w1", [[-30, 0], [30, 0]], { layer: 1, bridge: true, deck: [100, 100] });
  const index = new DeckIndex([bridge], [outline], built);
  assert.deepEqual(index.over([4, -4], 0), { deck: 99, osm: "w9" });
  assert.deepEqual(index.built([4, -4]), { deck: 99, osm: "w9" });
  assert.equal(index.built([-4, 4]), undefined);
  // before the outline's deck is built, the nearest bridge way's in it
  assert.deepEqual(new DeckIndex([bridge], [outline]).over([0, 4.9], 0), { deck: 100, osm: "w1" });
});

test("the decks and lids near a point, each with its way's nearest segment and how far it is", () => {
  const index = new DeckIndex([
    road("w1", [[-30, 0], [0, 0], [30, 10]], { layer: 1, bridge: true, deck: [100, 100, 101] }),
    road("w2", [[-30, 40], [30, 40]], { layer: -1, tunnel: true, lid: [95, 95] }),
    road("w3", [[-30, 80], [30, 80]], { deck: [99, 99] }),
  ]);
  assert.deepEqual(
    index.coversNear([20, 9], 1.5).map(({ kind, segment, distance }) => [kind, segment, Math.round(distance * 10) / 10]),
    [["deck", 1, 2.2]],
  );
  assert.deepEqual(
    index.coversNear([0, 45], 1.5).map(({ kind, edge }) => [kind, edge]),
    [["lid", 2]],
  );
  assert.deepEqual(index.coversNear([0, 80], 1.5), []);
});
