// Roof colours from the National Land Survey's colour orthophoto (WCS, uncompressed GeoTIFF in
// ETRS-TM35FIN, CC BY 4.0): the median of the pixels inside each outline. Only colours are cached, a file per
// square of the photo, so maps of different places keep theirs.
import { createHash } from "node:crypto";
import type { CacheOptions } from "./cache.ts";
import { distanceToRing, pointInPolygon, type Point, type Polygon } from "./geometry.ts";
import { field, isObject } from "./json.ts";

export const ORTHO_ATTRIBUTION = "Orthophoto © Maanmittauslaitos (CC BY 4.0)";

const WCS_URL = "https://avoin-karttakuva.maanmittauslaitos.fi/ortokuvat-ja-korkeusmallit/wcs/v2";
const COVERAGE = "ortokuva_vari";
const PIXEL_SIZE_M = 0.5;
/** WCS limit: 4000 pixels a side */
const MAX_SIDE_M = 4000 * PIXEL_SIZE_M;
/** Roofs are fetched by the square their centre is in, with this margin for roofs crossing its edges */
const SQUARE_MARGIN_M = 100;
const SQUARE_M = MAX_SIDE_M - 2 * SQUARE_MARGIN_M;
/** Pixels this close to the outline are left out (eaves, leaning walls, misalignment) */
const EDGE_MARGIN_M = 1;
/** Fewer pixels than this is no colour */
const MIN_PIXELS = 4;
/** Followed by the square, "<e>_<n>.json" */
const CACHE_PREFIX = "mml-roof-colours-";
/** Every outline's colour in one file, as an earlier version kept them: read so they are not fetched again */
const LEGACY_CACHE_KEY = "mml-roof-colours.json";
/** Bump when the colour computation changes, so cached colours are computed again */
const CACHE_VERSION = 1;

/** An image in ETRS-TM35FIN: RGB bytes, rows from the north */
export interface Raster {
  /** Easting of the west edge */
  west: number;
  /** Northing of the north edge */
  north: number;
  pixelSize: number;
  width: number;
  height: number;
  rgb: Uint8Array;
}

/** Reads an uncompressed 8-bit RGB TIFF (as the WCS sends them): width, height and the pixels */
export function parseTiff(bytes: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = String.fromCharCode(bytes[0], bytes[1]);
  if ((order !== "II" && order !== "MM") || view.getUint16(2, order === "II") !== 42) {
    throw new Error(`not a TIFF: ${new TextDecoder().decode(bytes.subarray(0, 200))}`);
  }
  const le = order === "II";
  const u16 = (offset: number) => view.getUint16(offset, le);
  const u32 = (offset: number) => view.getUint32(offset, le);
  // tag -> its values (SHORT or LONG)
  const tags = new Map<number, number[]>();
  const ifd = u32(4);
  for (let i = 0; i < u16(ifd); i++) {
    const entry = ifd + 2 + i * 12;
    const type = u16(entry + 2);
    const count = u32(entry + 4);
    const size = type === 3 ? 2 : type === 4 ? 4 : 0;
    if (size === 0) {
      continue;
    }
    // values that fit in 4 bytes are in the entry itself
    const at = size * count <= 4 ? entry + 8 : u32(entry + 8);
    tags.set(u16(entry), Array.from({ length: count }, (_, k) => (size === 2 ? u16(at + k * 2) : u32(at + k * 4))));
  }
  const tag = (id: number) => tags.get(id) ?? [];
  const [width] = tag(256);
  const [height] = tag(257);
  const [compression = 1] = tag(259);
  const [samples = 1] = tag(277);
  const [planar = 1] = tag(284);
  const offsets = tag(273);
  const counts = tag(279);
  if (!width || !height || compression !== 1 || samples !== 3 || planar !== 1 || tag(258).some((bits) => bits !== 8) || offsets.length === 0) {
    throw new Error("the TIFF is not uncompressed 8-bit RGB in strips");
  }
  const rgb = new Uint8Array(width * height * 3);
  let pos = 0;
  offsets.forEach((offset, i) => {
    const strip = bytes.subarray(offset, offset + (counts[i] ?? 0));
    rgb.set(strip.subarray(0, rgb.length - pos), pos);
    pos += strip.length;
  });
  if (pos < rgb.length) {
    throw new Error(`the TIFF has ${pos} bytes of pixels, expected ${rgb.length}`);
  }
  return { width, height, rgb };
}

