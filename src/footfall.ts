// How many people walk along each way on an average day of the year (footfall), on every point of its
// line. Counted where a city has counts (around the centre of Tampere, some 430 current results of the
// city's pedestrian counts), and estimated elsewhere from what is around: shops, restaurants and offices
// draw people, homes send them out, and the kind of way decides how many of them use it. A centre full of
// businesses gets thousands a day on its sidewalks, a suburb's footways a few hundred.
//
// The estimate is kind × (base + scale × draw), where draw is the businesses and doors near the point,
// each weighed down with its distance. With counts, base and scale are fitted to them (least squares of
// the logarithms), and around each count the estimate is pulled towards it: the ratio of count to
// estimate spreads to the ways within COUNT_REACH_M, most along the counted way itself. Without counts,
// base and scale are the ones fitted to Tampere's.
//
// A count is of one day; it is turned into an average day with FOOTFALL_MONTHS and FOOTFALL_WEEKDAYS, which
// also turn footfall back into a given day. FOOTFALL_HOURS tells how a day's walking spreads over its hours.
import { distanceToSegment, nearestOnSegment, type Point } from "./geometry.ts";
import { NOT_FOR_VEHICLES, type Building, type Road } from "./osm.ts";

/** A pedestrian count at a point, turned into an average day (see averageDay) */
export interface FootfallCount {
  point: Point;
  /** People a day */
  daily: number;
  /** Counted across the whole street (both sidewalks); else on one path or sidewalk */
  whole: boolean;
}

/**
 * How a month's days compare with the year's average day, January first. People walk more in summer and
 * before Christmas, less in the dark and the slush of winter; a guess from the shape of Nordic city counts.
 */
export const FOOTFALL_MONTHS = [0.85, 0.85, 0.9, 0.95, 1.05, 1.1, 1.05, 1.1, 1.05, 1.0, 0.95, 1.05];
/** How a day of the week compares with the average day, Monday first */
export const FOOTFALL_WEEKDAYS = [1.05, 1.05, 1.05, 1.05, 1.1, 0.95, 0.75];
/**
 * The share of a day's walking in each hour, from 0-1 to 23-24, of a weekday and of a Saturday or Sunday
 * (later start, no commuting peaks). Each sums to 1.
 */
export const FOOTFALL_HOURS = {
  weekday: [
    0.005, 0.003, 0.002, 0.002, 0.003, 0.008, 0.02, 0.045, 0.06, 0.05, 0.05, 0.06, 0.07, 0.065, 0.065, 0.08, 0.09, 0.08,
    0.07, 0.055, 0.04, 0.03, 0.02, 0.027,
  ],
  weekend: [
    0.012, 0.01, 0.008, 0.005, 0.003, 0.003, 0.006, 0.012, 0.025, 0.045, 0.065, 0.08, 0.085, 0.085, 0.085, 0.085, 0.085,
    0.075, 0.065, 0.05, 0.04, 0.03, 0.025, 0.016,
  ],
};
/** An afternoon peak hour (15-17), for counts that have only that, is about this share of the day */
export const PEAK_HOUR_SHARE = 0.105;

/** How many walk on a way of a kind compared with a footway in the same surroundings; other kinds: none */
const KIND_FACTORS: Record<string, number> = {
  pedestrian: 1.6,
  living_street: 1.0,
  footway: 1.0,
  steps: 0.6,
  // in Finland mostly shared with people walking, and the main routes between districts
  cycleway: 1.0,
  path: 0.35,
  track: 0.2,
  bridleway: 0.1,
  // streets, on their sidewalks
  primary: 1.0,
  secondary: 1.0,
  tertiary: 1.0,
  residential: 0.8,
  unclassified: 0.6,
  service: 0.3,
};
/** Roads that have no sidewalks unless OSM says so */
const WITHOUT_SIDEWALKS = new Set(["motorway", "motorway_link", "trunk", "trunk_link", "primary_link", "secondary_link", "tertiary_link"]);
/** A road with a sidewalk tagged on it has this factor when its kind has none */
const TAGGED_SIDEWALK_FACTOR = 0.7;

