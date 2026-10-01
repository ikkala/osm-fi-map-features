import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point } from "./geometry.ts";
import type { Building } from "./osm.ts";
import { applyAges, storeyHeight } from "./ages.ts";

function square(x: number, size: number, extra: Partial<Building> = {}): Building {
  const outer: Point[] = [[x, 0], [x + size, 0], [x + size, size], [x, size]];
  return { osm: `w${x}`, kind: "yes", part: false, hasParts: false, height: 9, minHeight: 0, polygon: { outer, holes: [] }, ...extra };
}

test("storeyHeight is taller before the Second World War", () => {
  assert.deepEqual([1867, 1919, 1920, 1945, 1946, 2020, undefined].map(storeyHeight), [3.6, 3.6, 3.2, 3.2, 3, 3, 3]);
});

test("applyAges makes old storeys taller, under the roof, and gives parts the year of their building", () => {
  // two storeys and a 3 m roof
  const old = square(0, 10, { height: 9, roofHeight: 3, heightFromLevels: true, year: 1867 });
  const tagged = square(20, 10, { height: 9, year: 1867 });
  const modern = square(40, 10, { height: 9, heightFromLevels: true, year: 1975 });
  const outline = square(60, 20, { hasParts: true, year: 1930 });
  const part = square(62, 5, { part: true, height: 6, heightFromLevels: true });
  const outside = square(100, 5, { part: true });
  assert.equal(applyAges([old, tagged, modern, outline, part, outside]), 1);
  assert.equal(old.height.toFixed(2), (3 + 2 * 3.6).toFixed(2));
  assert.equal(old.heightFromLevels, undefined);
  assert.deepEqual([tagged.height, modern.height], [9, 9]);
  // parts keep their storeys, so that they meet
  assert.deepEqual([part.year, part.height], [1930, 6]);
  assert.equal(outside.year, undefined);
});
