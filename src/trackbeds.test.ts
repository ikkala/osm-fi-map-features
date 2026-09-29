import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point } from "./geometry.ts";
import type { Rail } from "./osm.ts";
import { defined } from "./testing.ts";
import { setTrackBeds } from "./trackbeds.ts";

function rail(osm: string, line: Point[], extra: Partial<Rail> = {}): Rail {
  return { osm, kind: "rail", layer: 0, bridge: false, tunnel: false, line, ...extra };
}

// level ground at 100 with a metre up and down every 4 m between e = 100 and 200
const bumpy = (e: number) => (e > 100 && e < 200 ? 100 + (Math.floor(e / 4) % 2 === 0 ? 0.5 : -0.5) : 100);

test("a railway's bed smooths the bumps of the ground under it, and ends at the ground around its ends", () => {
  const track = rail("w1", [[0, 0], [300, 0]]);
  assert.equal(setTrackBeds([track], bumpy), 1);
  const bed = defined(track.bed);
  assert.equal(bed.length, track.line.length);
  assert.deepEqual([bed[0], bed[bed.length - 1]], [100, 100]);
  // over the bumps the bed stays within the averaged bumps (and at most 0.5 m under the ground)
  for (const h of bed) {
    assert.ok(Math.abs(h - 100) <= 0.1, `bed at ${h}`);
  }
});

test("lines meeting end to end share their height there, and a bed ends at a bridge's deck", () => {
  const a = rail("w1", [[0, 0], [150, 0]]);
  const b = rail("w2", [[150, 0], [300, 0]]);
  const bridge = rail("w3", [[300, 0], [340, 0]], { bridge: true, deck: [104, 104] });
  setTrackBeds([a, b, bridge], bumpy);
  assert.equal(defined(a.bed).at(-1), defined(b.bed)[0]);
  assert.equal(defined(b.bed).at(-1), 104);
  assert.deepEqual(bridge.bed, undefined);
});

test("trams, tunnels and bridges get no bed, and straight level stretches keep only their ends", () => {
  const tram = rail("w1", [[0, 0], [100, 0]], { kind: "tram" });
  const tunnel = rail("w2", [[0, 10], [100, 10]], { tunnel: true, layer: -1 });
  const level = rail("w3", [[0, 20], [100, 20]]);
  assert.equal(setTrackBeds([tram, tunnel, level], () => 100), 1);
  assert.deepEqual([tram.bed, tunnel.bed, level.bed, level.line.length], [undefined, undefined, [100, 100], 2]);
});
