// The height buildings stand at on sloping ground: at an OSM entrance, else at their highest ground, with
// walls down to the lowest ground (a plinth or basement on the downhill side).
import { pointInPolygon, ringCentroid, type Point, type Ring } from "./geometry.ts";
import { bounds, LEVEL_HEIGHT_M, type Area, type Building, type Entrance } from "./osm.ts";

/** A building stands at most this far above its lowest ground (m), so it does not tower on a steep slope */
export const MAX_PLINTH_M = 6;
/** Ground heights are sampled at the outline's corners and this often along its edges (m) */
const SAMPLE_M = 2;
/** Entrances that say nothing of the floor: often down to a basement or up a ramp */
const NOT_FLOOR_ENTRANCES = new Set(["service", "emergency", "exit", "garage", "underground"]);
/** A door has at least this much room over the ground by it under the roof (m) */
const ROOM_OVER_DOOR_M = 2.5;

/**
 * Sets every building's base (m above sea level): the ground at its OSM entrance (a main one first), else its
 * highest ground; at most MAX_PLINTH_M above its lowest ground, and at least the top of any tunnel lid under it.
 * Parts share the base of their outline. A building lower than ROOM_OVER_DOOR_M over the ground at one of its
 * doors (a stair hall up a slope) is made taller and pushed to raised. A building or part with a minHeight and
 * nothing under it counts that minHeight from its own highest ground. Open shelters get a base only on a lid or
 * a railway platform (an area with a top) under them. Returns how many buildings got a base.
 */
export function setBuildingBases(
  buildings: Building[],
  heightAt: (e: number, n: number) => number | undefined,
  lids: { line: Point[]; lid: number[] }[] = [],
  raised: Building[] = [],
  platforms: Area[] = [],
): number {
  const baseOf = (b: Building, entrances: Entrance[]) => {
    const range = groundRange(b.polygon.outer, heightAt);
    if (!range) {
      return undefined;
    }
    const top = Math.min(range.high, range.low + MAX_PLINTH_M);
    const mapped = entrances.filter((e) => !e.guessed && !NOT_FLOOR_ENTRANCES.has(e.kind));
    const door = mapped.find((e) => e.kind === "main") ?? mapped[0];
    const atDoor = door && heightAt(...door.at);
    const base = atDoor === undefined ? top : Math.max(range.low, Math.min(top, atDoor));
    return Math.max(base, lidUnder(b, lids));
  };
  // an outline with parts: its entrances and those on its parts
  const outlines = buildings.filter((b) => b.hasParts).map((b) => ({ b, box: bounds(b.polygon.outer), entrances: [...(b.entrances ?? [])] }));
  const outlineOf = (part: Building) => {
    const [x, y] = ringCentroid(part.polygon.outer);
    return outlines.find(({ b: o, box }) => x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && pointInPolygon([x, y], o.polygon));
  };
  const partOutline = new Map<Building, (typeof outlines)[number]>();
  for (const b of buildings) {
    const outline = b.part ? outlineOf(b) : undefined;
    if (outline) {
      partOutline.set(b, outline);
      outline.entrances.push(...(b.entrances ?? []));
    }
  }
  const outlineBases = new Map(outlines.map((o) => [o, baseOf(o.b, o.entrances)]));
  // what is drawn (not the outlines with parts), to see whether anything stands under a raised building
  const drawn = buildings.filter((b) => !b.hasParts).map((b) => ({ b, box: bounds(b.polygon.outer) }));
  const floating = (b: Building) => {
    const [x, y] = ringCentroid(b.polygon.outer);
    return !drawn.some(
      ({ b: o, box }) =>
        o !== b && o.minHeight < b.minHeight && x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && pointInPolygon([x, y], o.polygon),
    );
  };
  let count = 0;
  for (const b of buildings) {
    delete b.base;
    if (b.shelter !== undefined) {
      // on a lid, so its posts do not reach down into the tunnel, or on a platform, its roof over the platform
      const under = Math.max(lidUnder(b, lids), platformUnder(b, platforms));
      if (Number.isFinite(under)) {
        b.base = under;
        count++;
      }
      continue;
    }
    const outline = partOutline.get(b) ?? outlines.find((o) => o.b === b);
    const base = outline ? outlineBases.get(outline) : baseOf(b, b.entrances ?? []);
    if (base !== undefined) {
      b.base = base;
      count++;
      const high = b.minHeight > 0 && !b.hasParts ? groundRange(b.polygon.outer, heightAt)?.high : undefined;
      if (high !== undefined && high > base && floating(b)) {
        const thickness = b.height - b.minHeight;
        b.minHeight += high - base;
        b.height = Math.max(b.height, b.minHeight + Math.min(thickness, LEVEL_HEIGHT_M));
      }
      if (!b.part) {
        const doors = (b.entrances ?? []).filter((e) => !e.guessed).map((e) => heightAt(...e.at)).filter((h) => h !== undefined);
        const door = Math.max(...doors);
        if (doors.length > 0 && base + b.height < door + ROOM_OVER_DOOR_M) {
          b.height = door - base + b.height;
          raised.push(b);
        }
      }
    }
  }
  return count;
}

