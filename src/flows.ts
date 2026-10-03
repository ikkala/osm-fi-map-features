// Daily walking, cycling and motor traffic along roads: the map's estimates pulled towards a user's counts
// at points, combined at use time rather than built into the map. The flows are a Derivative Database under
// the ODbL (see the README's Licences); the counts stay a database of their own.
//
// Each count matches the nearest road of its mode; the count/estimate ratio spreads, fading, along the counted
// road (same id or name, or walkways in line with it) and less onto other roads.
import { NOT_FOR_VEHICLES, type Road } from "./osm.ts";
import type { Point } from "./geometry.ts";

export type FlowMode = "walking" | "cycling" | "driving";

/** The parts of a map Road the flows use */
export type FlowRoad = Pick<Road, "kind" | "line"> &
  Partial<Pick<Road, "osm" | "name" | "footfall" | "cycling" | "motorVehicle" | "service" | "sidewalks" | "tunnel" | "floor" | "lid">>;

/** A count at a point, made the year's average day */
export interface FlowCount {
  mode: FlowMode;
  point: Point;
  /** People or vehicles a day, both ways */
  daily: number;
  /** Walking and cycling: counted across the whole street; else on one path or sidewalk */
  whole: boolean;
}

/** One road's flows, by its index in the roads given; unset where no one goes that way */
export interface RoadFlows {
  index: number;
  footfall?: number[];
  cycling?: number[];
  motor?: number[];
}

interface ModeSettings {
  /** The road's field with the map's estimate; driving is estimated by kind */
  field?: "footfall" | "cycling";
  out: "footfall" | "cycling" | "motor";
  reach: number;
  otherReach: number;
  other: number;
  weight: number;
}

const MODES: FlowMode[] = ["walking", "cycling", "driving"];
/** Per mode: a count's reach (m) along its road and onto others, the pull on others, and the estimate's weight against counts */
const SETTINGS: Record<FlowMode, ModeSettings> = {
  walking: { field: "footfall", out: "footfall", reach: 80, otherReach: 80, other: 0.3, weight: 0.1 },
  cycling: { field: "cycling", out: "cycling", reach: 80, otherReach: 80, other: 0.3, weight: 0.1 },
  driving: { out: "motor", reach: 250, otherReach: 60, other: 0.2, weight: 0.05 },
};
/** Counts this far (m) from a road can pull it */
export const FLOW_REACH_M = 250;
/** A count is on a road this close to it (m) */
const MATCH_M = 25;
/** A walkway goes on from the counted one when it is within this (m) of the counted segment's line */
const IN_LINE_M = 6;

/** Typical vehicles a day by road kind (fitted to traffic counts); other kinds none */
const KIND_TRAFFIC: Record<string, number> = {
  motorway: 30000,
  trunk: 20000,
  primary: 12000,
  secondary: 7000,
  tertiary: 3500,
  motorway_link: 6000,
  trunk_link: 4000,
  primary_link: 3000,
  secondary_link: 2000,
  tertiary_link: 1200,
  unclassified: 800,
  residential: 250,
  living_street: 60,
  service: 60,
};
/** Service roads by service=* */
const SERVICE_TRAFFIC: Record<string, number> = { parking_aisle: 30, driveway: 15, alley: 30, "drive-through": 40 };
/** Who may drive (motorVehicle): none, or only some (FEW_ALLOWED_SHARE) */
const NOT_ALLOWED = new Set(["no", "private", "agricultural", "forestry", "emergency", "psv", "bus"]);
const FEW_ALLOWED = new Set(["destination", "delivery", "customers", "permit"]);
const FEW_ALLOWED_SHARE = 0.2;

/** A road's motor vehicles a day by kind and access; 0 where cars may not drive and in undrawn tunnels */
export function estimateMotorTraffic(road: FlowRoad): number {
  const base = road.kind === "service" && road.service !== undefined ? (SERVICE_TRAFFIC[road.service] ?? KIND_TRAFFIC.service) : (KIND_TRAFFIC[road.kind] ?? 0);
  const hidden = road.tunnel === true && road.floor === undefined && road.lid === undefined;
  if (hidden || (road.motorVehicle !== undefined && NOT_ALLOWED.has(road.motorVehicle))) {
    return 0;
  }
  return road.motorVehicle !== undefined && FEW_ALLOWED.has(road.motorVehicle) ? base * FEW_ALLOWED_SHARE : base;
}

/** Whether only some may drive on a road (motorVehicle destination, delivery, ...) */
function restricted(road: FlowRoad): boolean {
  return road.motorVehicle !== undefined && FEW_ALLOWED.has(road.motorVehicle);
}

/** A road's estimate of a mode at each point of its line, or undefined where no one goes that way */
function estimates(road: FlowRoad, mode: FlowMode): number[] | undefined {
  const fieldName = SETTINGS[mode].field;
  if (fieldName) {
    return road[fieldName];
  }
  const base = estimateMotorTraffic(road);
  return base > 0 ? road.line.map(() => base) : undefined;
}

/** 1 at the point, falling smoothly to 0 at reach */
function falloff(distance: number, reach: number): number {
  const t = 1 - (distance / reach) ** 2;
  return t > 0 ? t * t : 0;
}

interface Match {
  road: FlowRoad;
  at: Point;
  a: Point;
  b: Point;
  value: number;
}

type Grid = Map<string, { road: FlowRoad; values: number[]; k: number }[]>;

