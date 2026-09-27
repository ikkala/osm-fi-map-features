import assert from "node:assert/strict";
import { test } from "node:test";
import { darkPoint, parseTiff, roofColour, type Raster } from "./ortho.ts";

/** A little-endian uncompressed RGB TIFF in strips of stripRows rows */
function tiff(width: number, height: number, rgb: number[], stripRows: number): Uint8Array {
  const strips = Math.ceil(height / stripRows);
  const entries: [tag: number, type: number, values: number[]][] = [
    [256, 3, [width]],
    [257, 3, [height]],
    [258, 3, [8, 8, 8]],
    [259, 3, [1]],
    [262, 3, [2]],
    [273, 4, []],
    [277, 3, [3]],
    [278, 3, [stripRows]],
    [279, 4, Array.from({ length: strips }, (_, i) => Math.min(stripRows, height - i * stripRows) * width * 3)],
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  // after the header and the IFD: the values that do not fit in an entry, then the pixels
  let extra = 8 + ifdSize;
  const pixels = extra + 6 + strips * 8;
  entries[5][2] = Array.from({ length: strips }, (_, i) => pixels + i * stripRows * width * 3);
  const bytes = new Uint8Array(pixels + rgb.length);
  const view = new DataView(bytes.buffer);
  bytes.set([0x49, 0x49]);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, values], i) => {
    const entry = 10 + i * 12;
    const size = type === 3 ? 2 : 4;
    view.setUint16(entry, tag, true);
    view.setUint16(entry + 2, type, true);
    view.setUint32(entry + 4, values.length, true);
    let at = entry + 8;
    if (values.length * size > 4) {
      view.setUint32(entry + 8, extra, true);
      at = extra;
      extra += values.length * size;
    }
    values.forEach((value, k) => (size === 2 ? view.setUint16(at + k * 2, value, true) : view.setUint32(at + k * 4, value, true)));
  });
  bytes.set(rgb, pixels);
  return bytes;
}

test("parseTiff reads the pixels from every strip", () => {
  const rgb = Array.from({ length: 3 * 5 * 3 }, (_, i) => i);
  assert.deepEqual(parseTiff(tiff(3, 5, rgb, 2)), { width: 3, height: 5, rgb: new Uint8Array(rgb) });
  assert.throws(() => parseTiff(new TextEncoder().encode("<ExceptionReport/>")), /not a TIFF/);
});

/** A 20 x 20 m raster of 0.5 m pixels at (1000, 5000)..(1020, 5020), coloured by the point */
function raster(colour: (e: number, n: number) => [number, number, number]): Raster {
  const width = 40;
  const rgb = new Uint8Array(width * width * 3);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      rgb.set(colour(1000 + (x + 0.5) / 2, 5020 - (y + 0.5) / 2), (y * width + x) * 3);
    }
  }
  return { west: 1000, north: 5020, pixelSize: 0.5, width, height: width, rgb };
}

test("darkPoint is each channel's darkest 0.1 %", () => {
  // a hazy black corner, and a darker red in one pixel (under 0.1 % of 1600 is not enough to count)
  const r = raster((e, n) => (e < 1002 && n < 5002 ? [20, 30, 40] : [200, 200, 200]));
  r.rgb[0] = 5;
  assert.deepEqual(darkPoint(r), [20, 30, 40]);
});

test("roofColour is the median of the lit pixels inside, away from the edges, without the haze", () => {
  const square = (e: number, n: number, size: number) => ({
    outer: [[e, n], [e + size, n], [e + size, n + size], [e, n + size]] satisfies [number, number][],
    holes: [],
  });
  // a red roof from 1005 to 1015 with a dark shadow over its southern quarter and a white wall around it
  const r = raster((e, n) => {
    const onRoof = e >= 1005.5 && e <= 1014.5 && n >= 5005.5 && n <= 5014.5;
    return !onRoof ? [255, 255, 255] : n < 5008 ? [30, 30, 40] : [180, 60, 50];
  });
  assert.equal(roofColour(r, square(1005, 5005, 10), [0, 0, 0]), "#b43c32");
  // the haze taken out: (180 - 20) * 255 / 235 = 174, (60 - 30) * 255 / 225 = 34, (50 - 40) * 255 / 215 = 12
  assert.equal(roofColour(r, square(1005, 5005, 10), [20, 30, 40]), "#ae220c");
  // a 1.5 m kiosk has no pixels 1 m in from its edges, so all of them count
  const kiosk = raster(() => [10, 20, 30]);
  assert.equal(roofColour(kiosk, square(1010, 5010, 1.5), [0, 0, 0]), "#0a141e");
  // off the raster
  assert.equal(roofColour(r, square(2000, 5000, 10), [0, 0, 0]), undefined);
});
