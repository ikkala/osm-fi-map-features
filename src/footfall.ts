// How many people walk (footfall) and cycle (cycling) along each way on an average day of the year, on
// every point of its line, estimated from what OpenStreetMap has around: shops, restaurants and offices draw
// people, homes send them out, and the kind of way decides how many of them use it. A centre full of
// businesses gets thousands a day on its sidewalks, a suburb's footways a few hundred.
//
// The estimate is kind × (base + scale × draw), where draw is the businesses and doors near the point,
// each weighed down with its distance, and kind is the way's for walking or for cycling. Base and scale
// (DEFAULT_MODELS) were fitted to the City of Tampere's pedestrian and cycling counts in 2026. The counts
// themselves are not in the map: a user that has counts can pull the estimate towards them (flows.ts).
import { distanceToSegment, nearestOnSegment, type Point } from "./geometry.ts";
import { NOT_FOR_VEHICLES, type Building, type Road } from "./osm.ts";

export type Mode = "walking" | "cycling";

/** How many walk on a way of a kind compared with a footway in the same surroundings; other kinds: none */
const WALKING_FACTORS: Record<string, number> = {
  pedestrian: 1.6,
  living_street: 1.0,
  footway: 1.0,
  steps: 0.6,
  // in Finland mostly shared with people walking (foot=designated), and the main routes between districts
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
/** A cycleway without foot=designated, yes or permissive is mostly for bicycles: this many walk on it */
const CYCLEWAY_ONLY_WALKING = 0.3;
/**
 * How many cycle on a way of a kind compared with a cycleway in the same surroundings; other kinds (steps,
 * motorways, trunk roads and their links): none. On streets they ride in the carriageway.
 */
const CYCLING_FACTORS: Record<string, number> = {
  cycleway: 1.0,
  // in Finland only children may cycle on a footway, unless it is shared (bicycle=yes or designated)
  footway: 0.1,
  pedestrian: 0.2,
  path: 0.4,
  track: 0.3,
  bridleway: 0.1,
  living_street: 0.5,
  residential: 0.6,
  unclassified: 0.5,
  tertiary: 0.7,
  secondary: 0.6,
  primary: 0.5,
  service: 0.3,
};
/** A footway or a pedestrian street shared with bicycles (bicycle=yes or designated) */
const SHARED_CYCLING = 0.7;
/** A street with its sidewalks drawn apart often has a cycleway beside it too, which takes most of its cyclists */
const SEPARATE_CYCLING = 0.3;
/** Roads that have no sidewalks unless OSM says so */
const WITHOUT_SIDEWALKS = new Set(["motorway", "motorway_link", "trunk", "trunk_link", "primary_link", "secondary_link", "tertiary_link"]);
/** A road with a sidewalk tagged on it has this factor when its kind has none */
const TAGGED_SIDEWALK_FACTOR = 0.7;
/** foot=* and bicycle=* values that keep people walking or cycling off a way */
const NOT_ALLOWED = new Set(["no", "use_sidepath", "private"]);
/**
 * A street with bicycle=use_sidepath (in Tampere most main streets) has a cycleway beside it, which takes
 * most of its cyclists; this share of them still rides in the carriageway
 */
const SIDEPATH_CYCLING = 0.15;
const ALLOWED = new Set(["yes", "designated", "permissive"]);

/** Businesses draw people from this far (m), and homes' doors send them this far */
const BUSINESS_REACH_M = 200;
const DOOR_REACH_M = 120;
/** How much a business draws by its category; others 0.7 */
const BUSINESS_WEIGHTS: Record<string, number> = { shop: 1, amenity: 1.5, office: 0.5 };
/** A door draws this much of a business */
const DOOR_WEIGHT = 0.15;
/** Base and scale of each mode: fitted to Tampere's counts in 2026 */
export const DEFAULT_MODELS: Record<Mode, { base: number; scale: number }> = {
  walking: { base: 330, scale: 19.2 },
  cycling: { base: 330, scale: 0.5 },
};

/** A street has its sidewalks drawn as ways of their own when footway=sidewalk runs this close beside it */
const SEPARATE_SIDEWALK_M = 8;
/** ... for this share of its length */
const SEPARATE_SIDEWALK_SHARE = 0.5;

export interface FootfallResult {
  /** Ways with footfall (or cycling) */
  ways: number;
  /** Streets whose sidewalks were found drawn as ways of their own without a sidewalk tag */
  separate: number;
}

/**
 * Sets the footfall of the roads, estimated from the buildings' businesses and doors (after businesses.ts and
 * entrances.ts). Roads where no one walks get none.
 */
export function estimateFootfall(roads: Road[], buildings: Building[]): FootfallResult {
  return estimate(roads, buildings, "walking");
}

/** Sets the cycling of the roads, as estimateFootfall the footfall. Roads where no one cycles get none. */
export function estimateCycling(roads: Road[], buildings: Building[]): FootfallResult {
  return estimate(roads, buildings, "cycling");
}

function estimate(roads: Road[], buildings: Building[], mode: Mode): FootfallResult {
  const { factors, separate } = kindFactors(roads, mode);
  const draw = drawField(buildings);
  const model = DEFAULT_MODELS[mode];
  const used = roads.filter((road) => (factors.get(road) ?? 0) > 0);
  for (const road of used) {
    const factor = factors.get(road) ?? 0;
    const values = road.line.map((p) => Math.round(factor * (model.base + model.scale * draw(p))));
    if (mode === "walking") {
      road.footfall = values;
    } else {
      road.cycling = values;
    }
  }
  return { ways: used.length, separate };
}

/** 1 at the point, falling smoothly to 0 at reach */
function falloff(distance: number, reach: number): number {
  const t = 1 - (distance / reach) ** 2;
  return t > 0 ? t * t : 0;
}

/**
 * The kind factor of every road for walking or cycling, 0 where no one does: where foot=* or bicycle=*
 * says no, tunnels for vehicles, and for walking streets whose sidewalks are ways of their own (tagged so,
 * or found beside them) or that have none
 */
function kindFactors(roads: Road[], mode: Mode): { factors: Map<Road, number>; separate: number } {
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
    const access = mode === "walking" ? road.foot : road.bicycle;
    let factor = mode === "walking" ? (WALKING_FACTORS[road.kind] ?? 0) : (CYCLING_FACTORS[road.kind] ?? 0);
    const sidepath = mode === "cycling" && access === "use_sidepath" && !walkway;
    if (sidepath) {
      factor *= SIDEPATH_CYCLING;
    } else if (access !== undefined && NOT_ALLOWED.has(access)) {
      factor = 0;
    } else if (mode === "walking" && road.kind === "cycleway" && !(access !== undefined && ALLOWED.has(access))) {
      factor = CYCLEWAY_ONLY_WALKING;
    } else if (mode === "cycling" && (road.kind === "footway" || road.kind === "pedestrian") && access !== undefined && ALLOWED.has(access)) {
      factor = SHARED_CYCLING;
    }
    if (!walkway && factor > 0) {
      const beside = () => {
        const found = road.sidewalks === undefined && !WITHOUT_SIDEWALKS.has(road.kind) && besideSidewalks(road, sidewalkWays);
        if (found) {
          separate++;
        }
        return found;
      };
      if (road.tunnel) {
        factor = 0;
      } else if (mode === "cycling") {
        // (a use_sidepath street has its share already)
        if (!sidepath && (road.sidewalks === "separate" || beside())) {
          factor *= SEPARATE_CYCLING;
        }
      } else if (road.sidewalks === "none" || road.sidewalks === "separate") {
        factor = 0;
      } else if (road.sidewalks !== undefined) {
        factor = (factor || TAGGED_SIDEWALK_FACTOR) * (road.sidewalks === "both" ? 1 : 0.5);
      } else if (WITHOUT_SIDEWALKS.has(road.kind) || beside()) {
        factor = 0;
      }
    } else if (!walkway && mode === "walking" && road.sidewalks !== undefined && road.sidewalks !== "none" && road.sidewalks !== "separate" && !road.tunnel) {
      // a road without sidewalks by its kind, with one tagged
      factor = TAGGED_SIDEWALK_FACTOR * (road.sidewalks === "both" ? 1 : 0.5);
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