/** The roads' segments of a mode in cells of MATCH_M, to find the nearest to a count */
function segmentGrid(roads: FlowRoad[], mode: FlowMode): Grid {
  const cells: Grid = new Map();
  for (const road of roads) {
    const values = estimates(road, mode);
    if (!values) {
      continue;
    }
    for (let k = 0; k + 1 < road.line.length; k++) {
      const [[ae, an], [be, bn]] = [road.line[k], road.line[k + 1]];
      for (let i = Math.floor(Math.min(ae, be) / MATCH_M); i <= Math.floor(Math.max(ae, be) / MATCH_M); i++) {
        for (let j = Math.floor(Math.min(an, bn) / MATCH_M); j <= Math.floor(Math.max(an, bn) / MATCH_M); j++) {
          const key = `${i},${j}`;
          cells.set(key, [...(cells.get(key) ?? []), { road, values, k }]);
        }
      }
    }
  }
  return cells;
}

/** The nearest road segment to a point within MATCH_M, and the estimate there */
function nearestRoad(cells: Grid, [e, n]: Point): Match | undefined {
  let best: Match | undefined;
  let bestDistance = MATCH_M;
  const [ci, cj] = [Math.floor(e / MATCH_M), Math.floor(n / MATCH_M)];
  for (let i = ci - 1; i <= ci + 1; i++) {
    for (let j = cj - 1; j <= cj + 1; j++) {
      for (const { road, values, k } of cells.get(`${i},${j}`) ?? []) {
        const [a, b] = [road.line[k], road.line[k + 1]];
        const [de, dn] = [b[0] - a[0], b[1] - a[1]];
        const lengthSq = de * de + dn * dn;
        const t = lengthSq > 0 ? Math.min(1, Math.max(0, ((e - a[0]) * de + (n - a[1]) * dn) / lengthSq)) : 0;
        const at: Point = [a[0] + de * t, a[1] + dn * t];
        const distance = Math.hypot(e - at[0], n - at[1]);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { road, at, a, b, value: values[k] + (values[k + 1] - values[k]) * t };
        }
      }
    }
  }
  return best;
}

/** Whether the road at p is the counted one or goes on from it */
function goesOn(r: Match, road: FlowRoad, p: Point, mode: FlowMode): boolean {
  if ((r.road.osm !== undefined && r.road.osm === road.osm) || (r.road.name !== undefined && r.road.name === road.name)) {
    return true;
  }
  if (mode === "driving" || road.kind !== r.road.kind || !NOT_FOR_VEHICLES.has(road.kind)) {
    return false;
  }
  const [a, b] = [r.a, r.b];
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return length > 0 && Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / length <= IN_LINE_M;
}

/**
 * The flows of `roads` pulled towards `counts`, and whether any count matched. `others` are the roads counts
 * match on: `roads` and those around them, for counts near the area's edge.
 */
export function pullFlows(roads: FlowRoad[], others: FlowRoad[], counts: FlowCount[]): { flows: RoadFlows[]; counted: boolean } {
  const residuals: Record<FlowMode, (Match & { log: number })[]> = { walking: [], cycling: [], driving: [] };
  const grids = new Map<FlowMode, Grid>();
  for (const count of counts) {
    let grid = grids.get(count.mode);
    if (!grid) {
      grid = segmentGrid(others, count.mode);
      grids.set(count.mode, grid);
    }
    const match = nearestRoad(grid, count.point);
    // a motor count on a restricted road is of buses and deliveries, not cars
    if (!match || (count.mode === "driving" && restricted(match.road))) {
      continue;
    }
    // a count on one sidewalk of a street is about half the street's
    const street = !NOT_FOR_VEHICLES.has(match.road.kind) && match.road.kind !== "living_street";
    const sides = match.road.sidewalks === "left" || match.road.sidewalks === "right" ? 1 : 2;
    const daily = count.mode !== "driving" && street && !count.whole ? count.daily * sides : count.daily;
    residuals[count.mode].push({ ...match, log: Math.log(Math.max(daily, 1) / Math.max(match.value, 1)) });
  }

  const flows: RoadFlows[] = [];
  roads.forEach((road, index) => {
    const result: RoadFlows = { index };
    for (const mode of MODES) {
      const settings = SETTINGS[mode];
      const values = estimates(road, mode);
      if (!values) {
        continue;
      }
      if (mode === "driving" && restricted(road)) {
        // counts around do not pull a restricted road
        result[settings.out] = values.map((value) => Math.round(value));
        continue;
      }
      const farthest = Math.max(settings.reach, settings.otherReach);
      result[settings.out] = values.map((value, i) => {
        const p = road.line[i];
        let pull = 0;
        let weight = settings.weight;
        for (const r of residuals[mode]) {
          const distance = Math.hypot(r.at[0] - p[0], r.at[1] - p[1]);
          if (distance >= farthest) {
            continue;
          }
          const same = goesOn(r, road, p, mode);
          const reach = same ? settings.reach : settings.otherReach;
          if (distance < reach) {
            const w = falloff(distance, reach) * (same ? 1 : settings.other);
            pull += w * r.log;
            weight += w;
          }
        }
        return Math.max(0, Math.round(value * Math.exp(pull / weight)));
      });
    }
    if (result.footfall || result.cycling || result.motor) {
      flows.push(result);
    }
  });
  return { flows, counted: residuals.walking.length + residuals.cycling.length + residuals.driving.length > 0 };
}
