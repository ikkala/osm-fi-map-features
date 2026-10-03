// Splits map features into square tiles. Tile (x, y) covers east x*size ... (x+1)*size and north
// y*size ... (y+1)*size meters from the map origin. Lines and areas are cut at tile edges; buildings,
// points and bridge deck pieces belong whole to the tile of their centre.
import { deckAt } from "./bridges.ts";
import { clipPolygon, clipPolyline, ringCentroid, simplifyRing, type Point, type Polygon, type Rect } from "./geometry.ts";
import {
  bounds,
  type Area,
  type Barrier,
  type BridgeDeck,
  type Building,
  type Crossing,
  type Gate,
  type MapFeatures,
  type Rail,
  type Road,
  type StreetLamp,
  type TrafficSignal,
  type Tree,
} from "./osm.ts";

export interface TileKey {
  x: number;
  y: number;
}

/** Ground heights on a square grid over the tile, edges included. */
export interface Heights {
  /** Meters between grid points */
  step: number;
  /** Grid points along each side */
  count: number;
  /** Decimeters above sea level (N2000), row by row from the south-west corner, eastward then northward */
  values: number[];
}

export interface Tile extends TileKey, MapFeatures {
  heights?: Heights;
}

/** Areas are simplified to this many meters before cutting. */
const AREA_TOLERANCE_M = 0.25;

export function tileName(tile: TileKey): string {
  return `${tile.x}_${tile.y}`;
}

export function tileRect(tile: TileKey, size: number): Rect {
  return { minX: tile.x * size, minY: tile.y * size, maxX: (tile.x + 1) * size, maxY: (tile.y + 1) * size };
}

/** The tiles that a rectangle touches, west to east within south to north. */
export function tilesCovering(rect: Rect, size: number): TileKey[] {
  const tiles: TileKey[] = [];
  const range = tileRange(rect, size);
  for (let y = range.minY; y <= range.maxY; y++) {
    for (let x = range.minX; x <= range.maxX; x++) {
      tiles.push({ x, y });
    }
  }
  return tiles;
}

function tileRange(rect: Rect, size: number): Rect {
  // a rectangle ending exactly on a tile edge does not reach into the next tile
  return {
    minX: Math.floor(rect.minX / size),
    minY: Math.floor(rect.minY / size),
    maxX: Math.ceil(rect.maxX / size) - 1,
    maxY: Math.ceil(rect.maxY / size) - 1,
  };
}

/** The deck, lid, floor and track bed heights of a piece clipped out of a line */
function clippedDeck(
  feature: { line: Point[]; deck?: number[]; lid?: number[]; floor?: number[]; bed?: number[] },
  piece: Point[],
): { deck?: number[]; lid?: number[]; floor?: number[]; bed?: number[] } {
  const { deck, lid, floor, bed } = feature;
  return {
    ...(deck && { deck: piece.map((p) => deckAt(feature.line, deck, p)) }),
    ...(lid && { lid: piece.map((p) => deckAt(feature.line, lid, p)) }),
    ...(floor && { floor: piece.map((p) => deckAt(feature.line, floor, p)) }),
    ...(bed && { bed: piece.map((p) => deckAt(feature.line, bed, p)) }),
  };
}

