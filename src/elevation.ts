// Terrain heights from the National Land Survey's 2 m elevation model (bare ground, meters above sea
// level, N2000), fetched from its WCS as an ASCII grid in ETRS-TM35FIN. CC BY 4.0.
import { createHash } from "node:crypto";
import proj4 from "proj4";
import type { CacheOptions } from "./cache.ts";
import type { GeoPoint } from "./projection.ts";

export const ELEVATION_ATTRIBUTION = "Elevation model © Maanmittauslaitos (CC BY 4.0)";

const WCS_URL = "https://avoin-karttakuva.maanmittauslaitos.fi/ortokuvat-ja-korkeusmallit/wcs/v2";
const COVERAGE = "korkeusmalli_2m";
const CELL_SIZE_M = 2;
/** WCS limits: 10 km a side and 5000 pixels a side */
const MAX_SIDE_M = 10_000;
/** A larger area is fetched in pieces of at most this a side */
const PIECE_M = 9_000;

/** ETRS-TM35FIN (EPSG:3067) */
const TM35FIN = "+proj=utm +zone=35 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs";
const toTm = proj4("WGS84", TM35FIN);

/** Latitude / longitude -> ETRS-TM35FIN easting, northing. */
export function toTm35fin(point: GeoPoint): [number, number] {
  const [e, n] = toTm.forward([point.longitude, point.latitude]);
  return [e, n];
}

export interface TmBox {
  minE: number;
  minN: number;
  maxE: number;
  maxN: number;
}

/** A raster of heights; row 0 is the northernmost. */
export interface ElevationGrid {
  /** TM35FIN easting of the west edge of the first column */
  west: number;
  /** TM35FIN northing of the south edge of the last row */
  south: number;
  cellSize: number;
  cols: number;
  rows: number;
  values: Float32Array;
  noData: number | undefined;
}

/** Parses an Esri ASCII grid (the WCS "text/plain" format). */
export function parseAsciiGrid(text: string): ElevationGrid {
  const header = new Map<string, number>();
  let pos = 0;
  // header lines are "key value"; the data starts at the first line that begins with a number
  for (;;) {
    const end = text.indexOf("\n", pos);
    const line = text.slice(pos, end < 0 ? text.length : end).trim();
    const match = /^([A-Za-z_]+)\s+(\S+)$/.exec(line);
    if (!match) {
      break;
    }
    header.set(match[1].toLowerCase(), Number(match[2]));
    pos = end + 1;
  }
  const cols = header.get("ncols");
  const rows = header.get("nrows");
  const cellSize = header.get("cellsize");
  if (!cols || !rows || !cellSize) {
    throw new Error(`not an ASCII grid: ${text.slice(0, 200)}`);
  }
  // the grid's lower left corner, or the centre of its lower left cell
  const corner = (axis: "x" | "y") => {
    const centre = header.get(`${axis}llcenter`);
    return header.get(`${axis}llcorner`) ?? (centre === undefined ? undefined : centre - cellSize / 2);
  };
  const west = corner("x");
  const south = corner("y");
  if (west === undefined || south === undefined) {
    throw new Error(`ASCII grid without its lower left corner: ${text.slice(0, 200)}`);
  }
  const values = new Float32Array(cols * rows);
  let count = 0;
  for (const token of text.slice(pos).split(/\s+/)) {
    if (token !== "") {
      values[count++] = Number(token);
    }
  }
  if (count !== cols * rows) {
    throw new Error(`ASCII grid has ${count} values, expected ${cols} x ${rows}`);
  }
  return { west, south, cellSize, cols, rows, values, noData: header.get("nodata_value") };
}

/** Bilinear height at a TM35FIN point from the cell centres around it, or undefined off the grid. */
export function sampleElevation(grid: ElevationGrid, e: number, n: number): number | undefined {
  // column / row coordinates of cell centres: column c is centred at west + (c + 0.5) * cellSize
  const fc = (e - grid.west) / grid.cellSize - 0.5;
  const fr = (grid.south + grid.rows * grid.cellSize - n) / grid.cellSize - 0.5;
  if (fc < -0.5 || fr < -0.5 || fc > grid.cols - 0.5 || fr > grid.rows - 0.5) {
    return undefined;
  }
  // at the outer half cell, use the edge cells
  const c0 = Math.min(Math.max(Math.floor(fc), 0), grid.cols - 2);
  const r0 = Math.min(Math.max(Math.floor(fr), 0), grid.rows - 2);
  const tc = Math.min(Math.max(fc - c0, 0), 1);
  const tr = Math.min(Math.max(fr - r0, 0), 1);
  const at = (c: number, r: number) => grid.values[r * grid.cols + c];
  const corners = [at(c0, r0), at(c0 + 1, r0), at(c0, r0 + 1), at(c0 + 1, r0 + 1)];
  if (corners.some((v) => v === grid.noData || !Number.isFinite(v))) {
    return undefined;
  }
  const top = corners[0] + (corners[1] - corners[0]) * tc;
  const bottom = corners[2] + (corners[3] - corners[2]) * tc;
  return top + (bottom - top) * tr;
}