/** Businesses draw people from this far (m), and homes' doors send them this far */
const BUSINESS_REACH_M = 200;
const DOOR_REACH_M = 120;
/** How much a business draws by its category; others 0.7 */
const BUSINESS_WEIGHTS: Record<string, number> = { shop: 1, amenity: 1.5, office: 0.5 };
/** A door draws this much of a business */
const DOOR_WEIGHT = 0.15;
/** Base and scale when there are no counts to fit them to: fitted to Tampere's in 2026 */
export const DEFAULT_FOOTFALL_MODEL = { base: 330, scale: 21 };

/** A count is on a way this close to it (m) */
const COUNT_MATCH_M = 25;
/** A count pulls the estimate within this distance (m) towards it */
const COUNT_REACH_M = 80;
/**
 * The pull of counts on ways other than the counted one (a parallel street, a side street). The counted
 * way goes on in the ways of its name, and in the walkways of its kind in line with it (OSM cuts sidewalks
 * into many pieces without names).
 */
const OTHER_WAY_PULL = 0.3;
/** A walkway goes on from the counted one when it is within this (m) of the counted segment's line */
const IN_LINE_M = 6;
/**
 * Weight of the estimate against the counts' pull: at a count its way gets about the count, and a lone
 * count farther away moves the estimate less than several near
 */
const ESTIMATE_WEIGHT = 0.1;
/** A street has its sidewalks drawn as ways of their own when footway=sidewalk runs this close beside it */
const SEPARATE_SIDEWALK_M = 8;
/** ... for this share of its length */
const SEPARATE_SIDEWALK_SHARE = 0.5;

export interface FootfallResult {
  /** Ways with footfall */
  ways: number;
  /** Counts on a way, of all */
  matched: number;
  counts: number;
  model: { base: number; scale: number };
  /** Of the matched counts, the share the estimate alone gets within a factor of two */
  withinTwo: number;
  /** Of the matched counts, the share whose way gets within a factor of 1.5 of them, pulled by the counts */
  atCounts: number;
  /** Streets whose sidewalks were found drawn as ways of their own without a sidewalk tag */
  separate: number;
}

/**
 * Sets the footfall of the roads: counted near counts, estimated elsewhere from the buildings' businesses
 * and doors (after businesses.ts and entrances.ts). Roads where no one walks get none.
 */
export function estimateFootfall(roads: Road[], buildings: Building[], counts: FootfallCount[]): FootfallResult {
  const { factors, separate } = kindFactors(roads);
  const draw = drawField(buildings);
  const walked = roads.filter((road) => (factors.get(road) ?? 0) > 0);
  const index = new SegmentGrid(COUNT_MATCH_M);
  for (const road of walked) {
    index.add(road);
  }

  // each count on its way: the draw and the kind factor there, and the count as on that way
  const matches: { count: FootfallCount; road: Road; at: Point; a: Point; b: Point; draw: number; factor: number; daily: number }[] = [];
  for (const count of counts) {
    const nearest = index.nearest(count.point, COUNT_MATCH_M);
    if (!nearest) {
      continue;
    }
    const factor = factors.get(nearest.road) ?? 0;
    // a street's footfall is on both its sidewalks, so a count on one of them is about half of it
    const street = !NOT_FOR_VEHICLES.has(nearest.road.kind) && nearest.road.kind !== "living_street";
    const sides = nearest.road.sidewalks === "left" || nearest.road.sidewalks === "right" ? 1 : 2;
    const daily = street && !count.whole ? count.daily * sides : count.daily;
    matches.push({ count, road: nearest.road, at: nearest.at, a: nearest.a, b: nearest.b, draw: draw(nearest.at), factor, daily });
  }

  const model = matches.length >= 5 ? fitModel(matches) : DEFAULT_FOOTFALL_MODEL;
  const estimate = (d: number, factor: number) => factor * (model.base + model.scale * d);
  const residuals = matches.map((m) => ({ ...m, log: Math.log(Math.max(m.daily, 1) / estimate(m.draw, m.factor)) }));
  const withinTwo = residuals.filter((r) => Math.abs(r.log) <= Math.LN2).length;

  const footfallAt = (road: Road, p: Point) => {
    let pull = 0;
    let weight = ESTIMATE_WEIGHT;
    for (const r of residuals) {
      const distance = Math.hypot(r.at[0] - p[0], r.at[1] - p[1]);
      if (distance < COUNT_REACH_M) {
        const w = falloff(distance, COUNT_REACH_M) * (goesOn(r, road, p) ? 1 : OTHER_WAY_PULL);
        pull += w * r.log;
        weight += w;
      }
    }
    return Math.round(estimate(draw(p), factors.get(road) ?? 0) * Math.exp(pull / weight));
  };
  for (const road of walked) {
    road.footfall = road.line.map((p) => footfallAt(road, p));
  }
  const atCounts = matches.filter((m) => Math.abs(Math.log(Math.max(m.daily, 1) / Math.max(footfallAt(m.road, m.at), 1))) <= Math.log(1.5)).length;
  return {
    ways: walked.length,
    matched: matches.length,
    counts: counts.length,
    model,
    withinTwo: matches.length > 0 ? withinTwo / matches.length : 0,
    atCounts: matches.length > 0 ? atCounts / matches.length : 0,
    separate,
  };
}

