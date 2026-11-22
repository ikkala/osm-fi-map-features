// Retaining walls step the ground. The elevation model's grid smooths a wall into a slope several meters wide,
// and the ways along its foot lean and wobble on it. Beside a retaining wall the ground is taken down to the
// slope's foot on its low side and up to its top on the high side, as far out as the slope reaches, so the
// ground steps at the wall.
import type { Point } from "./geometry.ts";
import { pointKey } from "./geometry.ts";
import type { Barrier } from "./osm.ts";

/** A wall is looked at in stretches this long at most (m) */
export const STRETCH_M = 1;
/** The slope is followed out from a building's wall this far at most on either side (m), a meter at a time (buildingSteps) */
export const REACH_M = 8;
/** And from a retaining wall's this far: the model smooths a high one's step over more, wider still where two meet */
const WALL_REACH_M = 12;
/** The slope ends where the ground climbs or falls less than this a meter, over two meters */
export const FLAT_M = 0.2;
/** A stretch steps the ground only where its sides differ at least this much (m) */
export const MIN_STEP_M = 0.5;
/** A wall turning more than this (rad) between two of its segments starts another leg, which has its own low side */
const LEG_TURN_RAD = Math.PI / 3;
/** At a wall's free end the step eases in over this length (m) */
const EASE_M = 4;
/**
 * A stretch whose slope reaches over OVERREACH_M further in, to a top over RISE_M higher, than stretches of its wall
 * (or of walls joined to it) within BESIDE_M on both sides has ground rising on behind the wall (m)
 */
const OVERREACH_M = 2;
const RISE_M = 1;
const BESIDE_M = 15;
/** Level ground on a wall's low side this far out (m) before the model's slope starts is the wall's foot too */
const LEAD_M = 3;
/** Stretches are looked up in squares this big (m) */
const CELL_M = 16;

/** A stretch of a retaining wall, from a to b, with the ground it holds up on one side and down on the other */
export interface GroundStep {
  /** The wall's OSM element */
  wall: string;
  a: Point;
  b: Point;
  /** The low side: 1 on the left going from a to b, -1 on the right */
  low: 1 | -1;
  /** The slope's foot (m above sea level), and how far out from the wall it is (m): 0 where the model has no step */
  foot: number;
  footOut: number;
  /** The slope's top, and how far in */
  top: number;
  topIn: number;
  /** How much of the step is taken at a and at b: less toward a free end of the wall */
  shareA: number;
  shareB: number;
}

