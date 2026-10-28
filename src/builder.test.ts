import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_OVERPASS_URL, MapBuilder } from "./builder.ts";
import { memoryCache } from "./cache.ts";
import { LocalProjection } from "./projection.ts";
import { tileName } from "./tiles.ts";

const origin = { latitude: 61.5, longitude: 23.75 };

test("a map of several boxes has the tiles touching any of them, each once", () => {
  const projection = new LocalProjection(origin);
  // two boxes of about 150 x 150 m, overlapping in the tile 0_0, and a third far off
  const box = (east: number, north: number) => {
    const sw = projection.toGeo([east, north]);
    const ne = projection.toGeo([east + 150, north + 150]);
    return { south: sw.latitude, west: sw.longitude, north: ne.latitude, east: ne.longitude };
  };
  const builder = new MapBuilder({ origin, area: [box(10, 10), box(-120, -120), box(1010, 10)], tileSizeM: 250, cache: memoryCache() });
  assert.deepEqual(builder.tiles.map(tileName), ["-1_-1", "0_-1", "-1_0", "0_0", "4_0"]);
  assert.deepEqual(new MapBuilder({ origin, area: box(10, 10), tileSizeM: 250, cache: memoryCache() }).tiles.map(tileName), ["0_0"]);
});

test("a map needs an area and whole tiles for its fetch pieces", () => {
  const area = { south: 61.5, west: 23.75, north: 61.501, east: 23.751 };
  assert.throws(() => new MapBuilder({ origin, area: [], tileSizeM: 250, cache: memoryCache() }), /no area/);
  assert.throws(() => new MapBuilder({ origin, area, tileSizeM: 250, fetchPieceTiles: 0.5, cache: memoryCache() }), /invalid fetch piece/);
});

test("a map fetched in pieces asks two at a time, telling each piece fetched and none cached", async (t) => {
  // Overpass answers with nothing in a moment, the registers not at all
  let asking = 0;
  let mostAtOnce = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input) !== DEFAULT_OVERPASS_URL) {
      return new Response("", { status: 500 });
    }
    mostAtOnce = Math.max(mostAtOnce, ++asking);
    await new Promise((resolve) => setTimeout(resolve, 5));
    asking--;
    return new Response('{"elements":[]}');
  });
  const projection = new LocalProjection(origin);
  // the tiles 0_0, 1_0 and 2_0, a piece each
  const sw = projection.toGeo([10, 10]);
  const ne = projection.toGeo([650, 150]);
  const area = { south: sw.latitude, west: sw.longitude, north: ne.latitude, east: ne.longitude };
  const cache = memoryCache();
  const piecesTold = async () => {
    const lines: string[] = [];
    const logger = { log: (line: string) => lines.push(line), warn: () => {} };
    await new MapBuilder({ origin, area, tileSizeM: 250, fetchPieceTiles: 1, cache, logger, roofTops: [], treeRegisters: [] }).info();
    return lines.filter((line) => line.includes("piece "));
  };
  const told = await piecesTold();
  const pieceOf = (line: string) => line.replace(/^\[ *\d+ %\] /, "");
  assert.deepEqual(
    told.map(pieceOf).filter((line) => line.startsWith("OSM elements")).sort(),
    ["OSM elements: piece 1 of 3 fetched", "OSM elements: piece 2 of 3 fetched", "OSM elements: piece 3 of 3 fetched"],
  );
  assert.ok(told.map(pieceOf).includes("OSM entrances: piece 3 of 3 fetched"));
  // six Overpass queries and the building register, which fails, of 3 pieces each
  assert.match(told[0], /^\[  4 %\] /);
  assert.match(told[told.length - 1], /^\[100 %\] /);
  assert.equal(mostAtOnce, 2);
  assert.deepEqual(await piecesTold(), []);
});