/** The highest top of the platforms under a building (its outline sampled), or -Infinity */
function platformUnder(b: Building, platforms: Area[]): number {
  const box = bounds(b.polygon.outer);
  let top = -Infinity;
  for (const platform of platforms) {
    if (platform.top === undefined || platform.top <= top) {
      continue;
    }
    const p = bounds(platform.polygon.outer);
    if (p.maxX < box.minX || p.minX > box.maxX || p.maxY < box.minY || p.minY > box.maxY) {
      continue;
    }
    const samples = [ringCentroid(b.polygon.outer), ...alongRing(b.polygon.outer)];
    if (samples.some((s) => pointInPolygon(s, platform.polygon))) {
      top = platform.top;
    }
  }
  return top;
}

/** The ring's corners and points every SAMPLE_M along its edges */
function alongRing(ring: Ring): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < ring.length; i++) {
    const [a, c] = [ring[i], ring[(i + 1) % ring.length]];
    const steps = Math.max(1, Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / SAMPLE_M));
    for (let k = 0; k < steps; k++) {
      points.push([a[0] + ((c[0] - a[0]) * k) / steps, a[1] + ((c[1] - a[1]) * k) / steps]);
    }
  }
  return points;
}

/** The highest top of the lids under a building (sampled along the tunnels), or -Infinity */
function lidUnder(b: Building, lids: { line: Point[]; lid: number[] }[]): number {
  const box = bounds(b.polygon.outer);
  let top = -Infinity;
  for (const { line, lid } of lids) {
    for (let i = 0; i + 1 < line.length; i++) {
      const [a, c] = [line[i], line[i + 1]];
      const steps = Math.max(1, Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / SAMPLE_M));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const p: Point = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t];
        const inBox = p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minY && p[1] <= box.maxY;
        if (inBox && pointInPolygon(p, b.polygon)) {
          top = Math.max(top, lid[i] + (lid[i + 1] - lid[i]) * t);
        }
      }
    }
  }
  return top;
}

/** The lowest and highest ground along a ring, or undefined where the elevation model has none */
function groundRange(ring: Ring, heightAt: (e: number, n: number) => number | undefined): { low: number; high: number } | undefined {
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [a, c] = [ring[i], ring[(i + 1) % ring.length]];
    const steps = Math.max(1, Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / SAMPLE_M));
    for (let k = 0; k < steps; k++) {
      const h = heightAt(a[0] + ((c[0] - a[0]) * k) / steps, a[1] + ((c[1] - a[1]) * k) / steps);
      if (h !== undefined) {
        low = Math.min(low, h);
        high = Math.max(high, h);
      }
    }
  }
  return high >= low ? { low, high } : undefined;
}