/** Whether the way at p is the counted way, or goes on from it: of its name, or a walkway of its kind in line with it */
function goesOn(count: { road: Road; a: Point; b: Point }, road: Road, p: Point): boolean {
  if (count.road.osm === road.osm || (count.road.name !== undefined && count.road.name === road.name)) {
    return true;
  }
  if (road.kind !== count.road.kind || road.footway !== count.road.footway || !NOT_FOR_VEHICLES.has(road.kind)) {
    return false;
  }
  const [a, b] = [count.a, count.b];
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return length > 0 && Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / length <= IN_LINE_M;
}

/** A count of a day turned into the year's average day */
export function averageDay(daily: number, date: Date): number {
  return daily / (FOOTFALL_MONTHS[date.getUTCMonth()] * FOOTFALL_WEEKDAYS[(date.getUTCDay() + 6) % 7]);
}

/** 1 at the point, falling smoothly to 0 at reach */
function falloff(distance: number, reach: number): number {
  const t = 1 - (distance / reach) ** 2;
  return t > 0 ? t * t : 0;
}

/**
 * The kind factor of every road, 0 where no one walks: streets whose sidewalks are ways of their own
 * (tagged so, or found beside them) or that have none, and tunnels for vehicles
 */
function kindFactors(roads: Road[]): { factors: Map<Road, number>; separate: number } {
  const sidewalkWays = new SegmentGrid(SEPARATE_SIDEWALK_M * 2);
  for (const road of roads) {
    if (road.footway === "sidewalk") {
      sidewalkWays.add(road);
    }
  }
  const factors = new Map<Road, number>();
  let separate = 0;
  for (const road of roads) {
    const walkway = NOT_FOR_VEHICLES.has(road.kind);
    let factor = KIND_FACTORS[road.kind] ?? 0;
    if (!walkway) {
      if (road.tunnel || road.sidewalks === "none" || road.sidewalks === "separate") {
        factor = 0;
      } else if (road.sidewalks !== undefined) {
        factor = (factor || TAGGED_SIDEWALK_FACTOR) * (road.sidewalks === "both" ? 1 : 0.5);
      } else if (WITHOUT_SIDEWALKS.has(road.kind)) {
        factor = 0;
      } else if (factor > 0 && besideSidewalks(road, sidewalkWays)) {
        factor = 0;
        separate++;
      }
    }
    factors.set(road, factor);
  }
  return { factors, separate };
}

/** Whether footway=sidewalk ways run beside the road for most of its length */
function besideSidewalks(road: Road, sidewalks: SegmentGrid): boolean {
  const reach = road.width / 2 + SEPARATE_SIDEWALK_M;
  let samples = 0;
  let beside = 0;
  for (let i = 0; i + 1 < road.line.length; i++) {
    const [a, b] = [road.line[i], road.line[i + 1]];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.round(length / 10));
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps;
      const p: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      samples++;
      if (sidewalks.nearest(p, reach)) {
        beside++;
      }
    }
  }
  return samples > 0 && beside / samples >= SEPARATE_SIDEWALK_SHARE;
}