/** The haze in a raster: each channel's value at its darkest 0.1 %, which would be black without it. */
export function darkPoint(raster: Raster): [number, number, number] {
  const pixels = raster.width * raster.height;
  const channelDark = (channel: number) => {
    const histogram = new Uint32Array(256);
    for (let i = channel; i < raster.rgb.length; i += 3) {
      histogram[raster.rgb[i]]++;
    }
    let sum = 0;
    for (let value = 0; value < 256; value++) {
      sum += histogram[value];
      if (sum >= pixels * 0.001) {
        return value;
      }
    }
    return 0;
  };
  return [channelDark(0), channelDark(1), channelDark(2)];
}

/**
 * The roof colour ("#rrggbb") over a TM35FIN outline, or undefined: the median of the pixels inside,
 * without the edges and the darkest third (shadows), with the haze taken out.
 */
export function roofColour(raster: Raster, outline: Polygon, dark: [number, number, number]): string | undefined {
  const xs = outline.outer.map(([e]) => (e - raster.west) / raster.pixelSize);
  const ys = outline.outer.map(([, n]) => (raster.north - n) / raster.pixelSize);
  const inside: number[] = [];
  const away: number[] = [];
  for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(raster.height, Math.ceil(Math.max(...ys))); y++) {
    for (let x = Math.max(0, Math.floor(Math.min(...xs))); x < Math.min(raster.width, Math.ceil(Math.max(...xs))); x++) {
      const point: Point = [raster.west + (x + 0.5) * raster.pixelSize, raster.north - (y + 0.5) * raster.pixelSize];
      if (!pointInPolygon(point, outline)) {
        continue;
      }
      const index = (y * raster.width + x) * 3;
      inside.push(index);
      if ([outline.outer, ...outline.holes].every((ring) => distanceToRing(point, ring) >= EDGE_MARGIN_M)) {
        away.push(index);
      }
    }
  }
  // small roofs (kiosks, sheds) have no pixels away from the edges
  const pixels = away.length >= MIN_PIXELS ? away : inside;
  if (pixels.length < MIN_PIXELS) {
    return undefined;
  }
  const { rgb } = raster;
  const luminance = (i: number) => 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2];
  const lit = pixels.map((i) => ({ i, l: luminance(i) })).sort((a, b) => a.l - b.l).slice(Math.floor(pixels.length / 3));
  return (
    "#" +
    [0, 1, 2]
      .map((channel) => {
        const values = lit.map(({ i }) => rgb[i + channel]).sort((a, b) => a - b);
        const median = values[values.length >> 1];
        const d = dark[channel];
        const value = Math.round(((median - d) * 255) / (255 - d));
        return Math.min(255, Math.max(0, value)).toString(16).padStart(2, "0");
      })
      .join("")
  );
}

