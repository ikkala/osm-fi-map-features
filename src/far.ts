// A tile seen from afar: a coarse ground cover picture, coarse heights and every building as a box.
import { orientedBox, triangulate, type Point } from "./geometry.ts";
import type { AreaKind } from "./osm.ts";
import { tileRect, type Heights, type Tile } from "./tiles.ts";

/** What a cell of the cover shows, by its index (see FarTile.cover). Later areas are painted over earlier ones. */
export const FAR_CLASSES = ["ground", "grass", "forest", "sand", "rock", "pitch", "paved", "water", "road", "path", "rail"] as const;
export type FarClass = (typeof FAR_CLASSES)[number];

/** A building as the box around its outline, with a side along one of its edges. */
export interface FarBox {
  /** The box's centre, meters east and north of the map origin */
  center: Point;
  /** The direction of its long side, radians counter-clockwise from east (0 ... pi) */
  angle: number;
  /** Meters along and across that direction */
  length: number;
  width: number;
  /** Meters above sea level it stands at (unset without an elevation model) */
  base?: number;
  /** Meters above base to its bottom and its top */
  minHeight: number;
  height: number;
  colour?: string;
  roofColour?: string;
}

export interface FarTile {
  /** size × size cells from the north-west corner, row by row, each a base-36 index into FAR_CLASSES */
  cover: { size: number; cells: string };
  /** The ground's heights on a coarse grid (unset when the tile has none) */
  heights?: Heights;
  boxes: FarBox[];
}

export interface FarOptions {
  /** Cells along each side of the cover */
  coverSize?: number;
  /** Grid points along each side of the heights, edges included */
  heightCount?: number;
  /** Buildings whose box is smaller than this (m²) are left out */
  minArea?: number;
}

const COVER_SIZE = 128;
const HEIGHT_COUNT = 17;
const MIN_AREA_M2 = 40;
/** Areas in painting order, as FAR_CLASSES has them */
const AREA_ORDER: AreaKind[] = ["grass", "forest", "sand", "rock", "pitch", "paved", "water"];
/** highway=* values drawn as paths rather than roads */
const PATHS = new Set(["footway", "pedestrian", "cycleway", "path", "track", "bridleway", "steps"]);
const PATH_WIDTH_M = 2;
const ROAD_WIDTH_M = 6;
const RAIL_WIDTH_M = 3;

/** The summary of a tile of tileSize meters for drawing it from afar. */
export function farTile(tile: Tile, tileSize: number, options: FarOptions = {}): FarTile {
  const far: FarTile = {
    cover: cover(tile, tileSize, options.coverSize ?? COVER_SIZE),
    boxes: boxes(tile, options.minArea ?? MIN_AREA_M2),
  };
  if (tile.heights) {
    far.heights = coarseHeights(tile.heights, tileSize, options.heightCount ?? HEIGHT_COUNT);
  }
  return far;
}

function classIndex(name: FarClass): number {
  return FAR_CLASSES.indexOf(name);
}

function cover(tile: Tile, tileSize: number, size: number): { size: number; cells: string } {
  const cells = new Uint8Array(size * size);
  const rect = tileRect(tile, tileSize);
  const scale = size / tileSize;
  // cell coordinates: x east from the west edge, y south from the north edge
  const toCell = ([e, n]: Point): Point => [(e - rect.minX) * scale, (rect.maxY - n) * scale];

  for (const kind of AREA_ORDER) {
    const value = classIndex(kind);
    for (const area of tile.areas) {
      if (area.kind !== kind) {
        continue;
      }
      const points = [area.polygon.outer, ...area.polygon.holes].flat().map(toCell);
      const triangles = triangulate(area.polygon);
      for (let i = 0; i + 2 < triangles.length; i += 3) {
        fillTriangle(cells, size, value, points[triangles[i]], points[triangles[i + 1]], points[triangles[i + 2]]);
      }
    }
  }
  const line = (value: number, points: Point[], widthM: number) => {
    const half = Math.max((widthM * scale) / 2, 0.5);
    const cellPoints = points.map(toCell);
    for (let i = 0; i + 1 < cellPoints.length; i++) {
      fillSegment(cells, size, value, cellPoints[i], cellPoints[i + 1], half);
    }
  };
  for (const road of tile.roads) {
    if (!road.tunnel) {
      const path = PATHS.has(road.kind);
      line(classIndex(path ? "path" : "road"), road.line, road.width || (path ? PATH_WIDTH_M : ROAD_WIDTH_M));
    }
  }
  for (const rail of tile.rails) {
    if (!rail.tunnel) {
      line(classIndex("rail"), rail.line, RAIL_WIDTH_M);
    }
  }
  let text = "";
  for (const value of cells) {
    text += value.toString(36);
  }
  return { size, cells: text };
}

