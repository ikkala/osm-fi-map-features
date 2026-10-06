import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point } from "./geometry.ts";
import type { Area } from "./osm.ts";
import type { Tile } from "./tiles.ts";
import { cutWaterways, nonIncreasing, parseWaterways, setWaterLevels, type WaterwayLine } from "./waterways.ts";

const origin = { latitude: 61.5, longitude: 23.76 };

function water(osm: string, outer: Point[], flowing = false): Area {
  return { osm, kind: "water", ...(flowing && { flowing }), polygon: { outer, holes: [] } };
}

function line(osm: string, points: Point[], extra: Partial<WaterwayLine> = {}): WaterwayLine {
  return { osm, kind: "river", tunnel: false, line: points, ...extra };
}

const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

test("waterway lines are read the way they are drawn; areas tagged as waterways, and culverts, are told apart", () => {
  const way = (id: number, tags: Record<string, string>, coords: [number, number][]) => ({
    type: "way" as const,
    id,
    tags,
    geometry: coords.map(([lat, lon]) => ({ lat, lon })),
  });
  const lines = parseWaterways(
    [
      way(1, { waterway: "river", name: "Koski" }, [[61.5, 23.76], [61.499, 23.76]]),
      way(2, { waterway: "stream", tunnel: "culvert" }, [[61.5, 23.761], [61.5, 23.762]]),
      // an area with waterway=river on it, and a closed way
      way(3, { waterway: "river", natural: "water" }, [[61.5, 23.76], [61.501, 23.76], [61.501, 23.761]]),
      way(4, { waterway: "canal" }, [[61.5, 23.76], [61.501, 23.76], [61.5, 23.76]]),
      way(5, { waterway: "ditch" }, [[61.5, 23.76], [61.501, 23.76]]),
    ],
    origin,
  );
  assert.deepEqual(lines.map((l) => [l.osm, l.kind, l.name, l.tunnel]), [["w1", "river", "Koski", false], ["w2", "stream", undefined, true]]);
  // drawn southward: the first point north of the last
  assert.ok(lines[0].line[0][1] > lines[0].line[1][1]);
});

test("a run that would rise downstream is pooled at its median, so a few high points do not lift the water", () => {
  assert.deepEqual(nonIncreasing([3, 2, 2.5, 1]), [3, 2, 2, 1]);
  assert.deepEqual(nonIncreasing([1, 2, 3]), [2, 2, 2]);
  assert.deepEqual(nonIncreasing([5, 5, 9, 5, 4]), [5, 5, 5, 5, 4]);
});

test("a still water is set level at its median surface, its banks inside it as well", () => {
  // a pond at 100 m whose outline takes in a bank 2 m high along its north side
  const pond = water("w1", rect(0, 0, 50, 50));
  const levels = setWaterLevels([pond], [], (_e, n) => (n > 45 ? 102 : 100));
  assert.equal(levels.still, 1);
  assert.equal(levels.levelAt([25, 48]), 100);
  assert.equal(levels.levelAt([25, 10]), 100);
  assert.equal(levels.levelAt([25, 60]), undefined);
});

test("a still water on a slope, the middle half of its surface spreading over 0.5 m, is left as the elevation model has it", () => {
  const sloping = water("w1", rect(0, 0, 50, 50));
  const levels = setWaterLevels([sloping], [], (e) => 100 - e / 10);
  assert.equal(levels.uneven, 1);
  assert.equal(levels.levelAt([25, 25]), undefined);
});

test("a flowing water falls along its waterway, level across it, and the waterway knows how wide it is", () => {
  // a river 20 m wide flowing east, falling 1 m in 100 m, with a 3 m bank inside its south edge
  const river = water("w1", rect(0, -10, 100, 10), true);
  const heightAt = (e: number, n: number) => (n < -8 ? 103 : 100 - e / 100);
  const levels = setWaterLevels([river], [line("w2", [[-20, 0], [120, 0]])], heightAt);
  assert.equal(levels.flowing, 1);
  for (const e of [10, 50, 90]) {
    const level = levels.levelAt([e, -9]);
    assert.ok(level !== undefined && Math.abs(level - (100 - e / 100)) < 0.03, `at ${e}: ${level}`);
  }
  // only the stretch in the water
  assert.equal(levels.waterways.length, 1);
  const [stretch] = levels.waterways;
  assert.ok(stretch.line[0][0] >= 0 && stretch.line[stretch.line.length - 1][0] <= 100);
  assert.ok(stretch.levels[0] > stretch.levels[stretch.levels.length - 1]);
  assert.ok(stretch.widths.every((w) => w === 20), stretch.widths.join(" "));
  // straight, falling evenly: its ends are enough
  assert.equal(stretch.line.length, 2);
});

test("a waterway flowing from a still water starts at its level, and one joining downstream does not rise above it", () => {
  const lake = water("w1", rect(-100, -50, 0, 50));
  const river = water("w2", rect(0, -10, 200, 10), true);
  // the elevation model rises at the river's mouth into the second line: a dam's crest
  const heightAt = (e: number) => (e < 0 ? 100 : e > 100 && e < 106 ? 104 : 99.5);
  const upper = line("w10", [[-50, 0], [100, 0]]);
  const lower = line("w11", [[100, 0], [190, 0]]);
  const levels = setWaterLevels([lake, river], [upper, lower], heightAt);
  const at = (osm: string) => levels.waterways.find((w) => w.osm === osm);
  assert.equal(at("w10")?.levels[0], 100);
  assert.ok((at("w11")?.levels ?? []).every((l) => l <= 99.5), at("w11")?.levels.join(" "));
  assert.equal(levels.levelAt([-50, 40]), 100);
});

test("waterways joined at a point share a network, the lowest id; streams have their own", () => {
  const river = water("w1", rect(0, -10, 300, 10), true);
  const lines = [
    line("w30", [[0, 0], [100, 0]]),
    line("w20", [[100, 0], [150, 0]], { tunnel: true }),
    line("w40", [[150, 0], [300, 0]]),
    line("w10", [[100, 9], [100, 0]], { kind: "stream" }),
  ];
  const levels = setWaterLevels([river], lines, () => 100);
  const network = (osm: string) => levels.waterways.find((w) => w.osm === osm)?.network;
  assert.equal(network("w30"), "w20");
  assert.equal(network("w40"), "w20");
  assert.equal(network("w10"), "w10");
  // the culvert has no water of its own
  assert.equal(levels.waterways.some((w) => w.osm === "w20"), false);
});

test("a waterway is cut at the tiles' edges, its levels and widths along it", () => {
  const tiles = new Map<string, Tile>(
    [0, 1].map((x) => [`${x}_0`, { x, y: 0, roads: [], rails: [], buildings: [], areas: [], trees: [], lamps: [], crossings: [], signals: [], gates: [], barriers: [], playEquipment: [], bridgeDecks: [] }]),
  );
  cutWaterways(tiles, [{ osm: "w1", kind: "river", network: "w1", line: [[50, 50], [150, 50]], levels: [100, 99], widths: [20, 30] }], 100);
  const [west] = tiles.get("0_0")?.waterways ?? [];
  const [east] = tiles.get("1_0")?.waterways ?? [];
  assert.deepEqual(west.line, [[50, 50], [100, 50]]);
  assert.deepEqual(west.levels, [100, 99.5]);
  assert.deepEqual(east.widths, [25, 30]);
});
