import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAsciiGrid, sampleElevation, toTm35fin } from "./elevation.ts";
import { tileHeights } from "./tiles.ts";

// 3 x 2 cells of 2 m: rows from the north
const GRID = `ncols        3
nrows        2
xllcorner    1000.0
yllcorner    5000.0
cellsize     2.0
NODATA_value -9999
10 12 14
20 22 -9999
`;

test("parseAsciiGrid reads the header and the rows", () => {
  const grid = parseAsciiGrid(GRID);
  assert.deepEqual([grid.west, grid.south, grid.cellSize, grid.cols, grid.rows, grid.noData], [1000, 5000, 2, 3, 2, -9999]);
  assert.deepEqual([...grid.values], [10, 12, 14, 20, 22, -9999]);
  assert.throws(() => parseAsciiGrid("<ExceptionReport/>"), /not an ASCII grid/);
});

test("sampleElevation interpolates between cell centres", () => {
  const grid = parseAsciiGrid(GRID);
  // centre of the north-west cell, and halfway to its east and south neighbours
  assert.equal(sampleElevation(grid, 1001, 5003), 10);
  assert.equal(sampleElevation(grid, 1002, 5003), 11);
  assert.equal(sampleElevation(grid, 1001, 5002), 15);
  assert.equal(sampleElevation(grid, 1002, 5002), 16);
  // the outer half cell uses the edge cells
  assert.equal(sampleElevation(grid, 1000.2, 5003.8), 10);
  // off the grid, or next to a no-data cell
  assert.equal(sampleElevation(grid, 999, 5003), undefined);
  assert.equal(sampleElevation(grid, 1005, 5001), undefined);
});

test("toTm35fin puts the central meridian at 500 000 m and Tampere where it belongs", () => {
  assert.ok(Math.abs(toTm35fin({ latitude: 62, longitude: 27 })[0] - 500_000) < 1e-6);
  // Tampere's central square is at about E 327 500, N 6 822 500
  const [e, n] = toTm35fin({ latitude: 61.4978, longitude: 23.761 });
  assert.ok(Math.abs(e - 327_500) < 1000, `E ${e}`);
  assert.ok(Math.abs(n - 6_822_500) < 1000, `N ${n}`);
});

test("tileHeights samples the tile grid from the south-west and fills gaps with the average", () => {
  const { heights, missing } = tileHeights({ x: 1, y: -1 }, 10, 5, (e, n) => (e === 20 && n === 0 ? undefined : e + n / 10));
  assert.equal(heights.count, 3);
  assert.equal(missing, 1);
  // first row: n = -10, e = 10, 15, 20 -> 9, 14, 19 m -> decimeters
  assert.deepEqual(heights.values.slice(0, 3), [90, 140, 190]);
  const average = (9 + 14 + 19 + 9.5 + 14.5 + 19.5 + 10 + 15) / 8;
  assert.equal(heights.values[8], Math.round(average * 10));
});