/** The stretches of the retaining walls, with the slopes the elevation model has at them (none where it has no step) */
export function groundSteps(barriers: readonly Barrier[], heightAt: (e: number, n: number) => number | undefined): GroundStep[] {
  const walls = barriers.filter((b) => b.kind === "retaining_wall" && b.line.length >= 2);
  // ends shared by two walls are no free ends
  const ends = new Map<string, number>();
  for (const wall of walls) {
    for (const p of [wall.line[0], wall.line[wall.line.length - 1]]) {
      ends.set(pointKey(p), (ends.get(pointKey(p)) ?? 0) + 1);
    }
  }
  const free = (p: Point) => (ends.get(pointKey(p)) ?? 0) < 2;
  // walls joined end to end make one line
  const joined = walls.map((_, i) => i);
  const root = (i: number): number => (joined[i] === i ? i : (joined[i] = root(joined[i])));
  const endOf = new Map<string, number>();
  for (const [i, wall] of walls.entries()) {
    for (const p of [wall.line[0], wall.line[wall.line.length - 1]]) {
      const other = endOf.get(pointKey(p));
      if (other === undefined) {
        endOf.set(pointKey(p), i);
      } else {
        joined[root(i)] = root(other);
      }
    }
  }
  const steps: GroundStep[] = [];
  // the stepped stretches' heights on the high side, by the line of walls they are on
  const rising = new Map<number, { step: GroundStep; up: number[] }[]>();
  for (const [w, wall] of walls.entries()) {
    const line = wall.line;
    const lengths = [0];
    for (let i = 1; i < line.length; i++) {
      lengths.push(lengths[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
    }
    const total = lengths[lengths.length - 1];
    const [freeStart, freeEnd] = [free(line[0]), free(line[line.length - 1])];
    const share = (d: number) => Math.min(1, freeStart ? d / EASE_M : 1, freeEnd ? (total - d) / EASE_M : 1);
    const stretches: { a: Point; b: Point; left: number[]; right: number[]; shareA: number; shareB: number; segment: number }[] = [];
    for (let i = 1; i < line.length; i++) {
      const [a, b] = [line[i - 1], line[i]];
      const length = lengths[i] - lengths[i - 1];
      if (length === 0) {
        continue;
      }
      const [ue, un] = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
      const count = Math.ceil(length / STRETCH_M);
      for (let k = 0; k < count; k++) {
        const [t0, t1] = [k / count, (k + 1) / count];
        const p0: Point = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
        const p1: Point = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
        const mid: Point = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
        const out = (side: number) => {
          const heights: number[] = [];
          for (let d = 0; d <= WALL_REACH_M; d++) {
            const h = heightAt(mid[0] - un * side * d, mid[1] + ue * side * d);
            if (h === undefined) {
              break;
            }
            heights.push(h);
          }
          return heights;
        };
        stretches.push({ a: p0, b: p1, left: out(1), right: out(-1), shareA: share(lengths[i - 1] + length * t0), shareB: share(lengths[i - 1] + length * t1), segment: i });
      }
    }
    // the low side is each of the wall's legs', from the ground a few meters out along it: a wall drawn round its
    // body, its faces one way and back, holds up the ground on a side of each face of its own. A leg ends where the
    // wall turns more than LEG_TURN_RAD.
    const near = (heights: number[]) => heights[Math.min(heights.length - 1, 3)];
    const legOf = [0, 0];
    for (let i = 2; i < line.length; i++) {
      const [a, b, c] = [line[i - 2], line[i - 1], line[i]];
      const [u, v] = [Math.atan2(b[1] - a[1], b[0] - a[0]), Math.atan2(c[1] - b[1], c[0] - b[0])];
      const turn = Math.abs(Math.atan2(Math.sin(v - u), Math.cos(v - u)));
      legOf.push(legOf[i - 1] + (turn > LEG_TURN_RAD ? 1 : 0));
    }
    const leans = new Map<number, number>();
    for (const s of stretches) {
      if (s.left.length > 0 && s.right.length > 0) {
        leans.set(legOf[s.segment], (leans.get(legOf[s.segment]) ?? 0) + near(s.left) - near(s.right));
      }
    }
    for (const s of stretches) {
      const low = (leans.get(legOf[s.segment]) ?? 0) < 0 ? 1 : -1;
      const [down, up] = low === 1 ? [s.left, s.right] : [s.right, s.left];
      const footOut = slopeEnd(down, -1, LEAD_M);
      const topIn = slopeEnd(up, 1);
      const stepped = footOut !== undefined && topIn !== undefined && up[topIn] - down[footOut] >= MIN_STEP_M;
      // a stretch with no step is kept with no reach, so the ground beside it is not taken for a stepped one's
      const step: GroundStep = {
        wall: wall.osm,
        a: s.a,
        b: s.b,
        low,
        ...(stepped ? { foot: down[footOut], footOut, top: up[topIn], topIn } : { foot: 0, footOut: 0, top: 0, topIn: 0 }),
        shareA: s.shareA,
        shareB: s.shareB,
      };
      steps.push(step);
      if (stepped) {
        const line = rising.get(root(w)) ?? [];
        line.push({ step, up });
        rising.set(root(w), line);
      }
    }
  }
  for (const line of rising.values()) {
    stepOnlyTheWall(line);
  }
  return steps;
}

/**
 * Ground rising on behind a wall, where the wall holds up lower ground on both sides of it: a stretch whose slope
 * reaches much further in, to a much higher top, than stretches near it on both sides is stepped only as far in as
 * theirs, or not at all where that is too little a step
 */
function stepOnlyTheWall(line: { step: GroundStep; up: number[] }[]): void {
  const mid = ({ a, b }: GroundStep): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const cuts = line.map(({ step }) => {
    const [me, mn] = mid(step);
    const [de, dn] = [step.b[0] - step.a[0], step.b[1] - step.a[1]];
    let before: number | undefined;
    let after: number | undefined;
    for (const { step: other } of line) {
      const [oe, on] = mid(other);
      if (other.topIn + OVERREACH_M >= step.topIn || other.top + RISE_M >= step.top || Math.hypot(oe - me, on - mn) > BESIDE_M) {
        continue;
      }
      if ((oe - me) * de + (on - mn) * dn < 0) {
        before = Math.max(before ?? 0, other.topIn);
      } else {
        after = Math.max(after ?? 0, other.topIn);
      }
    }
    return before !== undefined && after !== undefined ? Math.max(before, after) : undefined;
  });
  for (const [i, { step, up }] of line.entries()) {
    const cut = cuts[i];
    if (cut === undefined) {
      continue;
    }
    if (up[cut] - step.foot >= MIN_STEP_M) {
      step.topIn = cut;
      step.top = up[cut];
    } else {
      Object.assign(step, { foot: 0, footOut: 0, top: 0, topIn: 0 });
    }
  }
}

/**
 * How far out (m) the ground stops falling (sign -1) or climbing (1) by at least FLAT_M a meter, for two meters on;
 * undefined where it does not within the heights (a bank going on past the wall, not the wall smoothed). With `lead`,
 * level ground up to that far out before it starts to fall or climb is passed over: the wall drawn a little behind
 * the model's edge.
 */
export function slopeEnd(heights: number[], sign: number, lead = 0): number | undefined {
  let start = 0;
  while (start < lead && start + 1 < heights.length && (heights[start + 1] - heights[start]) * sign < FLAT_M) {
    start++;
  }
  for (let d = start < lead ? start : 0; d + 2 < heights.length; d++) {
    if ((heights[d + 1] - heights[d]) * sign < FLAT_M && (heights[d + 2] - heights[d + 1]) * sign < FLAT_M) {
      return d;
    }
  }
  return undefined;
}

/** The ground's height stepped at the walls: down to a slope's foot on the low side, up to its top on the high side */
export function stepAtWalls(
  heightAt: (e: number, n: number) => number | undefined,
  steps: readonly GroundStep[],
): (e: number, n: number) => number | undefined {
  if (!steps.some((s) => s.footOut > 0 || s.topIn > 0)) {
    return heightAt;
  }
  const cells = stepCells(steps);
  return (e, n) => {
    const h = heightAt(e, n);
    const near = h === undefined ? undefined : cells.get(cellKey(cell(e), cell(n)));
    if (h === undefined || !near) {
      return h;
    }
    // the nearest stretch, measured past its ends too, so the stretches of a turning wall leave no gap
    let nearest: { step: GroundStep; t: number; distance: number; high: boolean } | undefined;
    for (const step of near) {
      const at = besideStep(step, e, n);
      if (at.distance < (nearest?.distance ?? Infinity)) {
        nearest = { step, ...at };
      }
    }
    if (!nearest) {
      return h;
    }
    const { step, t, distance, high } = nearest;
    if (!high) {
      return distance < step.footOut && h > step.foot ? h - (h - step.foot) * shareAt(step, t) : h;
    }
    // on the high side, up to the highest the stretches with the point on theirs take it: inside a corner, where the
    // model smooths two walls' steps together, one's slope may be followed out along the other's
    let raised = h;
    for (const other of near) {
      const at = other === step ? nearest : besideStep(other, e, n);
      if (at.high && at.distance < other.topIn && h < other.top) {
        raised = Math.max(raised, h + (other.top - h) * shareAt(other, at.t));
      }
    }
    return raised;
  };
}

/** Where a point is beside a stretch: how far along it (0 to 1) and from it, and whether on its high side */
function besideStep(step: GroundStep, e: number, n: number): { t: number; distance: number; high: boolean } {
  const [de, dn] = [step.b[0] - step.a[0], step.b[1] - step.a[1]];
  const t = Math.max(0, Math.min(1, ((e - step.a[0]) * de + (n - step.a[1]) * dn) / (de * de + dn * dn)));
  const left = de * (n - step.a[1]) - dn * (e - step.a[0]) > 0;
  return { t, distance: Math.hypot(e - step.a[0] - de * t, n - step.a[1] - dn * t), high: left !== (step.low === 1) };
}

const shareAt = (step: GroundStep, t: number) => step.shareA + (step.shareB - step.shareA) * t;

const cell = (v: number) => Math.floor(v / CELL_M);
const cellKey = (x: number, y: number) => (x + 0x8000) * 0x10000 + (y + 0x8000);
/** The cells' steps, of each list of them once: every tile's ground is stepped at the same ones */
const stepCellsOf = new WeakMap<readonly GroundStep[], Map<number, GroundStep[]>>();

/** The steps by the CELL_M squares within WALL_REACH_M of them */
function stepCells(steps: readonly GroundStep[]): Map<number, GroundStep[]> {
  const known = stepCellsOf.get(steps);
  if (known) {
    return known;
  }
  const cells = new Map<number, GroundStep[]>();
  for (const step of steps) {
    const reach = WALL_REACH_M;
    for (let x = cell(Math.min(step.a[0], step.b[0]) - reach); x <= cell(Math.max(step.a[0], step.b[0]) + reach); x++) {
      for (let y = cell(Math.min(step.a[1], step.b[1]) - reach); y <= cell(Math.max(step.a[1], step.b[1]) + reach); y++) {
        const list = cells.get(cellKey(x, y));
        if (list) {
          list.push(step);
        } else {
          cells.set(cellKey(x, y), [step]);
        }
      }
    }
  }
  stepCellsOf.set(steps, cells);
  return cells;
}
