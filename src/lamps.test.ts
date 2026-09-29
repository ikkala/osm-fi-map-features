import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point } from "./geometry.ts";
import { placeLamps } from "./lamps.ts";
import type { Road, StreetLamp } from "./osm.ts";

function road(osm: string, kind: string, line: Point[], extra: Partial<Road> = {}): Road {
  return { osm, kind, width: 8, layer: 0, bridge: false, tunnel: false, line, ...extra };
}

function lamp(point: Point, extra: Partial<StreetLamp> = {}): StreetLamp {
  return { point, height: 5, heightEstimated: true, ...extra };
}

test("a lamp next to a street faces it and is as tall as the street's lamps, even with a sidewalk nearer", () => {
  const roads = [road("w1", "residential", [[0, 0], [100, 0]]), road("w2", "footway", [[0, 4], [100, 4]]), road("w3", "primary", [[0, 100], [100, 100]])];
  const lamps = [lamp([50, 6]), lamp([50, 94], { mount: "angled" })];
  assert.deepEqual(placeLamps(lamps, roads), { facing: 2, heights: 2, onDecks: 0 });
  assert.deepEqual(lamps.map((l) => [l.toward, l.height]), [[270, 8], [90, 10]]);
});

test("a lamp with only a path next to it is a low lamp facing the path, and a lamp far from any way faces nowhere", () => {
  const roads = [road("w1", "cycleway", [[0, 0], [0, 100]]), road("w2", "residential", [[200, 0], [200, 100]])];
  const lamps = [lamp([2, 50], { height: 8 }), lamp([100, 50])];
  assert.deepEqual(placeLamps(lamps, roads), { facing: 1, heights: 2, onDecks: 0 });
  assert.deepEqual(lamps.map((l) => [l.toward, l.height]), [[180, 5], [undefined, 5]]);
});

test("OSM's height and direction, and the height of a high mast, are kept", () => {
  const roads = [road("w1", "residential", [[0, 0], [100, 0]])];
  const lamps = [lamp([10, 5], { height: 6, heightEstimated: undefined, toward: 45 }), lamp([20, 5], { mount: "high", height: 20 })];
  assert.deepEqual(placeLamps(lamps, roads), { facing: 1, heights: 0, onDecks: 0 });
  assert.deepEqual(lamps.map((l) => [l.toward, l.height]), [[45, 6], [270, 20]]);
});

test("a lamp on a bridge stands on its deck, and tunnels are left out", () => {
  const bridge = road("w1", "tertiary", [[0, 0], [100, 0]], { bridge: true, layer: 1, deck: [100, 110] });
  const tunnel = road("w2", "primary", [[0, 20], [100, 20]], { tunnel: true, layer: -1 });
  const lamps = [lamp([50, 4.5]), lamp([50, 20])];
  assert.deepEqual(placeLamps(lamps, [bridge, tunnel]), { facing: 1, heights: 2, onDecks: 1 });
  assert.equal(lamps[0].base, 105);
  // the tunnel's street is not next to the lamp over it
  assert.deepEqual([lamps[1].toward, lamps[1].height, lamps[1].base], [undefined, 5, undefined]);
});
