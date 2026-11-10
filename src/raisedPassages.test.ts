import assert from "node:assert/strict";
import { test } from "node:test";
import { openPassages, type Building } from "./osm.ts";
import { matchOpeningsToRooms, passagesUpSlopes, raisePassages } from "./raisedPassages.ts";

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

test("rooms meeting at an opening between two parts take the higher ceiling there, and the openings reach up to their rooms'", () => {
  // two parts side by side on a slope down to the east, a way through both
  const part = (osm: string, west: number): Building => ({ ...block(), osm, part: true, polygon: { outer: [[west, -5], [west + 12, -5], [west + 12, 5], [west, 5]], holes: [] } });
  const [west, east] = [part("w1", 0), part("w2", 12)];
  // 86 m at the west end to 84 at the east end
  const heightAt = (e: number) => 86 - e / 12;
  openPassages([west, east], [{ line: [[-3, 0], [27, 0]], width: 2.5, height: 3 }]);
  passagesUpSlopes([west, east], heightAt);
  const rooms = [west, east].flatMap((b) => b.passageRooms ?? []);
  assert.equal(rooms.length, 2);
  // the ceilings follow the ground, 3 m over it, a section every few metres
  for (const room of rooms) {
    assert.equal(room.grounds?.length, room.sections.length);
    assert.ok(room.sections.length >= 5);
    for (const [k, [l, r]] of room.sections.entries()) {
      assert.ok(Math.abs((room.grounds?.[k] ?? 0) - heightAt((l[0] + r[0]) / 2)) < 1e-9);
    }
  }
  // where the rooms meet, the same ceiling
  const at = (room: (typeof rooms)[number], x: number) => {
    const k = room.sections.findIndex(([l]) => Math.abs(l[0] - x) < 1e-6);
    return (room.grounds?.[k] ?? 0) + room.height;
  };
  assert.ok(Math.abs(at(rooms[0], 12) - 88) < 1e-9 && Math.abs(at(rooms[1], 12) - 88) < 1e-9);
  // every opening reaches its room's ceiling there from its own ground, which stays
  const ceilings = new Map([[0, 89], [12, 88], [24, 87]]);
  for (const b of [west, east]) {
    for (const o of b.passages ?? []) {
      const ceiling = ceilings.get(Math.round(o.from[0]));
      assert.ok(ceiling !== undefined && Math.abs((o.ground ?? 84) + o.height - ceiling) < 1e-9, `${b.osm} opening at ${o.from} up to ${(o.ground ?? 84) + o.height}`);
    }
  }
  const wall = west.passages?.find((o) => Math.abs(o.from[0] - 12) < 1e-6);
  assert.ok(wall && wall.ground !== undefined && Math.abs(wall.ground - 85) < 0.01);
});

test("a room up a slope meets a level one beside its low end at its ceiling there, not at its highest", () => {
  const building = block();
  // the ground rises 2 m along the way, from the base at its east end; a level walk beside its east end, at the base
  const heightAt = (e: number, n: number) => (n < -1 ? 84 : 86 - e / 6);
  openPassages([building], [
    { line: [[-3, 0], [15, 0]], width: 2, height: 3 },
    { line: [[8, -2], [15, -2]], width: 1.5, height: 3 },
  ]);
  passagesUpSlopes([building], heightAt);
  const [way, walk] = building.passageRooms ?? [];
  assert.ok(way.grounds && walk.grounds === undefined);
  // the walk's room rises to the way's ceiling beside it, not to the way's highest
  const ceiling = (walk.ground ?? 84) + walk.height;
  assert.ok(ceiling > 87.5 && ceiling < 88, `the walk's ceiling at ${ceiling}`);
  // the way's ceiling stays 3 m over its ground at its west end
  assert.ok(Math.abs((way.grounds[0] ?? 0) + way.height - 89) < 1e-9);
});

test("rooms side by side, one space, take the higher ceiling; rooms apart keep their own", () => {
  const building = block();
  // a walk and steps beside it, half a metre apart, of different heights; and a way of its own farther off
  openPassages([building], [
    { line: [[-3, -2], [15, -2]], width: 2, height: 3 },
    { line: [[-3, 0.4], [6, 0.4]], width: 2, height: 2.5 },
    { line: [[-3, 4], [15, 4]], width: 1, height: 2 },
  ]);
  matchOpeningsToRooms([building]);
  const ceilings = (building.passageRooms ?? []).map((room) => (room.ground ?? 84) + room.height);
  assert.deepEqual(ceilings, [87, 87, 86]);
});