/** Sets the cells whose centre is in the triangle. */
function fillTriangle(cells: Uint8Array, size: number, value: number, a: Point, b: Point, c: Point): void {
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(area) < 1e-12) {
    return;
  }
  const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
  const x1 = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
  const y1 = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const w0 = (b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px);
      const w1 = (c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px);
      const w2 = (a[0] - px) * (b[1] - py) - (a[1] - py) * (b[0] - px);
      if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) {
        cells[y * size + x] = value;
      }
    }
  }
}

/** Sets the cells whose centre is within half of the segment. */
function fillSegment(cells: Uint8Array, size: number, value: number, a: Point, b: Point, half: number): void {
  const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - half));
  const x1 = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0]) + half));
  const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - half));
  const y1 = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1]) + half));
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const lengthSq = dx * dx + dy * dy;
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const t = lengthSq > 0 ? Math.min(1, Math.max(0, ((px - a[0]) * dx + (py - a[1]) * dy) / lengthSq)) : 0;
      const [ex, ey] = [a[0] + dx * t - px, a[1] + dy * t - py];
      if (ex * ex + ey * ey <= half * half) {
        cells[y * size + x] = value;
      }
    }
  }
}

function boxes(tile: Tile, minArea: number): FarBox[] {
  const result: FarBox[] = [];
  for (const building of tile.buildings) {
    const outer = building.polygon.outer;
    if (building.hasParts || outer.length < 3 || building.height <= building.minHeight) {
      continue;
    }
    const { angle, length, width } = orientedBox(outer);
    if (length * width < minArea) {
      continue;
    }
    // the box's centre: halfway between the outline's extremes along and across its long side
    const along: Point = [Math.cos(angle), Math.sin(angle)];
    const across: Point = [-along[1], along[0]];
    let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const [e, n] of outer) {
      const u = e * along[0] + n * along[1];
      const v = e * across[0] + n * across[1];
      [u0, u1, v0, v1] = [Math.min(u0, u), Math.max(u1, u), Math.min(v0, v), Math.max(v1, v)];
    }
    const [u, v] = [(u0 + u1) / 2, (v0 + v1) / 2];
    const box: FarBox = {
      center: [u * along[0] + v * across[0], u * along[1] + v * across[1]],
      angle,
      length,
      width,
      minHeight: building.minHeight,
      height: building.height,
    };
    if (building.base !== undefined) {
      box.base = building.base;
    }
    if (building.colour !== undefined) {
      box.colour = building.colour;
    }
    if (building.roofColour !== undefined) {
      box.roofColour = building.roofColour;
    }
    result.push(box);
  }
  return result;
}

/** The heights resampled (bilinear) to count × count points over the tile, edges included. */
function coarseHeights(heights: Heights, tileSize: number, count: number): Heights {
  const step = tileSize / (count - 1);
  const values: number[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      values.push(Math.round(heightAt(heights, col * step, row * step)));
    }
  }
  return { step, count, values };
}

/** Decimeters above sea level at e, n meters from the grid's south-west corner (clamped to the grid). */
function heightAt(heights: Heights, e: number, n: number): number {
  const last = heights.count - 1;
  const fc = Math.min(last, Math.max(0, e / heights.step));
  const fr = Math.min(last, Math.max(0, n / heights.step));
  const c0 = Math.min(Math.floor(fc), last - 1);
  const r0 = Math.min(Math.floor(fr), last - 1);
  const [tc, tr] = [fc - c0, fr - r0];
  const at = (r: number, c: number) => heights.values[r * heights.count + c];
  const south = at(r0, c0) + (at(r0, c0 + 1) - at(r0, c0)) * tc;
  const north = at(r0 + 1, c0) + (at(r0 + 1, c0 + 1) - at(r0 + 1, c0)) * tc;
  return south + (north - south) * tr;
}
