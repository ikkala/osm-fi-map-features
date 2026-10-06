import assert from "node:assert/strict";
import { test } from "node:test";
import { cellRandom, mergeTrees, moveTreesOffWays, plantForests } from "./forests.ts";
import type { Point } from "./geometry.ts";
import type { Area, MapFeatures, Road, Tree } from "./osm.ts";

const EVERYWHERE = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };

const tree = (e: number, n: number, kind: Tree["kind"] = "broadleaved"): Tree => ({ point: [e, n], kind, height: 10 });

function square(e: number, n: number, size: number): Point[] {
  return [[e, n], [e + size, n], [e + size, n + size], [e, n + size]];
}

function wood(e: number, n: number, size: number, cover: Area["cover"] = "trees"): Area {
  return { osm: `w${e}`, kind: "forest", cover, polygon: { outer: square(e, n, size), holes: [] } };
}

function features(extra: Partial<MapFeatures>): MapFeatures {
  return { roads: [], rails: [], buildings: [], areas: [], trees: [], lamps: [], crossings: [], signals: [], gates: [], barriers: [], playEquipment: [], bridgeDecks: [], ...extra };
}

test("mergeTrees keeps OSM trees only away from register trees", () => {
  const merged = mergeTrees([tree(0, 0), tree(20, 0)], [tree(1, 1, "conifer"), tree(10, 0, "conifer")]);
  assert.deepEqual(merged.map((t) => t.point), [[0, 0], [20, 0], [10, 0]]);
});

test("cellRandom is the same for the same cell and spread over 0 .. 1", () => {
  assert.equal(cellRandom(3, -7, 1), cellRandom(3, -7, 1));
  const values = Array.from({ length: 1000 }, (_, k) => cellRandom(k % 40, Math.floor(k / 40), 2));
  assert.ok(values.every((v) => v >= 0 && v < 1));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05, `mean ${mean}`);
});

test("plantForests fills woods sparsely, the same way every time, only inside the area", () => {
  const first = features({ areas: [wood(0, 0, 90)] });
  const count = plantForests(first, EVERYWHERE);
  // one tree per 9 m cell at most, some cells empty
  assert.ok(count > 50 && count <= 100, `${count} trees`);
  assert.equal(first.trees.length, count);
  assert.ok(first.trees.every(({ point: [e, n] }) => e > 0 && e < 90 && n > 0 && n < 90));
  assert.ok(first.trees.every((t) => t.kind === "conifer" || t.genus === "betula"));
  const again = features({ areas: [wood(0, 0, 90)] });
  plantForests(again, EVERYWHERE);
  assert.deepEqual(again.trees, first.trees);
  // the same trees where the map ends in the middle of the wood
  const half = features({ areas: [wood(0, 0, 90)] });
  plantForests(half, { minX: 0, minY: 0, maxX: 45, maxY: 90 });
  const west = first.trees.filter((t) => t.point[0] < 45);
  assert.deepEqual(half.trees.filter((t) => t.point[0] < 45), west);
  assert.ok(half.trees.length < west.length + 12);
});

test("plantForests plants conifers alone in needleleaved woods and broadleaved trees alone in broadleaved ones, at mixed woods' places", () => {
  const planted = (leafType?: Area["leafType"]) => {
    const map = features({ areas: [{ ...wood(0, 0, 90), ...(leafType && { leafType }) }] });
    plantForests(map, EVERYWHERE);
    return map.trees;
  };
  const mixed = planted();
  const needleleaved = planted("needleleaved");
  const broadleaved = planted("broadleaved");
  assert.ok(needleleaved.every((t) => t.kind === "conifer"));
  assert.ok(broadleaved.every((t) => t.kind === "broadleaved"));
  assert.ok(broadleaved.some((t) => t.genus === "betula") && broadleaved.some((t) => t.genus === undefined));
  assert.deepEqual(needleleaved.map((t) => t.point), mixed.map((t) => t.point));
  assert.deepEqual(broadleaved.map((t) => t.point), mixed.map((t) => t.point));
});