/** Distributes features into the given tiles; features outside them are dropped. */
export function cutIntoTiles(features: MapFeatures, keys: TileKey[], size: number): Tile[] {
  const tiles = new Map<string, Tile>();
  for (const key of keys) {
    tiles.set(tileName(key), { ...key, roads: [], rails: [], buildings: [], areas: [], trees: [], lamps: [], crossings: [], signals: [], gates: [], barriers: [], bridgeDecks: [] });
  }
  const touched = (points: Point[]) => {
    const range = tileRange(bounds(points), size);
    const result: Tile[] = [];
    for (let y = range.minY; y <= range.maxY; y++) {
      for (let x = range.minX; x <= range.maxX; x++) {
        const tile = tiles.get(tileName({ x, y }));
        if (tile) {
          result.push(tile);
        }
      }
    }
    return result;
  };

  for (const road of features.roads) {
    for (const tile of touched(road.line)) {
      for (const line of clipPolyline(road.line, tileRect(tile, size))) {
        const { footfall, cycling } = road;
        tile.roads.push({
          ...road,
          line,
          ...clippedDeck(road, line),
          ...(footfall && { footfall: line.map((p) => Math.round(deckAt(road.line, footfall, p))) }),
          ...(cycling && { cycling: line.map((p) => Math.round(deckAt(road.line, cycling, p))) }),
        } satisfies Road);
      }
    }
  }
  for (const rail of features.rails) {
    for (const tile of touched(rail.line)) {
      for (const line of clipPolyline(rail.line, tileRect(tile, size))) {
        tile.rails.push({ ...rail, line, ...clippedDeck(rail, line) } satisfies Rail);
      }
    }
  }
  for (const building of features.buildings) {
    const [cx, cy] = ringCentroid(building.polygon.outer);
    tiles.get(tileName({ x: Math.floor(cx / size), y: Math.floor(cy / size) }))?.buildings.push(building satisfies Building);
  }
  for (const area of features.areas) {
    const simplified: Polygon = {
      outer: simplifyRing(area.polygon.outer, AREA_TOLERANCE_M),
      holes: area.polygon.holes.map((hole) => simplifyRing(hole, AREA_TOLERANCE_M)),
    };
    for (const tile of touched(simplified.outer)) {
      const polygon = clipPolygon(simplified, tileRect(tile, size));
      if (polygon) {
        tile.areas.push({ ...area, polygon } satisfies Area);
      }
    }
  }
  for (const tree of features.trees) {
    const [e, n] = tree.point;
    tiles.get(tileName({ x: Math.floor(e / size), y: Math.floor(n / size) }))?.trees.push(tree satisfies Tree);
  }
  const tileAt = ([e, n]: Point) => tiles.get(tileName({ x: Math.floor(e / size), y: Math.floor(n / size) }));
  for (const lamp of features.lamps) {
    tileAt(lamp.point)?.lamps.push(lamp satisfies StreetLamp);
  }
  for (const crossing of features.crossings) {
    tileAt(crossing.point)?.crossings.push(crossing satisfies Crossing);
  }
  for (const signal of features.signals) {
    tileAt(signal.point)?.signals.push(signal satisfies TrafficSignal);
  }
  for (const gate of features.gates) {
    tileAt(gate.point)?.gates.push(gate satisfies Gate);
  }
  for (const barrier of features.barriers) {
    for (const tile of touched(barrier.line)) {
      for (const line of clipPolyline(barrier.line, tileRect(tile, size))) {
        tile.barriers.push({ ...barrier, line } satisfies Barrier);
      }
    }
  }

  for (const deck of features.bridgeDecks) {
    const [e, n] = deck.vertices.reduce(([se, sn], [ve, vn]) => [se + ve, sn + vn], [0, 0]);
    tileAt([e / deck.vertices.length, n / deck.vertices.length])?.bridgeDecks.push(deck satisfies BridgeDeck);
  }

  const byOsmId = (a: { osm: string }, b: { osm: string }) => compareOsmIds(a.osm, b.osm);
  // trees, lamps and the points on ways have no ids: south to north, then west to east
  const byPlace = (a: { point: Point }, b: { point: Point }) => a.point[1] - b.point[1] || a.point[0] - b.point[0];
  for (const tile of tiles.values()) {
    tile.roads.sort(byOsmId);
    tile.rails.sort(byOsmId);
    tile.buildings.sort(byOsmId);
    tile.areas.sort(byOsmId);
    tile.trees.sort(byPlace);
    tile.lamps.sort(byPlace);
    tile.crossings.sort(byPlace);
    tile.signals.sort(byPlace);
    tile.gates.sort(byPlace);
    tile.barriers.sort(byOsmId);
    tile.bridgeDecks.sort(byOsmId);
  }
  return [...tiles.values()];
}

/**
 * Samples ground heights over a tile. heightAt takes meters east / north of the map origin; points
 * where it has no height get the tile's average, and are counted in `missing`.
 */
export function tileHeights(
  tile: TileKey,
  size: number,
  step: number,
  heightAt: (e: number, n: number) => number | undefined,
): { heights: Heights; missing: number } {
  const count = Math.round(size / step) + 1;
  const spacing = size / (count - 1);
  const samples: (number | undefined)[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      samples.push(heightAt(tile.x * size + col * spacing, tile.y * size + row * spacing));
    }
  }
  const valid = samples.filter((h) => h !== undefined);
  const average = valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
  return {
    heights: { step: spacing, count, values: samples.map((h) => Math.round((h ?? average) * 10)) },
    missing: samples.length - valid.length,
  };
}

/** Orders "w12" before "w100" and ways before relations; stable for pieces of one element. */
function compareOsmIds(a: string, b: string): number {
  return a[0] === b[0] ? Number(a.slice(1)) - Number(b.slice(1)) : a < b ? 1 : -1;
}

/** toTm over a tile, bilinearly interpolated from a lattice of points about `spacing` apart. */
export function latticeProjection(
  tile: TileKey,
  size: number,
  spacing: number,
  toTm: (e: number, n: number) => [number, number],
): (e: number, n: number) => [number, number] {
  const cells = Math.max(1, Math.round(size / spacing));
  const step = size / cells;
  const x0 = tile.x * size;
  const y0 = tile.y * size;
  const lattice: [number, number][] = [];
  for (let row = 0; row <= cells; row++) {
    for (let col = 0; col <= cells; col++) {
      lattice.push(toTm(x0 + col * step, y0 + row * step));
    }
  }
  const at = (col: number, row: number) => lattice[row * (cells + 1) + col];
  return (e, n) => {
    const u = (e - x0) / step;
    const v = (n - y0) / step;
    const col = Math.min(Math.max(Math.floor(u), 0), cells - 1);
    const row = Math.min(Math.max(Math.floor(v), 0), cells - 1);
    const s = u - col;
    const t = v - row;
    const [a, b, c, d] = [at(col, row), at(col + 1, row), at(col, row + 1), at(col + 1, row + 1)];
    return [
      (1 - t) * ((1 - s) * a[0] + s * b[0]) + t * ((1 - s) * c[0] + s * d[0]),
      (1 - t) * ((1 - s) * a[1] + s * b[1]) + t * ((1 - s) * c[1] + s * d[1]),
    ];
  };
}
