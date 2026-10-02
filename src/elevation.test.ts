import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeGrids, parseAsciiGrid, sampleElevation, toTm35fin } from "./elevation.ts";
import { LocalProjection } from "./projection.ts";
import { latticeProjection, tileHeights } from "./tiles.ts";

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

test("latticeProjection is exact for a linear projection, inside the tile and at its edges", () => {
  const linear = (e: number, n: number): [number, number] => [300_000 + 0.9 * e - 0.1 * n, 6_800_000 + 0.1 * e + 0.9 * n];
  const at = latticeProjection({ x: 2, y: -3 }, 250, 10, linear);
  for (const [e, n] of [[500, -750], [750, -500], [612.3, -611.7], [749.99, -500.01]]) {
    const [x, y] = at(e, n);
    const [ex, ey] = linear(e, n);
    assert.ok(Math.abs(x - ex) < 1e-6 && Math.abs(y - ey) < 1e-6, `at ${e}, ${n}: ${x}, ${y}`);
  }
});

test("latticeProjection keeps to TM35FIN within a millimetre over a tile in Tampere, 10 km out", () => {
  const projection = new LocalProjection({ latitude: 61.4978, longitude: 23.761 });
  const toTm = (e: number, n: number) => toTm35fin(projection.toGeo([e, n]));
  const tile = { x: 40, y: -40 };
  const at = latticeProjection(tile, 250, 10, toTm);
  let worst = 0;
  for (let e = 10_000; e <= 10_250; e += 7.3) {
    for (let n = -10_000; n <= -9_750; n += 7.3) {
      const [x, y] = at(e, n);
      const [ex, ey] = toTm(e, n);
      worst = Math.max(worst, Math.hypot(x - ex, y - ey));
    }
  }
  assert.ok(worst < 0.001, `${worst} m`);
});

test("mergeGrids puts the pieces of a large area where their corners say, leaving gaps empty", () => {
  // two 2 x 1 pieces side by side, and the box one row taller than they are
  const west = parseAsciiGrid("ncols 2\nnrows 1\nxllcorner 1000\nyllcorner 5002\ncellsize 2\nNODATA_value -9999\n1 -9999\n");
  const east = parseAsciiGrid("ncols 2\nnrows 1\nxllcorner 1004\nyllcorner 5002\ncellsize 2\n3 4\n");
  const grid = mergeGrids({ minE: 1000, minN: 5000, maxE: 1008, maxN: 5004 }, 2, [west, east]);
  assert.deepEqual([grid.west, grid.south, grid.cols, grid.rows], [1000, 5000, 4, 2]);
  assert.deepEqual([...grid.values].slice(0, 4), [1, Number.NaN, 3, 4]);
  assert.ok([...grid.values].slice(4).every(Number.isNaN));
  assert.equal(sampleElevation(grid, 1001, 5001), undefined);
});
