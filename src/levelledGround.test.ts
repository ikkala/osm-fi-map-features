import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { levelGround, parseLevelledGround, readLevelledGround } from "./levelledGround.ts";

const ORIGIN = { latitude: 61.5, longitude: 23.75 };
/** A square 40 m a side north-east of the origin, its west side at 100 m and its east side at 104 m */
const SQUARE = `<?xml version='1.0' encoding='UTF-8'?>
<osm version='0.6' generator='JOSM'>
  <node id='-1' lat='61.5' lon='23.75'><tag k='ele' v='100' /></node>
  <node id='-2' lat='61.50035874' lon='23.75'><tag k='ele' v='100' /></node>
  <node id='-3' lat='61.50035874' lon='23.75075212'><tag k="ele" v="104" /></node>
  <node id='-4' lat='61.5' lon='23.75075212'><tag k='ele' v='104' /></node>
  <node id='-5' lat='61.6' lon='23.8' />
  <way id='-6'>
    <nd ref='-1' /><nd ref='-2' /><nd ref='-3' /><nd ref='-4' /><nd ref='-1' />
    <tag k='ground' v='levelled' />
  </way>
  <way id='-7'>
    <nd ref='-4' /><nd ref='-5' />
    <tag k='highway' v='path' />
  </way>
</osm>
`;

const near = (actual: number, expected: number, tolerance: number) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test("a levelled area's ground is a surface between its outline's heights, eased in from the outline", () => {
  const areas = parseLevelledGround(SQUARE, ORIGIN);
  assert.equal(areas.length, 1);
  const level = levelGround(areas);
  // a heap in the middle goes down to the heights at the sides, between the west's and the east's
  near(level([20, 20], 110), 102, 0.1);
  near(level([10, 20], 110), 101.2, 0.6);
  // 1 m inside the outline a quarter of the way down, outside it as it was
  near(level([1, 20], 110), 110 - (110 - 100.1) / 4, 0.3);
  assert.equal(level([-1, 20], 110), 110);
  assert.equal(level([20, 50], 110), 110);
});

test("a levelled area must be closed and have its heights", () => {
  assert.throws(() => parseLevelledGround(SQUARE.replace("<nd ref='-4' /><nd ref='-1' />", "<nd ref='-4' />"), ORIGIN), /not closed/);
  assert.throws(() => parseLevelledGround(SQUARE.replace(`<tag k="ele" v="104" />`, ""), ORIGIN), /node -3 has no ele/);
  assert.deepEqual(parseLevelledGround("<osm/>", ORIGIN), []);
});

test("the levelled ground reads from a stream as from a text", async () => {
  const bytes = new TextEncoder().encode(SQUARE);
  // in pieces that split characters' bytes and the XML's tags
  const stream = Readable.from([bytes.subarray(0, 101), bytes.subarray(101, 333), bytes.subarray(333)]);
  const level = await readLevelledGround(stream, ORIGIN);
  near(level([20, 20], 110), 102, 0.1);
});
