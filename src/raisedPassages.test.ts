import assert from "node:assert/strict";
import { test } from "node:test";
import { openPassages, type Building } from "./osm.ts";
import { passagesUpSlopes, raisePassages } from "./raisedPassages.ts";

function block(): Building {
  return {
    osm: "w1",
    kind: "office",
    part: false,
    hasParts: false,
    height: 20,
    minHeight: 0,
    base: 84,
    polygon: { outer: [[0, -5], [12, -5], [12, 5], [0, 5]], holes: [] },
  };
}

test("a way on a deck through a building opens its walls and its room from the deck up, not from the ground", () => {
  const building = block();
  const line: [number, number][] = [[-3, 0], [15, 0]];
  openPassages([building], [{ line, width: 2.5, height: 2.7 }]);
  raisePassages([building], [{ line, width: 2.5, deck: [89.5, 89.8] }]);
  const grounds = (building.passages ?? []).map((o) => Math.round((o.ground ?? 0) * 100) / 100).sort();
  assert.deepEqual(grounds, [89.55, 89.75]);
  assert.ok((building.passageRooms ?? []).length > 0);
  for (const room of building.passageRooms ?? []) {
    assert.ok(room.ground !== undefined && Math.abs(room.ground - 89.75) < 0.01, `room at ${room.ground}`);
  }
});

test("a way on the ground through a building leaves its openings at the base", () => {
  const building = block();
  const line: [number, number][] = [[-3, 0], [15, 0]];
  openPassages([building], [{ line, width: 2.5, height: 2.7 }]);
  raisePassages([building], [{ line: [[-3, 20], [15, 20]], width: 2.5, deck: [89.5, 89.8] }]);
  assert.ok((building.passages ?? []).every((o) => o.ground === undefined));
});

test("a passage up a slope over the building's base opens its walls and has its room from the ground there up", () => {
  const building = block();
  // the ground rises from the base, 84 m, at the west wall to 86 m at the east wall
  const heightAt = (e: number) => 84 + e / 6;
  openPassages([building], [{ line: [[-3, 0], [15, 0]], width: 2.5, height: 2.7 }]);
  openPassages([building], [{ line: [[0.2, -8], [0.2, 8]], width: 1, height: 0 }]);
  // the east wall's opening and the room
  assert.equal(passagesUpSlopes([building], heightAt), 2);
  const grounds = (building.passages ?? []).map((o) => (o.ground === undefined ? undefined : Math.round(o.ground * 100) / 100));
  // at the base: the west wall's opening, and those of the way across by it
  assert.deepEqual(grounds.filter((g) => g !== undefined), [86]);
  assert.equal(grounds.filter((g) => g === undefined).length, 3);
  assert.deepEqual((building.passageRooms ?? []).map((room) => room.ground), [86]);
  // what has a ground keeps it
  passagesUpSlopes([building], () => 90);
  assert.equal(Math.round(Math.min(...(building.passages ?? []).map((o) => o.ground ?? 0))), 86);
  assert.deepEqual((building.passageRooms ?? []).map((room) => room.ground), [86]);
});
