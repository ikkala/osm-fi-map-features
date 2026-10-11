// Amusement rides (attraction=*) and roller coasters' tracks (roller_coaster=track). OSM seldom tells how high a
// track runs, only its layer, so a track runs at a height for its layer and ramps between pieces where they join.
import { distanceToSegment, pointKey, type Point, type Ring } from "./geometry.ts";
import type { Area } from "./osm.ts";

/** attraction=* values that are rides; the rest (animal, maze, ...) are left out */
export const RIDE_KINDS = new Set([
  "alpine_coaster", "amusement_ride", "big_wheel", "bumper_car", "carousel", "dark_ride", "drop_tower", "kiddie_ride",
  "log_flume", "pirate_ship", "river_rafting", "roller_coaster", "summer_toboggan", "swing_carousel", "train",
  "water_slide",
]);
/** Rides whose way is their course, also when closed (a train's loop) */
export const COURSE_KINDS = new Set(["alpine_coaster", "log_flume", "river_rafting", "summer_toboggan", "track", "train", "water_slide"]);

/** Meters over the ground a course runs for each layer over 0; on layer 0 or unset it runs this low */
const LAYER_M = 6;
const GROUND_M = 1;
/** Meters from a course up to one crossing over it */
const CLEARANCE_M = 4;
/** Rounds of moving crossing courses apart: one can push another into a third */
const CROSSING_PASSES = 8;
/** Lines cross at a point of one when this close to it, a share of the segment */
const AT_POINT = 1e-6;
/** Rides whose course carries water */
const WATER_COURSES = new Set(["log_flume", "river_rafting", "water_slide"]);
/** A water area within this of a water course's line all round is the course's water (m) */
const CHANNEL_REACH_M = 3;

export interface Ride {
  osm: string;
  /** attraction=* in lower case (roller_coaster, carousel, drop_tower, ...), or track: a piece of a roller coaster's track */
  kind: string;
  name?: string;
  /** Meters east and north of the origin: the node, or the middle of the way */
  point: Point;
  /** A closed way's outline, counter-clockwise */
  outline?: Ring;
  /** A course's line: a track, a flume, a train's loop */
  line?: Point[];
  /** A course's height over the ground at each point of line, m (setCourseHeights) */
  heights?: number[];
  /** layer=*, when OSM tells */
  layer?: number;
  /** In a tunnel (tunnel=yes): under the ground */
  tunnel?: boolean;
  /** Meters, when OSM tells */
  height?: number;
  /** Drawn as a building too (building=*, as a roof over bumper cars) */
  building?: boolean;
}

/**
 * Sets the heights of the courses over the ground: each end of a course at the mean of the heights for the layers of
 * the courses meeting there, so joined pieces meet, and its middle at its own layer's, straight between them. Where
 * courses cross without meeting, the one on the higher layer (or else the higher one there) runs CLEARANCE_M over the
 * other, each moved half the way (the lower one no lower than the ground's height), straight to the points before and
 * after. A course in a tunnel runs at the ground.
 */