test("plantForests keeps off roads, buildings, water and existing trees", () => {
  const road = { osm: "w1", kind: "residential", width: 6, layer: 0, bridge: false, tunnel: false, line: [[0, 45], [90, 45]] satisfies Point[] };
  const building = {
    osm: "w2",
    kind: "house",
    part: false,
    hasParts: false,
    height: 6,
    minHeight: 0,
    polygon: { outer: square(10, 10, 20), holes: [] },
  };
  const lake: Area = { osm: "w3", kind: "water", polygon: { outer: square(60, 60, 20), holes: [] } };
  const existing = tree(70, 20);
  const map = features({ roads: [road], buildings: [building], areas: [wood(0, 0, 90), lake], trees: [existing] });
  plantForests(map, EVERYWHERE);
  const planted = map.trees.slice(1);
  assert.ok(planted.length > 30);
  for (const { point: [e, n] } of planted) {
    assert.ok(Math.abs(n - 45) >= 4.5, `on the road at ${e}, ${n}`);
    assert.ok(!(e > 8 && e < 32 && n > 8 && n < 32), `in the building at ${e}, ${n}`);
    assert.ok(!(e > 60 && e < 80 && n > 60 && n < 80), `in the lake at ${e}, ${n}`);
    assert.ok(Math.hypot(e - 70, n - 20) >= 2.5, `on the tree at ${e}, ${n}`);
  }
});

test("plantForests keeps off a lake far larger than the area without covering all of it", () => {
  // hundreds of kilometres across: a grid over all of it would not fit in memory
  const lake: Area = { osm: "r1", kind: "water", polygon: { outer: square(45, -500_000, 1_000_000), holes: [] } };
  const map = features({ areas: [wood(0, 0, 90), lake] });
  plantForests(map, { minX: 0, minY: 0, maxX: 90, maxY: 90 });
  assert.ok(map.trees.length > 20);
  assert.ok(map.trees.every(({ point: [e] }) => e < 45), "a tree in the lake");
});

test("plantForests puts mostly shrubs in scrub, closer together", () => {
  const map = features({ areas: [wood(0, 0, 50, "shrubs")] });
  const count = plantForests(map, EVERYWHERE);
  assert.ok(count > 50, `${count} shrubs`);
  assert.ok(map.trees.filter((t) => t.kind === "shrub").length > count / 2);
  const park: Area = { osm: "w9", kind: "grass", polygon: { outer: square(0, 0, 50), holes: [] } };
  assert.equal(plantForests(features({ areas: [park] }), EVERYWHERE), 0);
});

test("moveTreesOffWays moves a tree standing on a way to beside it, and leaves out one with no room beside", () => {
  const path: Road = { osm: "w1", kind: "footway", width: 2, layer: 0, bridge: false, tunnel: false, line: [[0, 0], [20, 0]] };
  const tunnel: Road = { ...path, osm: "w2", tunnel: true, line: [[0, 10], [20, 10]] };
  const onPath: Tree = { point: [5, 0.4], kind: "broadleaved", height: 10 };
  const beside: Tree = { point: [5, 3], kind: "broadleaved", height: 10 };
  const overTunnel: Tree = { point: [5, 10], kind: "broadleaved", height: 10 };
  // between two paths 2.2 m apart there is no room
  const other: Road = { ...path, osm: "w3", line: [[0, -2.2], [20, -2.2]] };
  const squeezed: Tree = { point: [15, -0.8], kind: "broadleaved", height: 10 };
  const trees = moveTreesOffWays([onPath, beside, overTunnel, squeezed], [path, tunnel, other], []);
  assert.deepEqual(trees.map((t) => t.point), [[5, 1 + 0.5], [5, 3], [5, 10]]);
});