export interface ElevationFetchOptions extends CacheOptions {
  apiKey: string;
}

/** Fetches the elevation model for a TM35FIN box (snapped to whole cells), in pieces past the WCS limit. */
export async function fetchElevation(box: TmBox, options: ElevationFetchOptions): Promise<{ grid: ElevationGrid; cached: boolean }> {
  const snapped = {
    minE: Math.floor(box.minE / CELL_SIZE_M) * CELL_SIZE_M,
    minN: Math.floor(box.minN / CELL_SIZE_M) * CELL_SIZE_M,
    maxE: Math.ceil(box.maxE / CELL_SIZE_M) * CELL_SIZE_M,
    maxN: Math.ceil(box.maxN / CELL_SIZE_M) * CELL_SIZE_M,
  };
  if (snapped.maxE - snapped.minE <= MAX_SIDE_M && snapped.maxN - snapped.minN <= MAX_SIDE_M) {
    return fetchPiece(snapped, options);
  }
  const pieces: ElevationGrid[] = [];
  let cached = true;
  for (let minE = snapped.minE; minE < snapped.maxE; minE += PIECE_M) {
    for (let minN = snapped.minN; minN < snapped.maxN; minN += PIECE_M) {
      const piece = await fetchPiece({ minE, minN, maxE: Math.min(minE + PIECE_M, snapped.maxE), maxN: Math.min(minN + PIECE_M, snapped.maxN) }, options);
      pieces.push(piece.grid);
      cached &&= piece.cached;
    }
  }
  return { grid: mergeGrids(snapped, CELL_SIZE_M, pieces), cached };
}

/** One grid over a box from grids of parts of it, each placed by its own corner; missing cells are NaN. */
export function mergeGrids(box: TmBox, cellSize: number, parts: ElevationGrid[]): ElevationGrid {
  const cols = Math.round((box.maxE - box.minE) / cellSize);
  const rows = Math.round((box.maxN - box.minN) / cellSize);
  const values = new Float32Array(cols * rows).fill(Number.NaN);
  for (const part of parts) {
    const colOffset = Math.round((part.west - box.minE) / part.cellSize);
    // rows count from the north
    const rowOffset = Math.round((box.maxN - (part.south + part.rows * part.cellSize)) / part.cellSize);
    for (let r = 0; r < part.rows; r++) {
      const row = r + rowOffset;
      if (row < 0 || row >= rows) {
        continue;
      }
      for (let c = 0; c < part.cols; c++) {
        const col = c + colOffset;
        const value = part.values[r * part.cols + c];
        if (col >= 0 && col < cols && value !== part.noData) {
          values[row * cols + col] = value;
        }
      }
    }
  }
  return { west: box.minE, south: box.minN, cellSize, cols, rows, values, noData: undefined };
}

/** One WCS request's worth (at most 10 km a side), cached by box */
async function fetchPiece(snapped: TmBox, options: ElevationFetchOptions): Promise<{ grid: ElevationGrid; cached: boolean }> {
  const query = new URLSearchParams({
    service: "WCS",
    version: "2.0.1",
    request: "GetCoverage",
    CoverageID: COVERAGE,
    format: "text/plain",
  });
  const url = `${WCS_URL}?${query}&SUBSET=E(${snapped.minE},${snapped.maxE})&SUBSET=N(${snapped.minN},${snapped.maxN})`;
  // the key is not part of the cache name
  const cacheKey = `mml-elevation-${createHash("sha256").update(url).digest("hex").slice(0, 16)}.asc`;
  const cachedText = options.refresh ? undefined : await options.cache.get(cacheKey);
  if (cachedText !== undefined) {
    return { grid: parseAsciiGrid(cachedText), cached: true };
  }
  const res = await fetch(url, {
    // Basic Auth with the key as the user name keeps it out of URLs that end up in logs
    headers: { authorization: `Basic ${Buffer.from(`${options.apiKey}:`).toString("base64")}` },
  });
  const text = await res.text();
  if (!res.ok || !res.headers.get("content-type")?.startsWith("text/plain")) {
    throw new Error(`elevation model request failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const grid = parseAsciiGrid(text);
  await options.cache.put(cacheKey, text);
  return { grid, cached: false };
}
