// Amusement rides (attraction=*) and roller coasters' tracks (roller_coaster=track). OSM seldom tells how high a
// track runs, only its layer, so a track runs at a height for its layer and ramps between pieces where they join.
import { pointKey, type Point, type Ring } from "./geometry.ts";

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
 * the courses meeting there, so joined pieces meet, and its middle at its own layer's, straight between them. A
 * course in a tunnel runs at the ground.
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
  const alongOf = (line: Point[]) => {
    const along = [0];
    for (let i = 1; i < line.length; i++) {
      along.push(along[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
    }
    return along;
  };
  for (const course of courses) {
    const line = [...(course.line ?? [])];
    const from = course.tunnel ? 0 : mean(line[0]);
    const to = course.tunnel ? 0 : mean(line[line.length - 1]);
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
    course.line = line;
    const middle = course.tunnel ? 0 : own(course);
    course.heights = along.map((d) =>
      half <= 0 ? middle : d <= half ? from + ((middle - from) * d) / half : middle + ((to - middle) * (d - half)) / half,
    );
  }
  return courses.length;
}