/** Fetches the orthophoto for a TM35FIN box (snapped out to whole pixels). */
export async function fetchOrtho(box: { minE: number; minN: number; maxE: number; maxN: number }, apiKey: string): Promise<Raster> {
  const minE = Math.floor(box.minE / PIXEL_SIZE_M) * PIXEL_SIZE_M;
  const minN = Math.floor(box.minN / PIXEL_SIZE_M) * PIXEL_SIZE_M;
  const maxE = Math.ceil(box.maxE / PIXEL_SIZE_M) * PIXEL_SIZE_M;
  const maxN = Math.ceil(box.maxN / PIXEL_SIZE_M) * PIXEL_SIZE_M;
  if (maxE - minE > MAX_SIDE_M || maxN - minN > MAX_SIDE_M) {
    throw new Error(`the orthophoto area is over ${MAX_SIDE_M} m a side`);
  }
  const query = new URLSearchParams({ service: "WCS", version: "2.0.1", request: "GetCoverage", CoverageID: COVERAGE, format: "image/tiff" });
  const res = await fetch(`${WCS_URL}?${query}&SUBSET=E(${minE},${maxE})&SUBSET=N(${minN},${maxN})`, {
    // Basic Auth with the key as the user name keeps it out of URLs that end up in logs
    headers: { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` },
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!res.ok || res.headers.get("content-type") !== "image/tiff") {
    throw new Error(`orthophoto request failed (${res.status}): ${new TextDecoder().decode(bytes.subarray(0, 500))}`);
  }
  const { width, height, rgb } = parseTiff(bytes);
  if (width !== Math.round((maxE - minE) / PIXEL_SIZE_M) || height !== Math.round((maxN - minN) / PIXEL_SIZE_M)) {
    throw new Error(`the orthophoto is ${width} x ${height} pixels, not the ${maxE - minE} x ${maxN - minN} m asked for`);
  }
  return { west: minE, north: maxN, pixelSize: PIXEL_SIZE_M, width, height, rgb };
}

export interface RoofColourResult {
  /** Colour by the index of the outline; missing when the photo had none for it */
  colours: Map<number, string>;
  /** Outlines whose colour came from the cache */
  cached: number;
  /** Orthophoto squares fetched */
  fetched: number;
}

/** Roof colours of TM35FIN outlines, cached by outline shape, else fetched a square at a time. */
export async function fetchRoofColours(
  outlines: Polygon[],
  options: CacheOptions & { apiKey: string; log?: (message: string) => void },
): Promise<RoofColourResult> {
  const keys = outlines.map(outlineKey);
  const result: RoofColourResult = { colours: new Map(), cached: 0, fetched: 0 };
  // the outlines by the square their box's centre is in
  const squares = new Map<string, number[]>();
  outlines.forEach((outline, index) => {
    const box = ringBox(outline.outer);
    const square = `${Math.floor((box.minE + box.maxE) / 2 / SQUARE_M)}_${Math.floor((box.minN + box.maxN) / 2 / SQUARE_M)}`;
    squares.set(square, [...(squares.get(square) ?? []), index]);
  });
  const legacy = await readColours(LEGACY_CACHE_KEY, options);
  for (const [square, indices] of squares) {
    const cacheKey = `${CACHE_PREFIX}${square}.json`;
    const known = await readColours(cacheKey, options);
    let changed = false;
    for (const index of indices) {
      const colour = legacy.get(keys[index]);
      if (!known.has(keys[index]) && colour !== undefined) {
        known.set(keys[index], colour);
        changed = true;
      }
    }
    const missing = indices.filter((index) => !known.has(keys[index]));
    if (missing.length > 0) {
      const [se, sn] = square.split("_").map(Number);
      // the whole square, so the haze is measured the same way however few roofs are missing
      const box = {
        minE: se * SQUARE_M - SQUARE_MARGIN_M,
        minN: sn * SQUARE_M - SQUARE_MARGIN_M,
        maxE: (se + 1) * SQUARE_M + SQUARE_MARGIN_M,
        maxN: (sn + 1) * SQUARE_M + SQUARE_MARGIN_M,
      };
      options.log?.(`fetching the orthophoto for ${missing.length} roofs in ${box.minE}..${box.maxE} E, ${box.minN}..${box.maxN} N`);
      const raster = await fetchOrtho(box, options.apiKey);
      result.fetched++;
      const dark = darkPoint(raster);
      for (const index of missing) {
        known.set(keys[index], roofColour(raster, outlines[index], dark) ?? "");
      }
      changed = true;
    }
    result.cached += indices.length - missing.length;
    for (const index of indices) {
      const colour = known.get(keys[index]);
      // "" is a roof the photo had no colour for
      if (colour) {
        result.colours.set(index, colour);
      }
    }
    // after every square, so an interrupted import does not fetch it again; outlines of other maps are kept
    if (changed) {
      await options.cache.put(cacheKey, JSON.stringify({ version: CACHE_VERSION, colours: Object.fromEntries(known) }));
    }
  }
  return result;
}

/** The colours cached under the key, by outline; none with `refresh` or of another version */
async function readColours(key: string, options: CacheOptions): Promise<Map<string, string>> {
  const known = new Map<string, string>();
  const text = options.refresh ? undefined : await options.cache.get(key);
  if (text !== undefined) {
    const json: unknown = JSON.parse(text);
    const colours = field(json, "colours");
    if (field(json, "version") === CACHE_VERSION && isObject(colours)) {
      for (const [outline, colour] of Object.entries(colours)) {
        if (typeof colour === "string") {
          known.set(outline, colour);
        }
      }
    }
  }
  return known;
}

/** The cache's key of an outline: a hash of its shape */
export function outlineKey(outline: Polygon): string {
  const text = [outline.outer, ...outline.holes].map((ring) => ring.map(([e, n]) => `${e.toFixed(1)} ${n.toFixed(1)}`).join(",")).join(";");
  return createHash("sha256").update(text).digest("hex").slice(0, 20);
}

function ringBox(ring: Point[]): { minE: number; minN: number; maxE: number; maxN: number } {
  const es = ring.map(([e]) => e);
  const ns = ring.map(([, n]) => n);
  return { minE: Math.min(...es), minN: Math.min(...ns), maxE: Math.max(...es), maxN: Math.max(...ns) };
}