export function setCourseHeights(rides: Ride[]): number {
  const courses = rides.filter((r) => r.line && r.line.length >= 2);
  const own = (r: Ride) => (r.tunnel ? 0 : r.layer !== undefined && r.layer > 0 ? r.layer * LAYER_M : GROUND_M);
  const atEnds = new Map<string, number[]>();
  for (const course of courses) {
    const line = course.line ?? [];
    for (const end of [line[0], line[line.length - 1]]) {
      const key = pointKey(end);
      atEnds.set(key, [...(atEnds.get(key) ?? []), own(course)]);
    }
  }
  const mean = (p: Point) => {
    const values = atEnds.get(pointKey(p)) ?? [];
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  };
  const entries: Course[] = [];
  for (const ride of courses) {
    const line = [...(ride.line ?? [])];
    // a point halfway along, where the course is at its own height
    let along = alongOf(line);
    const half = along[along.length - 1] / 2;
    const after = along.findIndex((d) => d >= half);
    if (after > 0 && along[after] - half > 0.01 && half - along[after - 1] > 0.01) {
      const t = (half - along[after - 1]) / (along[after] - along[after - 1]);
      const [a, b] = [line[after - 1], line[after]];
      line.splice(after, 0, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      along = alongOf(line);
    }
    ride.line = line;
    const anchors = ride.tunnel
      ? new Map([[0, 0]])
      : new Map([
          [0, mean(line[0])],
          [half, own(ride)],
          [along[along.length - 1], mean(line[line.length - 1])],
        ]);
    entries.push({ ride, anchors });
  }
  const crossings = crossCourses(entries.filter((c) => !c.ride.tunnel)).map(({ a, b }) => {
    const [ha, hb] = [heightAt(a.course, a.along), heightAt(b.course, b.along)];
    const [la, lb] = [a.course.ride.layer ?? 0, b.course.ride.layer ?? 0];
    const aOver = la !== lb ? la > lb : ha !== hb ? ha > hb : a.along > b.along;
    return aOver ? { upper: a, lower: b } : { upper: b, lower: a };
  });
  for (let pass = 0; pass < CROSSING_PASSES; pass++) {
    let moved = false;
    for (const { upper, lower } of crossings) {
      const [hu, hl] = [heightAt(upper.course, upper.along), heightAt(lower.course, lower.along)];
      const need = hl + CLEARANCE_M - hu;
      if (need > 0.01) {
        const lowered = Math.min(need / 2, Math.max(0, hl - GROUND_M));
        lower.course.anchors.set(lower.along, hl - lowered);
        upper.course.anchors.set(upper.along, hu + need - lowered);
        moved = true;
      }
    }
    if (!moved) {
      break;
    }
  }
  for (const course of entries) {
    course.ride.heights = alongOf(course.ride.line ?? []).map((d) => heightAt(course, d));
  }
  return courses.length;
}

/** A course and its heights at points along it (m along: m over the ground), straight between them */
interface Course {
  ride: Ride;
  anchors: Map<number, number>;
}

interface OnCourse {
  course: Course;
  /** Meters along the course's line */
  along: number;
}

function heightAt(course: Course, along: number): number {
  const sorted = [...course.anchors].sort((x, y) => x[0] - y[0]);
  const after = sorted.findIndex(([d]) => d >= along);
  if (after <= 0) {
    return sorted[after < 0 ? sorted.length - 1 : 0][1];
  }
  const [[d0, h0], [d1, h1]] = [sorted[after - 1], sorted[after]];
  return h0 + ((h1 - h0) * (along - d0)) / (d1 - d0);
}

/** Meters along a line at each of its points */
function alongOf(line: Point[]): number[] {
  const along = [0];
  for (let i = 1; i < line.length; i++) {
    along.push(along[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
  }
  return along;
}

/**
 * Where the courses' lines cross (not where they meet at a point of both, or one ends on the other), a course with
 * itself too. Each crossing becomes a point of both lines.
 */
function crossCourses(courses: Course[]): { a: OnCourse; b: OnCourse }[] {
  const found: { a: Course; b: Course; pa: Point; pb: Point }[] = [];
  const added = new Map<Course, { segment: number; t: number; point: Point }[]>();
  const add = (course: Course, segment: number, t: number, from: Point, to: Point): Point => {
    const point: Point = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
    added.set(course, [...(added.get(course) ?? []), { segment, t, point }]);
    return point;
  };
  const boxes = courses.map((c) => boxOf(c.ride.line ?? []));
  for (let x = 0; x < courses.length; x++) {
    for (let y = x; y < courses.length; y++) {
      if (!boxesMeet(boxes[x], boxes[y])) {
        continue;
      }
      const [la, lb] = [courses[x].ride.line ?? [], courses[y].ride.line ?? []];
      for (let i = 0; i + 1 < la.length; i++) {
        for (let j = x === y ? i + 2 : 0; j + 1 < lb.length; j++) {
          const cross = segmentsCross(la[i], la[i + 1], lb[j], lb[j + 1]);
          // at a point of both lines they meet; at a line's start, it ends there
          if (!cross || (cross.t < AT_POINT && (cross.u < AT_POINT || i === 0)) || (cross.u < AT_POINT && j === 0)) {
            continue;
          }
          const pa = cross.t < AT_POINT ? la[i] : add(courses[x], i, cross.t, la[i], la[i + 1]);
          const pb = cross.u < AT_POINT ? lb[j] : add(courses[y], j, cross.u, lb[j], lb[j + 1]);
          found.push({ a: courses[x], b: courses[y], pa, pb });
        }
      }
    }
  }
  for (const [course, points] of added) {
    const line = [...(course.ride.line ?? [])];
    for (const { segment, point } of [...points].sort((p, q) => q.segment - p.segment || q.t - p.t)) {
      line.splice(segment + 1, 0, point);
    }
    course.ride.line = line;
  }
  const alongs = new Map(courses.map((c) => [c, alongOf(c.ride.line ?? [])]));
  const on = (course: Course, point: Point): OnCourse => ({ course, along: alongs.get(course)?.[(course.ride.line ?? []).indexOf(point)] ?? 0 });
  return found.map(({ a, b, pa, pb }) => ({ a: on(a, pa), b: on(b, pb) }));
}

/** Where segments ab and cd cross, from a or c on up to b or d: how far along each, or undefined */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): { t: number; u: number } | undefined {
  const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
  if (Math.abs(den) < 1e-12) {
    return undefined;
  }
  const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
  const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
  const inside = (v: number) => v > -AT_POINT && v < 1 - AT_POINT;
  return inside(t) && inside(u) ? { t, u } : undefined;
}

type Box = [number, number, number, number];

function boxOf(line: Point[]): Box {
  const es = line.map((p) => p[0]);
  const ns = line.map((p) => p[1]);
  return [Math.min(...es), Math.min(...ns), Math.max(...es), Math.max(...ns)];
}

function boxesMeet(a: Box, b: Box): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/**
 * The water areas without those lying all along a water ride's course (a flume's water mapped as an area under its
 * raised channel): within CHANNEL_REACH_M of its line all round. The course carries that water.
 */
export function withoutCourseWater(areas: Area[], rides: Ride[]): Area[] {
  const lines = rides.filter((r) => r.line && !r.tunnel && WATER_COURSES.has(r.kind)).map((r) => r.line ?? []);
  if (lines.length === 0) {
    return areas;
  }
  const near = (p: Point) => lines.some((line) => line.some((a, i) => i > 0 && distanceToSegment(p, line[i - 1], a) <= CHANNEL_REACH_M));
  return areas.filter((area) => area.kind !== "water" || !area.polygon.outer.every(near));
}
