// Flights of steps over an edge the elevation model smooths. A few risers up a slab or a terrace climb a step the
// model's 2 m grid has as a slope several meters wide, so a flight's ends are partway up it and climb less than its
// risers do. Where a straight flight with a step count (step_count) climbs much less in the model than its risers, the
// ground steps along it: behind its top raised to the top found in the model a few meters on, under it straight down
// to its foot, and past its foot lowered to the foot found a few meters on.
import type { Point } from "./geometry.ts";
import type { Road } from "./osm.ts";

/** Risers are at least this tall (m): a flight climbing less than its count of them in the model is smoothed */
const MIN_RISER_M = 0.12;
/** Nor taller than this (m): where the ground found past the ends is further apart, a slope goes on, and nothing steps */
const MAX_RISER_M = 0.2;
/** The ground past the ends is looked at this far on (m), at these steps */
const LOOK_M = 4;
const LOOK_STEP_M = 1;
/** It must climb this much more (m) than the model between the ends, or nothing steps */
const MORE_M = 0.2;
/** The ground is raised or lowered this far past the ends (m) */
const REACH_M = 3;
/** Beside the flight's width it is eased in over this much (m) */
const SIDE_EASE_M = 1;
/** A flight's points are at most this far off the line between its ends (m), or it turns and nothing steps */
const STRAIGHT_M = 0.5;
/** The flights are looked up in squares this big (m) */
const CELL_M = 50;

export interface FlightStep {
  /** The steps' OSM element */
  way: string;
  /** The top and the foot of the flight, and half its width (m) */
  top: Point;
  foot: Point;
  half: number;
  /** The ground at the top and at the foot (m above sea level) */
  topHeight: number;
  footHeight: number;
}

/** The flights of steps (`highway=steps`) whose ground steps, with the model's heights from `heightAt` */
export function flightSteps(roads: readonly Road[], heightAt: (e: number, n: number) => number | undefined): FlightStep[] {
  const flights: FlightStep[] = [];
  for (const way of roads) {
    const count = way.stepCount;
    if (way.kind !== "steps" || count === undefined || way.tunnel || way.bridge || way.layer !== 0 || way.line.length < 2) {
      continue;
    }
    const [a, c] = [way.line[0], way.line[way.line.length - 1]];
    const length = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (length === 0) {
      continue;
    }
    const [ue, un] = [(c[0] - a[0]) / length, (c[1] - a[1]) / length];
    if (way.line.some(([e, n]) => Math.abs((e - a[0]) * un - (n - a[1]) * ue) > STRAIGHT_M)) {
      continue;
    }
    const [ha, hc] = [heightAt(...a), heightAt(...c)];
    if (ha === undefined || hc === undefined || Math.abs(ha - hc) >= count * MIN_RISER_M) {
      continue;
    }
    const [top, foot, out] = ha >= hc ? [a, c, -1] : [c, a, 1];
    // the ground found on past the top, away from the foot, and past the foot
    const past = (from: Point, sign: number) => {
      const heights: number[] = [];
      for (let d = LOOK_STEP_M; d <= LOOK_M; d += LOOK_STEP_M) {
        const h = heightAt(from[0] + ue * sign * d, from[1] + un * sign * d);
        if (h !== undefined) {
          heights.push(h);
        }
      }
      return heights;
    };
    const topHeight = Math.max(Math.max(ha, hc), ...past(top, out));
    const footHeight = Math.min(Math.min(ha, hc), ...past(foot, -out));
    const climb = topHeight - footHeight;
    if (climb < Math.abs(ha - hc) + MORE_M || climb > count * MAX_RISER_M) {
      continue;
    }
    flights.push({ way: way.osm, top, foot, half: way.width / 2, topHeight, footHeight });
  }
  return flights;
}

/** `heightAt` with the ground stepped along the flights */
export function stepAtFlights(
  heightAt: (e: number, n: number) => number | undefined,
  flights: readonly FlightStep[],
): (e: number, n: number) => number | undefined {
  if (flights.length === 0) {
    return heightAt;
  }
  const cells = new Map<string, FlightStep[]>();
  const cell = (e: number, n: number) => `${Math.floor(e / CELL_M)},${Math.floor(n / CELL_M)}`;
  for (const flight of flights) {
    const reach = REACH_M + flight.half + SIDE_EASE_M;
    const [minE, maxE] = [Math.min(flight.top[0], flight.foot[0]) - reach, Math.max(flight.top[0], flight.foot[0]) + reach];
    const [minN, maxN] = [Math.min(flight.top[1], flight.foot[1]) - reach, Math.max(flight.top[1], flight.foot[1]) + reach];
    for (let i = Math.floor(minE / CELL_M); i <= Math.floor(maxE / CELL_M); i++) {
      for (let j = Math.floor(minN / CELL_M); j <= Math.floor(maxN / CELL_M); j++) {
        const k = `${i},${j}`;
        cells.set(k, [...(cells.get(k) ?? []), flight]);
      }
    }
  }
  return (e, n) => {
    let height = heightAt(e, n);
    if (height === undefined) {
      return height;
    }
    for (const { top, foot, half, topHeight, footHeight } of cells.get(cell(e, n)) ?? []) {
      const length = Math.hypot(foot[0] - top[0], foot[1] - top[1]);
      const [ue, un] = [(foot[0] - top[0]) / length, (foot[1] - top[1]) / length];
      const along = (e - top[0]) * ue + (n - top[1]) * un;
      const side = Math.abs((e - top[0]) * un - (n - top[1]) * ue);
      if (along < -REACH_M || along > length + REACH_M || side > half + SIDE_EASE_M) {
        continue;
      }
      const target =
        along < 0
          ? Math.max(height, topHeight)
          : along <= length
            ? topHeight + ((footHeight - topHeight) * along) / length
            : Math.min(height, footHeight);
      const share = side <= half ? 1 : 1 - (side - half) / SIDE_EASE_M;
      height += (target - height) * share;
    }
    return height;
  };
}
