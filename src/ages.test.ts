import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point } from "./geometry.ts";
import { inheritFromOutlines, type Building } from "./osm.ts";
import { applyAges, storeyHeight } from "./ages.ts";

function square(x: number, size: number, extra: Partial<Building> = {}): Building {
  const outer: Point[] = [[x, 0], [x + size, 0], [x + size, size], [x, size]];
  return { osm: `w${x}`, kind: "yes", part: false, hasParts: false, height: 9, minHeight: 0, polygon: { outer, holes: [] }, ...extra };
}

test("storeyHeight is taller before the Second World War", () => {
  assert.deepEqual([1867, 1919, 1920, 1945, 1946, 2020, undefined].map(storeyHeight), [3.6, 3.6, 3.2, 3.2, 3, 3, 3]);
});

test("applyAges makes old storeys taller, under the roof, but not a part's", () => {
  // two storeys and a 3 m roof
  const old = square(0, 10, { height: 9, roofHeight: 3, heightFromLevels: true, year: 1867 });
  const tagged = square(20, 10, { height: 9, year: 1867 });
  const modern = square(40, 10, { height: 9, heightFromLevels: true, year: 1975 });
  const outline = square(60, 20, { hasParts: true, year: 1930 });
  const part = square(62, 5, { part: true, height: 6, heightFromLevels: true, year: 1930 });
  assert.equal(applyAges([old, tagged, modern, outline, part]), 1);
  assert.equal(old.height.toFixed(2), (3 + 2 * 3.6).toFixed(2));
  assert.equal(old.heightFromLevels, undefined);
  assert.deepEqual([tagged.height, modern.height], [9, 9]);
  // parts keep their storeys, so that they meet
  assert.equal(part.height, 6);
});

test("inheritFromOutlines gives parts their outline's material, colour and year, unless they have their own", () => {
  const outline = square(0, 40, { hasParts: true, material: "brick", colour: "#aa5544", year: 1953 });
  const tower = square(2, 5, { part: true });
  const own = square(20, 5, { part: true, material: "concrete", year: 1990 });
  const outside = square(100, 5, { part: true });
  assert.equal(inheritFromOutlines([outline, tower, own, outside]), 2);
  assert.deepEqual([tower.material, tower.colour, tower.year], ["brick", "#aa5544", 1953]);
  assert.deepEqual([own.material, own.colour, own.year], ["concrete", "#aa5544", 1990]);
  assert.deepEqual([outside.material, outside.year], [undefined, undefined]);
});
