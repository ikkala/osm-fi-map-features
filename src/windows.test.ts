import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point } from "./geometry.ts";
import { isSpecial, type Building } from "./osm.ts";
import { assignWindows } from "./windows.ts";

function square(x: number, size: number, extra: Partial<Building> = {}): Building {
  const outer: Point[] = [[x, 0], [x + size, 0], [x + size, size], [x, size]];
  return { osm: `w${x}`, kind: "yes", part: false, hasParts: false, height: 9, minHeight: 0, polygon: { outer, holes: [] }, ...extra };
}

test("assignWindows goes by kind, and for building=yes by the register's use", () => {
  const flats = square(0, 10, { kind: "apartments" });
  const church = square(20, 10, { kind: "church", use: "apartments" });
  const registered = square(40, 10, { use: "house" });
  const unknown = square(60, 10);
  // offices and factories alike: offices when tall
  const hall = square(80, 10, { use: "work", levels: 2 });
  const offices = square(140, 10, { use: "work", levels: 5 });
  const glass = square(100, 10, { kind: "office", material: "glass" });
  const shelter = square(120, 10, { kind: "roof", shelter: "roof" });
  assert.equal(assignWindows([flats, church, registered, unknown, hall, glass, shelter, offices]), 3);
  assert.equal(offices.windows, "office");
  assert.equal(flats.windows, "apartments");
  // the OSM kind wins over the register
  assert.equal(church.windows, undefined);
  assert.equal(registered.windows, "house");
  assert.deepEqual([unknown, hall, glass, shelter].map((b) => b.windows), [undefined, undefined, undefined, undefined]);
});

test("assignWindows gives parts of unknown kind the windows of their outline", () => {
  const outline = square(0, 20, { kind: "office", hasParts: true });
  const part = square(2, 5, { part: true });
  const tower = square(10, 5, { part: true, kind: "tower" });
  const outside = square(40, 5, { part: true });
  assert.equal(assignWindows([outline, part, tower, outside]), 1);
  assert.equal(outline.windows, undefined);
  assert.equal(part.windows, "office");
  assert.equal(tower.windows, undefined);
  assert.equal(outside.windows, undefined);
});

test("assignWindows leaves out special buildings, the parts in them and slender ones", () => {
  // an observation tower with a restaurant in the register, drawn by its parts
  const tower = square(0, 20, { hasParts: true, special: true, use: "public" });
  const shaft = square(5, 10, { part: true, height: 130, use: "public" });
  const pod = square(2, 16, { part: true, height: 128, minHeight: 120 });
  const chimney = square(40, 4, { kind: "apartments", height: 30 });
  const block = square(60, 12, { kind: "apartments", height: 45 });
  // an ordinary building's parts may be slender: a bay or a stairwell
  const flats = square(100, 30, { kind: "apartments", hasParts: true });
  const bay = square(102, 3, { part: true, height: 24 });
  assert.equal(assignWindows([tower, shaft, pod, chimney, block, flats, bay]), 2);
  assert.deepEqual([shaft.windows, pod.windows, chimney.windows], [undefined, undefined, undefined]);
  assert.equal(block.windows, "apartments");
  assert.equal(bay.windows, "apartments");
});

test("isSpecial knows towers, churches and sights by their tags", () => {
  assert.equal(isSpecial({ building: "yes", man_made: "tower", "tower:type": "observation" }), true);
  assert.equal(isSpecial({ building: "yes", amenity: "place_of_worship" }), true);
  assert.equal(isSpecial({ building: "yes", historic: "castle" }), true);
  assert.equal(isSpecial({ building: "apartments", historic: "building" }), false);
  assert.equal(isSpecial({ building: "yes", tourism: "hotel" }), false);
});