/** The draw of the businesses and doors around a point */
function drawField(buildings: Building[]): (p: Point) => number {
  const sources: { point: Point; weight: number; reach: number }[] = [];
  for (const building of buildings) {
    for (const business of building.businesses ?? []) {
      sources.push({ point: business.front?.at ?? business.point, weight: BUSINESS_WEIGHTS[business.category] ?? 0.7, reach: BUSINESS_REACH_M });
    }
    // the doors of homes, offices and the like; a door of a shop is its business's
    for (const entrance of building.entrances ?? []) {
      if (entrance.kind !== "shop" && entrance.kind !== "service") {
        sources.push({ point: entrance.at, weight: DOOR_WEIGHT, reach: DOOR_REACH_M });
      }
    }
  }
  const cell = BUSINESS_REACH_M;
  const cells = new Map<string, typeof sources>();
  for (const source of sources) {
    const key = `${Math.floor(source.point[0] / cell)},${Math.floor(source.point[1] / cell)}`;
    cells.set(key, [...(cells.get(key) ?? []), source]);
  }
  return (p) => {
    const i0 = Math.floor(p[0] / cell);
    const j0 = Math.floor(p[1] / cell);
    let sum = 0;
    for (let i = i0 - 1; i <= i0 + 1; i++) {
      for (let j = j0 - 1; j <= j0 + 1; j++) {
        for (const source of cells.get(`${i},${j}`) ?? []) {
          sum += source.weight * falloff(Math.hypot(source.point[0] - p[0], source.point[1] - p[1]), source.reach);
        }
      }
    }
    return sum;
  };
}

/** Base and scale that fit the counts best: least squares of the logarithms, searched on a grid */
function fitModel(matches: { draw: number; factor: number; daily: number }[]): { base: number; scale: number } {
  let best = DEFAULT_FOOTFALL_MODEL;
  let bestError = Infinity;
  for (let b = 0; b <= 40; b++) {
    const base = 2 * 1.2 ** b;
    for (let s = 0; s <= 40; s++) {
      const scale = 2 * 1.2 ** s;
      let error = 0;
      for (const m of matches) {
        error += Math.log(Math.max(m.daily, 1) / (m.factor * (base + scale * m.draw))) ** 2;
      }
      if (error < bestError) {
        bestError = error;
        best = { base: Math.round(base), scale: Math.round(scale) };
      }
    }
  }
  return best;
}

/** Road segments in square cells, to find the nearest one to a point */
class SegmentGrid {
  readonly #cell: number;
  readonly #cells = new Map<string, { road: Road; a: Point; b: Point }[]>();

  constructor(cell: number) {
    this.#cell = cell;
  }

  add(road: Road): void {
    for (let i = 0; i + 1 < road.line.length; i++) {
      const [a, b] = [road.line[i], road.line[i + 1]];
      const seen = new Set<string>();
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(length / this.#cell));
      for (let s = 0; s <= steps; s++) {
        const key = this.#key([a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps]);
        if (!seen.has(key)) {
          seen.add(key);
          this.#cells.set(key, [...(this.#cells.get(key) ?? []), { road, a, b }]);
        }
      }
    }
  }

  /** The nearest road within reach of the point, the nearest point on it and its segment there */
  nearest(p: Point, reach: number): { road: Road; at: Point; a: Point; b: Point } | undefined {
    let best: { road: Road; at: Point; a: Point; b: Point } | undefined;
    let bestDistance = reach;
    const r = Math.ceil(reach / this.#cell);
    const [i0, j0] = [Math.floor(p[0] / this.#cell), Math.floor(p[1] / this.#cell)];
    for (let i = i0 - r; i <= i0 + r; i++) {
      for (let j = j0 - r; j <= j0 + r; j++) {
        for (const { road, a, b } of this.#cells.get(`${i},${j}`) ?? []) {
          const distance = distanceToSegment(p, a, b);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = { road, at: nearestOnSegment(p, a, b), a, b };
          }
        }
      }
    }
    return best;
  }

  #key(p: Point): string {
    return `${Math.floor(p[0] / this.#cell)},${Math.floor(p[1] / this.#cell)}`;
  }
}
