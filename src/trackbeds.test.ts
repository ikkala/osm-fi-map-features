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

test("tunnels and bridges get no bed, trams do, and straight level stretches keep only their ends", () => {
  const tram = rail("w1", [[0, 0], [100, 0]], { kind: "light_rail" });
  const tunnel = rail("w2", [[0, 10], [100, 10]], { tunnel: true, layer: -1 });
  const level = rail("w3", [[0, 20], [100, 20]]);
  assert.equal(setTrackBeds([tram, tunnel, level], () => 100), 2);
  assert.deepEqual([tram.bed, tunnel.bed, level.bed, level.line.length], [[100, 100], undefined, [100, 100], 2]);
});

/** How far the bed bends over SPAN_M before and after each point (m), at most */
function bendOf(rail: Rail, span = 10): number {
  const line = rail.line;
  const bed = defined(rail.bed);
  const along = [0];
  for (let i = 1; i < line.length; i++) {
    along.push(along[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
  }
  const at = (d: number) => {
    for (let i = 1; i < line.length; i++) {
      if (d <= along[i] || i === line.length - 1) {
        const t = along[i] > along[i - 1] ? (d - along[i - 1]) / (along[i] - along[i - 1]) : 0;
        return bed[i - 1] + (bed[i] - bed[i - 1]) * t;
      }
    }
    return bed[0];
  };
  let most = 0;
  for (let d = span; d <= along[along.length - 1] - span; d += 1) {
    most = Math.max(most, Math.abs(at(d) - (at(d - span) + at(d + span)) / 2));
  }
  return most;
}

test("tramways meeting end to end are smoothed as one line, not to the ground averaged around where they meet", () => {
  // level ground at 100, with a cut 10 m deep beside where they meet, as under a bridge's end
  const ground = (e: number, n: number) => (e > 40 && e < 60 && n < -2 ? 90 : 100);
  const a = rail("w1", [[0, 0], [50, 0]], { kind: "light_rail" });
  const b = rail("w2", [[100, 0], [50, 0]], { kind: "light_rail" });
  assert.equal(setTrackBeds([a, b], ground), 2);
  assert.equal(defined(a.bed).at(-1), defined(b.bed).at(-1));
  const meet = defined(defined(a.bed).at(-1));
  assert.ok(Math.abs(meet - 100) < 0.05, `meets at ${meet}`);
  // railways keep the ground averaged around the point
  const c = rail("w3", [[0, 0], [50, 0]]);
  const d = rail("w4", [[50, 0], [100, 0]]);
  setTrackBeds([c, d], ground);
  assert.ok(defined(defined(c.bed).at(-1)) < 98);
});

test("a tramway's bed rounds a change of grade to a vertical curve, under the ground over a crest", () => {
  // the ground climbing 6 m at 20 % and level beyond
  const ground = (e: number) => 100 + Math.min(6, Math.max(0, (e - 100) * 0.2));
  const tram = rail("w1", [[0, 0], [300, 0]], { kind: "light_rail" });
  setTrackBeds([tram], ground);
  // a 300 m curve bends 0.17 m over 10 m each way; the bed's points are kept within 0.02 m of it
  assert.ok(bendOf(tram) <= 0.2, `bends ${bendOf(tram)}`);
  const railway = rail("w2", [[0, 0], [300, 0]]);
  setTrackBeds([railway], ground);
  assert.ok(bendOf(railway) > 0.3);
});

test("a tramway's bed under a deck leaves a tram its room there, rounded down to it and up again", () => {
  const tram = rail("w1", [[0, 0], [200, 0]], { kind: "light_rail" });
  // a bridge across it at e = 100, 5 m wide
  const ceiling = ([e]: Point) => (Math.abs(e - 100) <= 2.5 ? 99 : undefined);
  setTrackBeds([tram], () => 100, ceiling);
  const line = tram.line;
  const bed = defined(tram.bed);
  for (let i = 1; i < line.length; i++) {
    // the bed is straight between its points: under the ceiling across the bridge
    for (const e of [97.5, 100, 102.5]) {
      if (line[i - 1][0] <= e && line[i][0] >= e) {
        const h = bed[i - 1] + ((bed[i] - bed[i - 1]) * (e - line[i - 1][0])) / (line[i][0] - line[i - 1][0]);
        assert.ok(h <= 99 + 1e-6, `${h} at ${e}`);
      }
    }
  }
  assert.ok(bendOf(tram) <= 0.2, `bends ${bendOf(tram)}`);
  assert.deepEqual([bed[0], bed[bed.length - 1]], [100, 100]);
});

test("a tramway branching off another's middle ends at that one's bed there", () => {
  const main = rail("w1", [[0, 0], [100, 0], [200, 0]], { kind: "light_rail" });
  const branch = rail("w2", [[100, 0], [150, 30]], { kind: "light_rail" });
  // a deck over the main line at the switch: its bed goes down there, the ground around stays
  const ceiling = ([e, n]: Point) => (Math.abs(e - 100) <= 3 && Math.abs(n) <= 2 ? 99 : undefined);
  setTrackBeds([main, branch], () => 100, ceiling);
  const i = main.line.findIndex(([e]) => e === 100);
  assert.ok(i >= 0);
  const at = defined(main.bed)[i];
  assert.ok(at <= 99 + 1e-6, `main at ${at}`);
  assert.ok(Math.abs(defined(branch.bed)[0] - at) < 0.05, `branch at ${defined(branch.bed)[0]}, main at ${at}`);
});

test("a deck too near a tramway's ends for its curves to pass under is left over it", () => {
  const tram = rail("w1", [[0, 0], [20, 0]], { kind: "light_rail" });
  setTrackBeds([tram], () => 100, ([e]) => (Math.abs(e - 10) <= 3 ? 97 : undefined));
  assert.ok(bendOf(tram, 5) <= 0.1, `bends ${bendOf(tram, 5)}`);
});

test("a point another way has stays in the line, a level crossing on a straight level stretch too", () => {
  const tram = rail("w1", [[0, 0], [37, 0], [100, 0]], { kind: "light_rail" });
  const plain = rail("w2", [[0, 10], [37, 10], [100, 10]], { kind: "light_rail" });
  setTrackBeds([tram, plain], () => 100, undefined, [[[37, 20], [37, 0]]]);
  assert.ok(tram.line.some(([e]) => e === 37));
  assert.equal(plain.line.length, 2);
});
