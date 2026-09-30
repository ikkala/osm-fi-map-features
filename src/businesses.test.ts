import assert from "node:assert/strict";
import { test } from "node:test";
import { businessQuery, lowestLevel, parseBusinesses, placeBusinesses } from "./businesses.ts";
import type { Point } from "./geometry.ts";
import type { Building, Business, Road } from "./osm.ts";
import { defined } from "./testing.ts";

function rectangle(osm: string, x: number, y: number, width: number, depth: number, extra: Partial<Building> = {}): Building {
  const outer: Point[] = [[x, y], [x + width, y], [x + width, y + depth], [x, y + depth]];
  return { osm, kind: "yes", part: false, hasParts: false, height: 9, minHeight: 0, polygon: { outer, holes: [] }, ...extra };
}

const shop = (osm: string, point: Point, extra: Partial<Business> = {}): Business => ({ osm, category: "shop", kind: "clothes", point, ...extra });
const street = (line: Point[], kind = "residential"): Road => ({ osm: "w1", kind, width: 6, layer: 0, bridge: false, tunnel: false, line });
const near = (p: Point, q: Point) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.01;

test("businessQuery asks for businesses with their centres", () => {
  const query = businessQuery({ south: 61.4, west: 23.7, north: 61.5, east: 23.8 });
  assert.match(query, /nwr\["shop"\];/);
  assert.match(query, /nwr\["amenity"~"\^\(restaurant\|cafe\|/);
  assert.match(query, /out tags center;$/);
});

test("parseBusinesses keeps businesses in meters, not other amenities", () => {
  const origin = { latitude: 61.5, longitude: 23.7 };
  const businesses = parseBusinesses(
    [
      { type: "node", id: 1, lat: 61.5, lon: 23.7, tags: { shop: "bakery", name: "Leipomo", level: "0;1" } },
      { type: "node", id: 2, lat: 61.5, lon: 23.7, tags: { amenity: "bench" } },
      { type: "way", id: 3, center: { lat: 61.5, lon: 23.7 }, tags: { building: "retail", amenity: "pharmacy", healthcare: "pharmacy", brand: "Yliopiston Apteekki" } },
      { type: "way", id: 4, tags: { shop: "kiosk" } },
      { type: "node", id: 5, lat: 61.5, lon: 23.7, tags: { shop: "no", office: "it" } },
    ],
    origin,
  );
  assert.deepEqual(
    businesses.map((b) => [b.osm, b.category, b.kind, b.name, b.brand, b.level]),
    [
      ["n1", "shop", "bakery", "Leipomo", undefined, 0],
      ["w3", "amenity", "pharmacy", undefined, "Yliopiston Apteekki", undefined],
      ["n5", "office", "it", undefined, undefined, undefined],
    ],
  );
  assert.ok(near(businesses[0].point, [0, 0]));
});

test("lowestLevel reads lists and ranges", () => {
  assert.deepEqual(["0", "-1", "0;1", "1-2", "-1-0", "2;1", "x", undefined].map(lowestLevel), [0, -1, 0, 1, -1, 1, undefined, undefined]);
});

test("placeBusinesses: a front on the street side of the building, not against its neighbour", () => {
  // two buildings wall to wall along a street to their south, a yard to their north
  const a = rectangle("w10", 0, 0, 20, 15);
  const b = rectangle("w11", 20, 0, 20, 15);
  const roads = [street([[-50, -10], [100, -10]])];
  // nearest to the wall against b, then to the yard, but the street side wins
  const clothes = shop("n1", [19, 9]);
  const counts = placeBusinesses([a, b], [clothes], roads);
  assert.deepEqual(counts, { placed: 1, fronts: 1, atDoors: 0 });
  assert.deepEqual(a.businesses, [clothes]);
  const front = defined(clothes.front);
  assert.ok(near(front.at, [19, 0]));
  assert.equal(front.toward, 270);
  assert.equal(front.entrance, undefined);
});

test("placeBusinesses: at a shop door near it, and the part on the ground", () => {
  const outline = rectangle("w20", 0, 0, 30, 20, { hasParts: true });
  const ground = rectangle("w21", 0, 0, 30, 20, { part: true, entrances: [{ at: [30, 12], kind: "shop" }, { at: [15, 0], kind: "main", guessed: true }] });
  const upper = rectangle("w22", 0, 0, 30, 20, { part: true, minHeight: 6 });
  const cafe = shop("n2", [25, 5], { category: "amenity", kind: "cafe" });
  placeBusinesses([outline, ground, upper], [cafe], [street([[-10, -10], [50, -10]])]);
  assert.deepEqual([outline.businesses, ground.businesses?.length, upper.businesses], [undefined, 1, undefined]);
  assert.deepEqual(cafe.front, { at: [30, 12], toward: 0, entrance: true });
});

test("placeBusinesses: on the building it is tagged on or at the wall of, none deep inside or in no building", () => {
  const mall = rectangle("w30", 0, 0, 100, 100);
  const tagged = rectangle("w31", 200, 0, 20, 20);
  const roads = [street([[-10, -10], [300, -10]])];
  const inMall = shop("n3", [50, 50]);
  const onWall = shop("n4", [201, -1]);
  const onBuilding = shop("w31", [210, 10], { category: "shop", kind: "supermarket" });
  const outside = shop("n5", [150, 50]);
  const counts = placeBusinesses([mall, tagged], [inMall, onWall, onBuilding, outside], roads);
  assert.deepEqual(counts, { placed: 3, fronts: 2, atDoors: 0 });
  assert.deepEqual(mall.businesses, [inMall]);
  assert.equal(inMall.front, undefined);
  assert.deepEqual(tagged.businesses, [onWall, onBuilding]);
  assert.ok(near(defined(onBuilding.front).at, [210, 0]));
  assert.equal(outside.front, undefined);
});

test("placeBusinesses: fronts at one door or spot move apart along the wall, or drop when it is full", () => {
  const block = rectangle("w50", 0, 0, 20, 12, { entrances: [{ at: [10, 0], kind: "shop" }] });
  const roads = [street([[-10, -10], [100, -10]])];
  const first = shop("n8", [9, 3]);
  const second = shop("n9", [11, 3]);
  const third = shop("n10", [10, 4]);
  const fourth = shop("n11", [10, 5]);
  const counts = placeBusinesses([block], [first, second, third, fourth], roads);
  assert.deepEqual(first.front, { at: [10, 0], toward: 270, entrance: true });
  // 6 m on either side along the 20 m street wall; there is no room for a fourth
  assert.deepEqual(second.front, { at: [16, 0], toward: 270 });
  assert.deepEqual(third.front, { at: [4, 0], toward: 270 });
  assert.equal(fourth.front, undefined);
  assert.deepEqual(counts, { placed: 4, fronts: 3, atDoors: 1 });
});

test("placeBusinesses: shops in a shopping centre show only at their own doors", () => {
  const centre = rectangle("w40", 0, 0, 60, 20, { entrances: [{ at: [50, 0], kind: "shop" }] });
  const roads = [street([[-10, -10], [100, -10]])];
  const mall = shop("w40", [30, 10], { kind: "mall", name: "Keskus" });
  const inside = shop("n6", [10, 5]);
  const withDoor = shop("n7", [48, 5]);
  placeBusinesses([centre], [mall, inside, withDoor], roads);
  assert.ok(near(defined(mall.front).at, [30, 0]));
  assert.equal(inside.front, undefined);
  assert.deepEqual(withDoor.front, { at: [50, 0], toward: 270, entrance: true });
});
