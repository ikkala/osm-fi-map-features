// The height buildings stand at on sloping ground. A building with an entrance in OSM stands at the ground
// by it (entrance=main first), others at their highest ground, so that an entrance on the uphill side is
// not in the hill. The walls reach down to the lowest ground: on the downhill side a building has a plinth
// or a basement storey, as real buildings on slopes do.
import { pointInPolygon, ringCentroid, type Ring } from "./geometry.ts";
import { bounds, type Building, type Entrance } from "./osm.ts";

/** A building stands at most this far above its lowest ground (m), so it does not tower on a steep slope */
export const MAX_PLINTH_M = 6;
/** Ground heights are sampled at the outline's corners and this often along its edges (m) */
const SAMPLE_M = 2;
/** Entrances that say nothing of the floor: often down to a basement or up a ramp */
const NOT_FLOOR_ENTRANCES = new Set(["service", "emergency", "exit", "garage", "underground"]);

/**
 * Sets every building's base (m above sea level): the ground at its OSM entrance (a main one first), or
 * else its highest ground; at most MAX_PLINTH_M above its lowest ground and not above its highest. A part gets the base of the building it is in, so its parts stand on one floor. Open shelters
 * stand on their lowest ground and get none. heightAt gives the ground height at map meters (undefined
 * outside the elevation model). Returns how many buildings got a base.
 */
export function setBuildingBases(buildings: Building[], heightAt: (e: number, n: number) => number | undefined): number {
  const baseOf = (b: Building, entrances: Entrance[]) => {
    const range = groundRange(b.polygon.outer, heightAt);
    if (!range) {
      return undefined;
    }
    const top = Math.min(range.high, range.low + MAX_PLINTH_M);
    const mapped = entrances.filter((e) => !e.guessed && !NOT_FLOOR_ENTRANCES.has(e.kind));
    const door = mapped.find((e) => e.kind === "main") ?? mapped[0];
    const atDoor = door && heightAt(...door.at);
    return atDoor === undefined ? top : Math.max(range.low, Math.min(top, atDoor));
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
  let count = 0;
  for (const b of buildings) {
    delete b.base;
    if (b.shelter !== undefined) {
      continue;
    }
    const outline = partOutline.get(b) ?? outlines.find((o) => o.b === b);
    const base = outline ? outlineBases.get(outline) : baseOf(b, b.entrances ?? []);
    if (base !== undefined) {
      b.base = base;
      count++;
    }
  }
  return count;
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
