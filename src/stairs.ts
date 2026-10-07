// Steps mapped as a building part (building:part=steps under a skillion roof, the slope they climb) show the steps
// themselves: a way of steps (highway=steps) inside them is left out, so the steps are not in the map twice.
import { distanceToRing, pointInRing, type Point, type Ring } from "./geometry.ts";
import type { Building, Road } from "./osm.ts";

/** A way's points this close to the part's outline (m) are on it: OSM draws the way between its points */
const ON_PART_M = 0.3;
/** A way is looked at this often along its line (m) */
const STEP_M = 0.5;

/** Whether a building is steps mapped as a part, with a skillion roof telling which way they climb */
export function isStepsPart(b: Building): boolean {
  return b.kind === "steps" && b.roofShape === "skillion";
}

/** Takes the ways of steps inside steps mapped as a part out of roads; returns how many */
export function dropStepsInParts(roads: Road[], buildings: Building[]): number {
  const outlines = buildings.filter(isStepsPart).map((b) => b.polygon.outer);
  const kept = roads.filter((r) => r.kind !== "steps" || !outlines.some((ring) => lineOnRing(r.line, ring)));
  const dropped = roads.length - kept.length;
  roads.splice(0, roads.length, ...kept);
  return dropped;
}

/** Whether a line is inside a ring, or no further than ON_PART_M out of it, all along */
function lineOnRing(line: Point[], ring: Ring): boolean {
  for (let i = 0; i + 1 < line.length; i++) {
    const [a, b] = [line[i], line[i + 1]];
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / STEP_M));
    for (let k = i === 0 ? 0 : 1; k <= steps; k++) {
      const p: Point = [a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps];
      if (!pointInRing(p, ring) && distanceToRing(p, ring) > ON_PART_M) {
        return false;
      }
    }
  }
  return line.length >= 2;
}
