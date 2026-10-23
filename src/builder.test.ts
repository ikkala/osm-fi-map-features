import assert from "node:assert/strict";
import { test } from "node:test";
import { MapBuilder } from "./builder.ts";
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
