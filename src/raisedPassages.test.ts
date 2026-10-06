import assert from "node:assert/strict";
import { test } from "node:test";
import { openPassages, type Building } from "./osm.ts";
import { raisePassages } from "./raisedPassages.ts";

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
