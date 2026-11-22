import assert from "node:assert/strict";
import { test } from "node:test";
import type { Rail, Road } from "./osm.ts";
import { CLEARANCE_M, GRADE, isRoad, MIN_CLEARANCE_M, RAIL_WIDTH_M, TRAM_CUT_CLEARANCE_M, userOf, WAY_DIMENSIONS, widthOf } from "./ways.ts";

const road = (kind: string, width = 6): Road => ({ osm: "w1", kind, width, layer: 0, bridge: false, tunnel: false, line: [] });
const rail = (kind: string): Rail => ({ osm: "w2", kind, layer: 0, bridge: false, tunnel: false, line: [] });

test("a way's users: people on walkways, vehicles on other roads, trams on tramways, trains on other railways", () => {
  assert.equal(userOf(road("footway")), "people");
  assert.equal(userOf(road("steps")), "people");
  assert.equal(userOf(road("track")), "people");
  assert.equal(userOf(road("residential")), "vehicles");
  assert.equal(userOf(road("service")), "vehicles");
  assert.equal(userOf(rail("tram")), "trams");
  assert.equal(userOf(rail("light_rail")), "trams");
  assert.equal(userOf(rail("rail")), "trains");
  assert.equal(userOf(rail("subway")), "trains");
});

test("a way's width: a road's own, a railway's ballast", () => {
  assert.equal(widthOf(road("primary", 9)), 9);
  assert.equal(widthOf(rail("rail")), RAIL_WIDTH_M);
  assert.ok(isRoad(road("path")));
  assert.ok(!isRoad(rail("tram")));
});

test("every user has more room where the map chooses than its least, and the taller vehicles more than people", () => {
  for (const user of ["people", "vehicles", "trams", "trains"] as const) {
    assert.ok(CLEARANCE_M[user] >= MIN_CLEARANCE_M[user], user);
    assert.ok(MIN_CLEARANCE_M[user] >= MIN_CLEARANCE_M.people, user);
    assert.ok(GRADE[user] <= GRADE.people, user);
  }
  assert.ok(TRAM_CUT_CLEARANCE_M > MIN_CLEARANCE_M.trams && TRAM_CUT_CLEARANCE_M <= CLEARANCE_M.trams);
});

test("the dimensions as data are those of the module, as JSON keeps them", () => {
  const data: unknown = JSON.parse(JSON.stringify(WAY_DIMENSIONS));
  assert.deepEqual(data, { ...WAY_DIMENSIONS, walkways: [...WAY_DIMENSIONS.walkways], tramways: [...WAY_DIMENSIONS.tramways] });
  assert.equal(WAY_DIMENSIONS.railWidth, RAIL_WIDTH_M);
  assert.deepEqual(WAY_DIMENSIONS.clearance, CLEARANCE_M);
  assert.ok(WAY_DIMENSIONS.walkways.includes("footway"));
  assert.ok(WAY_DIMENSIONS.tramways.includes("tram"));
});
