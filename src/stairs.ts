// Steps mapped as a building part (building:part=steps under a skillion roof, the slope they climb) show the steps
// themselves: a way of steps (highway=steps) inside them is left out, so the steps are not in the map twice.
// A staircase whose landings the elevation model puts out of line climbs one riser all the way instead.
import { distanceToRing, pointInRing, pointKey, type Point, type Ring } from "./geometry.ts";
import type { Building, Road } from "./osm.ts";

/** A way's points this close to the part's outline (m) are on it: OSM draws the way between its points */
const ON_PART_M = 0.3;
/** A way is looked at this often along its line (m) */
const STEP_M = 0.5;
/** A flight climbing less than this part of its share of its staircase's rise has a landing out of line */
const LANDING_SHARE = 0.25;

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

/** A flight of a staircase in the order the staircase runs, reversed where its line runs the other way */
interface Flight {
  road: Road;
  reversed: boolean;
}

/**
 * Sets `deck` on the flights of staircases whose landings the elevation model puts out of line: ways of steps joined
 * end to end at points no other way has, each telling its count and the way it climbs (`stepCount`, `incline`), all
 * climbing the same way. Where a flight climbs less than a quarter of its share of the staircase's rise (by its
 * count) between the ground at its ends, or goes down (a landing beside a wall or a cliff the model has lower), the
 * landings are at the heights the counts share out between the staircase's ends (the ground there, or a deck's
 * height): one riser all the way, each flight straight along its line. A staircase with a flight on a bridge, on a
 * deck or in a tunnel is left as it is. Returns how many staircases got decks.
 */
export function setStaircaseDecks(roads: Road[], heightAt: (e: number, n: number) => number | undefined): number {
  const atPoint = new Map<string, Road[]>();
  for (const r of roads) {
    for (const k of new Set(r.line.map(pointKey))) {
      atPoint.set(k, [...(atPoint.get(k) ?? []), r]);
    }
  }
  const first = (r: Road) => r.line[0];
  const last = (r: Road) => r.line[r.line.length - 1];
  const isEnd = (r: Road, p: Point) => pointKey(first(r)) === pointKey(p) || pointKey(last(r)) === pointKey(p);
  const isSteps = (r: Road) => r.kind === "steps" && r.line.length >= 2 && pointKey(first(r)) !== pointKey(last(r));
  // the flight on from r at its end p: a landing only two ways of steps end at
  const onward = (r: Road, p: Point): Road | undefined => {
    const there = atPoint.get(pointKey(p)) ?? [];
    const other = there.find((o) => o !== r);
    return there.length === 2 && other && isSteps(other) && isEnd(other, p) ? other : undefined;
  };
  // a flight's ends in the order the staircase runs
  const entry = (f: Flight) => (f.reversed ? last(f.road) : first(f.road));
  const exit = (f: Flight) => (f.reversed ? first(f.road) : last(f.road));
  // at a staircase's end, a deck's height there, else the ground's
  const endHeight = (p: Point) => {
    for (const r of atPoint.get(pointKey(p)) ?? []) {
      const i = r.line.findIndex((q) => pointKey(q) === pointKey(p));
      if (r.deck && i >= 0) {
        return r.deck[i];
      }
    }
    return heightAt(...p);
  };

  const done = new Set<Road>();
  let count = 0;
  for (const start of roads) {
    if (!isSteps(start) || done.has(start)) {
      continue;
    }
    done.add(start);
    const flights: Flight[] = [{ road: start, reversed: false }];
    let looped = false;
    for (const forward of [true, false]) {
      for (;;) {
        const edge = forward ? flights[flights.length - 1] : flights[0];
        const at = forward ? exit(edge) : entry(edge);
        const next = onward(edge.road, at);
        if (!next || done.has(next)) {
          looped ||= next !== undefined;
          break;
        }
        done.add(next);
        const startsThere = pointKey(first(next)) === pointKey(at);
        if (forward) {
          flights.push({ road: next, reversed: !startsThere });
        } else {
          flights.unshift({ road: next, reversed: startsThere });
        }
      }
    }
    // each flight telling its count and the way it climbs, all the same way along the staircase
    const telling = flights.every(
      ({ road: r }) => !r.bridge && !r.tunnel && !r.deck && !r.floor && !r.lid && (r.stepCount ?? 0) > 0 && r.incline !== undefined,
    );
    const climbs = flights.map(({ road: r, reversed }) => (r.incline === "up" ? 1 : -1) * (reversed ? -1 : 1));
    if (looped || flights.length < 2 || !telling || climbs.some((c) => c !== climbs[0])) {
      continue;
    }
    // the heights at the staircase's ends and at its landings between
    const points = [entry(flights[0]), ...flights.map(exit)];
    const ground: number[] = [];
    for (const [i, p] of points.entries()) {
      const h = i === 0 || i === points.length - 1 ? endHeight(p) : heightAt(...p);
      if (h === undefined) {
        break;
      }
      ground.push(h);
    }
    if (ground.length < points.length) {
      continue;
    }
    const [from, to] = [ground[0], ground[ground.length - 1]];
    const rise = (to - from) * climbs[0];
    const counts = flights.map(({ road: r }) => r.stepCount ?? 0);
    const total = counts.reduce((a, b) => a + b, 0);
    const outOfLine = counts.some((c, i) => (ground[i + 1] - ground[i]) * climbs[0] < (LANDING_SHARE * rise * c) / total);
    if (rise <= 0 || !outOfLine) {
      continue;
    }
    let passed = 0;
    const landing = () => from + ((to - from) * passed) / total;
    for (const [i, { road: r, reversed }] of flights.entries()) {
      const before = landing();
      passed += counts[i];
      const after = landing();
      const [a, b] = reversed ? [after, before] : [before, after];
      const along = [0];
      for (let k = 1; k < r.line.length; k++) {
        along.push(along[k - 1] + Math.hypot(r.line[k][0] - r.line[k - 1][0], r.line[k][1] - r.line[k - 1][1]));
      }
      const length = along[along.length - 1];
      r.deck = along.map((d) => (length > 0 ? a + ((b - a) * d) / length : b));
    }
    count++;
  }
  return count;
}
