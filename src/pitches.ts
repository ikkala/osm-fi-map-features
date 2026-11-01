// Sports pitches (leisure=pitch), and level ground. A pitch, a parking lot or a square is level where it can be: one
// whose ground the elevation model has level but for a little (a pitch or a paved area) gets one height, its top, the
// ground's median inside its outline, as a railway platform does (platforms.ts); one on a slope (a ski jump's, a
// sloping square) keeps the model's ground. A pitch outdoors mapped as a rectangle also goes to the tiles' pitches,
// with its sports and the box it fills.
import { bounds, type Area, type AreaKind, type Building } from "./osm.ts";
import { boxCentre, orientedBox, pointInPolygon, RectGrid, ringArea, ringCentroid, type Point, type Polygon } from "./geometry.ts";
import { groundInside } from "./platforms.ts";

export interface Pitch {
  osm: string;
  /** sport=* in lower case, its values in their order (soccer, tennis, basketball, ...); empty when not tagged */
  sports: string[];
  /** surface=*, when OSM tells */
  surface?: string;
  /** The middle of the box it fills, meters east and north of the origin */
  point: Point;
  /** The direction of the box's long side, radians counter-clockwise from east, 0 .. pi */
  angle: number;
  /** The box's length and width (m) */
  length: number;
  width: number;
  /** Its area's top, when it is level (m above sea level) */
  top?: number;
}

/** A pitch as parsed (osm.ts), before it gets its box */
export interface PitchOutline {
  osm: string;
  sports: string[];
  surface?: string;
  /** Tagged as indoors or covered */
  indoor: boolean;
  polygon: Polygon;
}

/** Areas of these kinds are level when they can be */
const LEVEL_KINDS = new Set<AreaKind>(["pitch", "paved"]);
/** An area is level when all but the highest and lowest OUTLIER_SHARE of its ground's heights lie within this (m) */
const LEVEL_WITHIN_M = 0.6;
const OUTLIER_SHARE = 0.05;
/** A pitch is a rectangle when its outline fills this share of its box */
const RECTANGLE_SHARE = 0.85;
/** A pitch shorter than this (m) is left out of the pitches */
const MIN_LENGTH_M = 4;

/** Sets `top` on the pitches and paved areas that are level. Returns how many got one. */
export function setLevelTops(areas: Area[], heightAt: (e: number, n: number) => number | undefined): number {
  let count = 0;
  for (const area of areas) {
    if (!LEVEL_KINDS.has(area.kind)) {
      continue;
    }
    const heights = groundInside(area.polygon, heightAt);
    if (heights.length === 0) {
      continue;
    }
    const cut = Math.floor(heights.length * OUTLIER_SHARE);
    if (heights[heights.length - 1 - cut] - heights[cut] <= LEVEL_WITHIN_M) {
      area.top = heights[Math.floor(heights.length / 2)];
      count++;
    }
  }
  return count;
}

/**
 * The pitches of the outlines outdoors (not tagged so, nor with their middle in a building) that are rectangles, each
 * with its area's top (setLevelTops first).
 */
export function pitchBoxes(outlines: PitchOutline[], areas: Area[], buildings: Building[]): Pitch[] {
  if (outlines.length === 0) {
    return [];
  }
  const tops = new Map(areas.flatMap((area) => (area.kind === "pitch" && area.top !== undefined ? [[area.osm, area.top] as const] : [])));
  const over = bounds(outlines.flatMap((outline) => outline.polygon.outer));
  const grid = new RectGrid<Building>(100, over);
  for (const building of buildings) {
    if (!building.part) {
      grid.add(bounds(building.polygon.outer), building);
    }
  }
  const pitches: Pitch[] = [];
  for (const { osm, sports, surface, indoor, polygon } of outlines) {
    const outer = polygon.outer;
    const { angle, length, width } = orientedBox(outer);
    const middle = ringCentroid(outer);
    if (indoor || length < MIN_LENGTH_M || Math.abs(ringArea(outer)) < RECTANGLE_SHARE * length * width) {
      continue;
    }
    if (grid.at(middle).some((building) => pointInPolygon(middle, building.polygon))) {
      continue;
    }
    const top = tops.get(osm);
    pitches.push({ osm, sports, ...(surface && { surface }), point: boxCentre(outer, angle), angle, length, width, ...(top !== undefined && { top }) });
  }
  return pitches;
}
