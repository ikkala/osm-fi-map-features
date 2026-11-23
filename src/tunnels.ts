// Tunnels. OSM does not tell a tunnel's depth: the network of the bored tunnels' points (tunnelNetwork), for their
// floors to be solved (floors.ts), the portals' walls, the ramps out of the portals (heights.ts),
// the buildings' walls opened over the tunnels, and the tunnels at the ground under buildings. Tunnels in cuts
// (cuts.ts) are left to their cut.
import { pointAlong } from "./bridges.ts";
import { densify, distancesAlong, distanceToRing, distanceToSegment, grownRect, inRect, lineLength, metersAlong, MinHeap, nearestOnLine, pointInPolygon, pointKey, pushTo, rectsMeet, type Point } from "./geometry.ts";
import { openPassages } from "./passages.ts";
import { inTunnel, offStructures, profileOf } from "./profile.ts";
import { bounds, LANE_WIDTH_M, type Building, type MapFeatures, type Opening, type Road } from "./osm.ts";
import { CLEARANCE_M, isRoad, ROOF_M, ROOM_SIDE_M, STAIRS_GRADE, TUNNEL_GRADE, userOf, WALKWAYS, widthOf, type Way } from "./ways.ts";

/** A road's room is as low as its maxheight=*, but no lower than this (m): lower is a mistake in the data */
const MIN_ROAD_CLEARANCE_M = 2.2;
/** A car park's room over its floor (m): the tunnels going down into a basement, when no road but a service way leads in; its service ways' lanes widen them */
export const CAR_PARK_CLEARANCE_M = 2.5;
/** The ground left over the roof (m), so that the ground's surface, smoothed between the model's points, stays over it */
export const COVER_M = 0.3;
/** The elevation model has the water's surface: the water is taken this deep over a tunnel (m) */
export const WATER_DEPTH_M = 3;
/** Under water this much ground stays between the water's bed and the roof, so a coarser model of the ground keeps some there (m) */
export const BED_M = 2;
/** A tunnel's lines get a point at least this often (m) */
const FLOOR_STEP_M = 10;
/** Ways that rise out of a tunnel as stairs do: a corridor goes on at the tunnel's level into a building and up in it */
const RISING = new Set(["steps", "corridor"]);
/** A portal's floor is the lowest ground at the tunnel's end and this far out along the ways leading on, and on past a short one (m) */
const PORTAL_REACH_M = 4;
const PORTAL_STEP_M = 2;
/** A tunnel this share under buildings, whose ground rises nowhere this much over its ends (m), runs at the ground; sampling step (m) */
const UNDER_BUILDINGS_SHARE = 0.5;
const AT_GRADE_RISE_M = 3;
const AT_GRADE_STEP_M = 2;
/** A building raised over such a tunnel is at least this tall (m) */
const MIN_RAISED_M = 3;
/** The model smooths a portal's wall into a slope over the tunnel's end: the ground over the room is raised to the ground this far in (m) */
const PORTAL_WALL_M = 6;
/** The portals' walls are looked up in squares this big (m) */
const WALL_CELL_M = 20;
/** A way over a portal's wall is levelled this far along it either way at most (m), looked at this often (m) */
const LEVEL_REACH_M = 10;
const LEVEL_STEP_M = 1;
/** ... where the model is more than this lower than the wall's top (m) */
const LEVEL_TOLERANCE_M = 0.3;

/** A tunnel's point */
export interface TunnelNode {
  p: Point;
  next: { key: string; length: number }[];
  /** How deep under the ground the floor has to be: room and roof for the deepest way through */
  depth: number;
  /** How far the room reaches either side of the line (m): the widest way through */
  half: number;
  /** The floor at a portal */
  portal?: number;
  /** Stairs lead up out of the tunnel here */
  stairs?: boolean;
  /** Stairs lead up out of the tunnel here, where it goes on past them */
  sideStairs?: boolean;
  /** The storeys (level=*) of the tunnel ways through it, when OSM tells */
  storeys?: number[];
  /** A portal in a building (a ramp down into a basement under it), which hides the cut a portal in the open has */
  inBuilding?: boolean;
  /** Under a building or in its wall: the lowest ground along its outline */
  house?: number;
  /** A car park's: its level, the lowest its floor goes, the room and roof under its building's lowest ground */
  level?: number;
  /** Its floor is known (floors.ts' KnownFloor), or runs straight between known floors, and stays */
  known?: boolean;
  floor: number;
}

/**
 * The ground over a tunnel's end, raised to `top` within `half` of `line` (from the portal in); `round`: around its
 * ends too; `tops`: the height at each of the line's points instead, evenly between them, `top` the highest
 */
export interface PortalWall {
  line: Point[];
  half: number;
  top: number;
  round?: boolean;
  tops?: number[];
}

/**
 * Builds tunnels (`layer` >= -1, not in a cut) that run at the ground under buildings as ground ways (atGrade),
 * opening the buildings' walls and raising what is over them. The elevation model leaves buildings out, so
 * such a way's ground is level with its ends. Tunnels joined at a point are one network, which runs at the
 * ground or under it as a whole. Returns how many ways run at the ground.
 */
export function uncoverAtGrade(features: MapFeatures, heightAt: (e: number, n: number) => number | undefined): number {
  const buildings = features.buildings
    .filter((b) => !b.part && b.shelter === undefined)
    .map((b) => ({ polygon: b.polygon, box: bounds(b.polygon.outer) }));
  const underBuilding = (p: Point) => buildings.some(({ polygon, box }) => inRect(p, box) && pointInPolygon(p, polygon));
  const tunnels = [...features.roads, ...features.rails]
    .filter((way) => profileOf(way).kind === "bored" && way.layer >= -1 && way.line.length >= 2)
    .map((way) => {
      const points = densify(way.line, AT_GRADE_STEP_M);
      const ground = points.map((p) => heightAt(...p));
      const ends = [ground[0], ground[ground.length - 1]];
      const top = Math.max(...ends.map((h) => h ?? Infinity));
      const level = ground.every((h) => h !== undefined && h <= top + AT_GRADE_RISE_M);
      // a road under a street has the street's level in the model, so it must be mostly under buildings;
      // railways are not under basements, and tracks beside them under one deck are only partly covered
      const road = isRoad(way);
      return { way, level, points: road ? points.length : 0, covered: road ? points.filter(underBuilding).length : 0 };
    });
  const networks = new Map<string, string>();
  const root = (k: string): string => {
    const parent = networks.get(k) ?? k;
    return parent === k ? k : root(parent);
  };
  for (const { way } of tunnels) {
    const [first, ...rest] = way.line.map((p) => root(pointKey(p)));
    for (const k of rest) {
      networks.set(k, first);
    }
  }
  const byNetwork = new Map<string, typeof tunnels>();
  for (const tunnel of tunnels) {
    const k = root(pointKey(tunnel.way.line[0]));
    pushTo(byNetwork, k, tunnel);
  }
  const passages: { line: Point[]; width: number; height: number; railway: boolean }[] = [];
  for (const network of byNetwork.values()) {
    const points = network.reduce((sum, t) => sum + t.points, 0);
    const covered = network.reduce((sum, t) => sum + t.covered, 0);
    if (!network.every((t) => t.level) || covered < points * UNDER_BUILDINGS_SHARE) {
      continue;
    }
    for (const { way } of network) {
      way.atGrade = true;
      passages.push({
        line: way.line,
        width: widthOf(way),
        height: roomHeight(way),
        railway: !isRoad(way),
      });
    }
  }
  openPassages(features.buildings, passages);
  // Open roofs and raised buildings (and any building over a railway, which stands on a deck) are lifted
  // to clear the way's room, counted from the lowest ground on the building's outline. An open roof over a
  // railway becomes a deck without posts, which would stand on the tracks.
  const rooms = passages.map((passage) => {
    const half = passage.width / 2 + ROOM_SIDE_M;
    const points = densify(passage.line, AT_GRADE_STEP_M).flatMap((p, i, all) => {
      const [a, c] = [all[Math.max(0, i - 1)], all[Math.min(all.length - 1, i + 1)]];
      const length = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      const [se, sn] = [(-(c[1] - a[1]) / length) * half, ((c[0] - a[0]) / length) * half];
      return [p, [p[0] + se, p[1] + sn], [p[0] - se, p[1] - sn]] satisfies Point[];
    });
    return { passage, points, box: bounds(points) };
  });
  for (const b of features.buildings) {
    const box = bounds(b.polygon.outer);
    const near = rooms.filter((r) => rectsMeet(r.box, box));
    if (near.length === 0) {
      continue;
    }
    const outline = densify([...b.polygon.outer, b.polygon.outer[0]], AT_GRADE_STEP_M);
    const low = Math.min(...outline.map((p) => heightAt(...p) ?? Infinity));
    for (const { passage, points } of near) {
      const under = points.filter((p) => inRect(p, box) && pointInPolygon(p, b.polygon));
      const top = Math.max(...under.map((p) => heightAt(...p) ?? -Infinity));
      if (!Number.isFinite(low) || !Number.isFinite(top)) {
        continue;
      }
      const room = top - low + passage.height;
      if (b.shelter !== undefined && passage.railway) {
        b.shelter = undefined;
        b.minHeight = room;
        b.height = room + ROOF_M;
      } else if (b.shelter !== undefined) {
        b.height = Math.max(b.height, room + ROOF_M);
      } else if (b.minHeight < room && (b.minHeight > 0 || passage.railway)) {
        const deck = b.height - b.minHeight <= ROOF_M;
        b.minHeight = room;
        b.height = deck ? room + ROOF_M : Math.max(b.height, room + MIN_RAISED_M);
      }
    }
  }
  return passages.length;
}

/** A tunnel's portal this near a building's outline (m), or inside it, is in the building's wall */
const PORTAL_IN_WALL_M = 1;
/** The wall is opened where the way crosses it within this far either side of the portal (m) */
const PORTAL_STUB_M = 2;

/** The point d meters from a towards c, or c when that is nearer */
function toward(a: Point, c: Point, d: number): Point {
  const length = Math.hypot(c[0] - a[0], c[1] - a[1]);
  const k = length > d ? d / length : 1;
  return [a[0] + (c[0] - a[0]) * k, a[1] + (c[1] - a[1]) * k];
}

/** Points along a building's outline this far apart (m) find the lowest ground its walls reach down to */
const OUTLINE_STEP_M = 2;
/** Less wall than this (m) left beside an opening up to a corner is opened too, rather than stand like a door ajar */
const SHORT_PIER_M = 2;

/** The opening reaching on along its wall to a corner less than SHORT_PIER_M beyond either end */
function toCorners(rings: Point[][], o: Opening): Opening {
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [a, c] = [ring[i], ring[(i + 1) % ring.length]];
      const length = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const along = (p: Point) => ((p[0] - a[0]) * (c[0] - a[0]) + (p[1] - a[1]) * (c[1] - a[1])) / length;
      const off = (p: Point) => Math.abs((p[0] - a[0]) * (c[1] - a[1]) - (p[1] - a[1]) * (c[0] - a[0])) / length;
      // on the edge itself, not on another edge in line with it
      const beside = (p: Point) => off(p) > 0.01 || along(p) < -0.01 || along(p) > length + 0.01;
      if (length === 0 || beside(o.from) || beside(o.to)) {
        continue;
      }
      const end = (p: Point): Point => {
        const d = along(p);
        return d < SHORT_PIER_M ? a : length - d < SHORT_PIER_M ? c : p;
      };
      return { ...o, from: end(o.from), to: end(o.to) };
    }
  }
  return o;
}

/** The lowest ground along a building's outline, which its walls reach down to */
export function lowestGround(b: Building, heightAt: (e: number, n: number) => number | undefined): number {
  return Math.min(...densify([...b.polygon.outer, b.polygon.outer[0]], OUTLINE_STEP_M).map((p) => heightAt(...p) ?? Infinity));
}

/** A building's walls stand on footings this deep under its lowest ground (m) */
export const WALL_FOOTING_M = 1.2;

/**
 * Opens the walls of the buildings where the tunnels going down from a portal in a building under it (`basements`
 * of solveFloors in floors.ts: a ramp into a car park under a house, and the ways on from it) cross them with their room over
 * the bottom of the walls' footings, under the building's lowest ground: at the portal, through the building's front,
 * and wherever else, under another of its walls or into a building a way comes up under. As wide as the room (the way
 * and ROOM_SIDE_M on both sides) and as tall, from its floor there up, without a room: the tunnel goes on under the
 * building. Returns how many openings.
 */
export function openPortals(buildings: Building[], basements: Road[], roads: Road[], heightAt: (e: number, n: number) => number | undefined): number {
  // the ends of the ways not in a tunnel, and the point next to each
  const outside = new Map<string, Point>();
  for (const r of roads) {
    if (!inTunnel(r) && r.line.length >= 2) {
      outside.set(pointKey(r.line[0]), r.line[1]);
      outside.set(pointKey(r.line[r.line.length - 1]), r.line[r.line.length - 2]);
    }
  }
  const lows = new Map<Building, number>();
  const lowest = (b: Building) => lows.get(b) ?? lows.set(b, lowestGround(b, heightAt)).get(b) ?? Infinity;
  let count = 0;
  for (const r of basements) {
    const floor = r.floor;
    if (!floor || floor.length !== r.line.length || r.line.length < 2) {
      continue;
    }
    // at a portal the wall is found a little out along the way leading on
    const line = [...r.line];
    const floors = [...floor];
    const first = outside.get(pointKey(r.line[0]));
    if (first) {
      line.unshift(toward(r.line[0], first, PORTAL_STUB_M));
      floors.unshift(floor[0]);
    }
    const last = outside.get(pointKey(r.line[r.line.length - 1]));
    if (last) {
      line.push(toward(r.line[r.line.length - 1], last, PORTAL_STUB_M));
      floors.push(floor[floor.length - 1]);
    }
    const room = roomHeight(r);
    const reach = bounds(line);
    for (const b of buildings) {
      const box = bounds(b.polygon.outer);
      if (!rectsMeet(box, reach)) {
        continue;
      }
      const before = b.passages?.length ?? 0;
      openPassages([b], [{ line, width: r.width + 2 * ROOM_SIDE_M, height: room }], false);
      const added = b.passages?.splice(before) ?? [];
      for (const o of added) {
        const at = nearestOnLine(line, [(o.from[0] + o.to[0]) / 2, (o.from[1] + o.to[1]) / 2]);
        const [a, c] = [line[at.segment], line[at.segment + 1]];
        const length = Math.hypot(c[0] - a[0], c[1] - a[1]);
        const t = length > 0 ? Math.hypot(at.point[0] - a[0], at.point[1] - a[1]) / length : 0;
        const ground = floors[at.segment] + (floors[at.segment + 1] - floors[at.segment]) * t;
        if (ground + room > lowest(b) - WALL_FOOTING_M) {
          (b.passages ??= []).push(toCorners([b.polygon.outer, ...b.polygon.holes], { ...o, ground }));
          count++;
        }
      }
      if (b.passages?.length === 0) {
        b.passages = undefined;
      }
    }
  }
  return count;
}

/** The tunnels' points (pointKey) with their neighbours, the portals and the depths the ways through them need */
export interface TunnelNetwork {
  tunnels: Way[];
  nodes: Map<string, TunnelNode>;
  /** The ways through each point */
  through: Map<string, Way[]>;
  /** The portals' walls, which raise the ground over the tunnels' ends (see `portalWallsAt`) */
  walls: PortalWall[];
  /** The ground raised to the walls */
  heightAt: (e: number, n: number) => number | undefined;
}

/**
 * The bored tunnels (not in a cut) as a network of points, their lines densified, for their floors to be solved
 * (floors.ts): the portals, where other ways lead on, at the lowest ground there; stairs' feet, the portals of a
 * tunnel with no other way out; the portals in buildings; the car parks' rooms; and the portals' walls. Ways on
 * another storey (`levels`) do not lead on: they go on from a lift.
 */
export function tunnelNetwork(features: MapFeatures, modelAt: (e: number, n: number) => number | undefined, levels: ReadonlyMap<Way, number[]> = new Map()): TunnelNetwork {
  const tunnels: Way[] = [...features.roads, ...features.rails].filter((w) => profileOf(w).kind === "bored" && w.line.length >= 2);
  const { nodes, through } = linkPoints(tunnels, levels);
  findPortals(features, tunnels, nodes, modelAt, levels);
  findHouses(features.buildings, nodes, modelAt);
  fitCarParks(tunnels, nodes, through);
  const walls = portalWalls(features.roads, tunnels, nodes, modelAt);
  const heightAt = raiseToWalls(modelAt, portalWallsAt(walls));
  return { tunnels, nodes, through, walls, heightAt };
}

/** The tunnels' points, their lines densified: their neighbours, the depth and the room's reach the ways through each need, and those ways */
function linkPoints(tunnels: Way[], levels: ReadonlyMap<Way, number[]>): { nodes: Map<string, TunnelNode>; through: Map<string, Way[]> } {
  const key = pointKey;
  const nodes = new Map<string, TunnelNode>();
  // the ways through each point, for its depth again once the car parks' rooms are set
  const through = new Map<string, Way[]>();
  for (const way of tunnels) {
    way.line = densify(way.line, FLOOR_STEP_M);
    for (const p of way.line) {
      pushTo(through, key(p), way);
    }
    const depth = COVER_M + ROOF_M + roomHeight(way);
    const half = widthOf(way) / 2 + ROOM_SIDE_M;
    const storeys = levels.get(way);
    way.line.forEach((p, i) => {
      const node = nodes.get(key(p)) ?? { p, next: [], depth: 0, half: 0, floor: Infinity };
      node.depth = Math.max(node.depth, depth);
      node.half = Math.max(node.half, half);
      if (storeys) {
        node.storeys = [...(node.storeys ?? []), ...storeys];
      }
      for (const q of [way.line[i - 1], way.line[i + 1]]) {
        if (q && !node.next.some((n) => n.key === key(q))) {
          node.next.push({ key: key(q), length: Math.hypot(q[0] - p[0], q[1] - p[1]) });
        }
      }
      nodes.set(key(p), node);
    });
  }
  return { nodes, through };
}

/**
 * The portals: the tunnels' free ends where other ways lead on, at the lowest ground there, but for ways on another
 * storey; stairs' feet, the portals of a tunnel with no other way out; and the points where stairs leave a tunnel
 * going on past them
 */
function findPortals(features: MapFeatures, tunnels: Way[], nodes: Map<string, TunnelNode>, modelAt: (e: number, n: number) => number | undefined, levels: ReadonlyMap<Way, number[]>): void {
  const key = pointKey;
  const inTunnels = new Set(tunnels);
  // the other ways by their ends, to look on past a short way out of a portal
  const byEnd = new Map<string, Way[]>();
  for (const way of [...features.roads, ...features.rails]) {
    if (!inTunnels.has(way) && way.line.length >= 2) {
      for (const p of [way.line[0], way.line[way.line.length - 1]]) {
        pushTo(byEnd, key(p), way);
      }
    }
  }
  /** Points d meters out along a way, or along the ways going on from its end */
  const outAt = (way: Way, outward: Point[], d: number): Point[] => {
    const p = pointAlong(outward, d);
    if (p) {
      return [p];
    }
    const end = outward[outward.length - 1];
    const length = lineLength(outward);
    return (byEnd.get(key(end)) ?? [])
      .filter((next) => next !== way)
      .map((next) => pointAlong(key(next.line[0]) === key(end) ? next.line : [...next.line].reverse(), d - length))
      .filter((q) => q !== undefined);
  };
  for (const way of [...features.roads, ...features.rails]) {
    if (inTunnels.has(way) || way.line.length < 2) {
      continue;
    }
    const storeys = levels.get(way);
    for (const outward of [way.line, [...way.line].reverse()]) {
      const node = nodes.get(key(outward[0]));
      if (node && node.storeys && storeys && !storeys.some((s) => node.storeys?.includes(s))) {
        continue;
      }
      if (node && node.next.length === 1 && isRoad(way) && RISING.has(way.kind)) {
        // stairs (or a corridor) up out: the floor at their foot is just deep enough, and they rise the rest
        const ground = modelAt(...node.p);
        if (ground !== undefined) {
          node.portal = Math.min(node.portal ?? Infinity, ground - node.depth);
          node.stairs = true;
        }
      } else if (node && node.next.length === 1) {
        const heights = [modelAt(...node.p)];
        for (let d = PORTAL_STEP_M; d <= PORTAL_REACH_M; d += PORTAL_STEP_M) {
          heights.push(...outAt(way, outward, d).map((p) => modelAt(...p)));
        }
        const known = heights.filter((h) => h !== undefined);
        if (known.length > 0) {
          node.portal = Math.min(node.portal ?? Infinity, ...known);
        }
      } else if (node && isRoad(way) && way.kind === "steps") {
        node.sideStairs = true;
      }
    }
  }

  // stairs' feet are portals only in tunnels with no other way out
  const fromPortal = spread(nodes, [...nodes].filter(([, node]) => node.portal !== undefined && !node.stairs).map(([k]) => [k, 0]), (length) => length);
  for (const [k, node] of nodes) {
    if (node.stairs && fromPortal.has(k)) {
      node.portal = undefined;
    }
  }
}

/** The points under a building or in its wall, and the portals in one that the tunnel goes in under from */
function findHouses(buildings: Building[], nodes: Map<string, TunnelNode>, modelAt: (e: number, n: number) => number | undefined): void {
  const grounded = buildings.filter((b) => b.shelter === undefined && b.minHeight === 0).map((b) => ({ b, box: bounds(b.polygon.outer) }));
  for (const node of nodes.values()) {
    const inward = node.next.map((next) => nodes.get(next.key)?.p).filter((p) => p !== undefined);
    const houses = grounded.filter(
      ({ b, box }) =>
        inRect(node.p, grownRect(box, PORTAL_IN_WALL_M)) && (pointInPolygon(node.p, b.polygon) || distanceToRing(node.p, b.polygon.outer) <= PORTAL_IN_WALL_M),
    );
    node.house = houses.length > 0 ? Math.min(...houses.map(({ b }) => lowestGround(b, modelAt))) : undefined;
    node.inBuilding = node.portal !== undefined && !node.stairs && houses.some(({ b }) => inward.some((p) => pointInPolygon(p, b.polygon)));
  }
}

/**
 * A car park under a building: the tunnels going down into it from a portal in a building, when no road but a
 * service way leads in among them, are as low as a car park, and their floors need that much less depth, and go no
 * lower than the car park's level under its building; a
 * service way of it with lanes (a ramp with a lane each way) is as wide as they are, where its width is its kind's,
 * one lane's, not OSM's
 */
function fitCarParks(tunnels: Way[], nodes: Map<string, TunnelNode>, through: Map<string, Way[]>): void {
  for (const group of meetingGroups(tunnels)) {
    const roads = group.ways.filter(isRoad);
    const vehicles = roads.filter((r) => !WALKWAYS.has(r.kind));
    if (
      roads.length === group.ways.length &&
      vehicles.length > 0 &&
      vehicles.every((r) => r.kind === "service") &&
      [...group.keys].some((k) => nodes.get(k)?.inBuilding)
    ) {
      for (const r of roads) {
        r.room = Math.min(roomHeight(r), CAR_PARK_CLEARANCE_M);
        if (r.kind === "service" && r.lanes !== undefined && r.lanes >= 2 && !r.widthTagged) {
          r.width = Math.max(r.width, r.lanes * LANE_WIDTH_M);
        }
      }
      for (const k of group.keys) {
        const node = nodes.get(k);
        if (node) {
          node.half = Math.max(node.half, ...(through.get(k) ?? []).map((way) => widthOf(way) / 2 + ROOM_SIDE_M));
          const depth = Math.max(...(through.get(k) ?? []).map((way) => COVER_M + ROOF_M + roomHeight(way)));
          if (node.stairs && node.portal !== undefined) {
            node.portal += node.depth - depth;
          }
          node.depth = depth;
        }
      }
      const inPark = [...group.keys].map((k) => nodes.get(k)).filter((node) => node !== undefined);
      const level = Math.min(...inPark.map((node) => (node.house === undefined ? Infinity : node.house - node.depth)));
      inPark.filter(() => Number.isFinite(level)).forEach((node) => (node.level = level));
    }
  }
}

/** The portals' walls: from here on the ground over a tunnel's end is no lower than the ground in from it */
function portalWalls(roads: Road[], tunnels: Way[], nodes: Map<string, TunnelNode>, modelAt: (e: number, n: number) => number | undefined): PortalWall[] {
  const walls: PortalWall[] = [];
  for (const [k, node] of nodes) {
    if (node.portal !== undefined && !node.stairs) {
      const line = inFromPortal(nodes, k, PORTAL_WALL_M);
      const top = modelAt(...line[line.length - 1]);
      if (top !== undefined && line.length >= 2) {
        walls.push({ line, half: node.half, top });
      }
    }
  }
  walls.push(...levelWaysOver(roads, tunnels, walls, modelAt));
  return walls;
}

/** The room over a tunnel's floor (m): its users' clearance, lower where `setTunnelRooms` set a road's */
export function roomHeight(way: Way): number {
  return (isRoad(way) ? way.room : undefined) ?? CLEARANCE_M[userOf(way)];
}

/**
 * Gives the tunnels under a bridge's deck (deckOver: the deck over a point, over a way on a layer), as through its
 * abutment, a room as tall as the deck leaves over their floors under their roofs, where that is lower than their
 * own, but no lower than MIN_ROAD_CLEARANCE_M: their floors are set before the decks, from the elevation model, which
 * has the ground under a bridge's end up at its deck. Returns how many tunnels got a lower room.
 */
export function fitRoomsUnderDecks(roads: Road[], deckOver: (p: Point, layer: number) => { deck: number } | undefined): number {
  let count = 0;
  for (const way of roads) {
    const floor = way.floor;
    if (profileOf(way).kind !== "bored" || !floor || way.line.length < 2) {
      continue;
    }
    let room = roomHeight(way);
    for (let i = 0; i + 1 < way.line.length; i++) {
      const [a, b] = [way.line[i], way.line[i + 1]];
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const over = deckOver([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], way.layer);
        if (over) {
          room = Math.min(room, over.deck - ROOF_M - (floor[i] + (floor[i + 1] - floor[i]) * t));
        }
      }
    }
    if (room < roomHeight(way) - 1e-6) {
      way.room = Math.max(MIN_ROAD_CLEARANCE_M, room);
      count++;
    }
  }
  return count;
}

/**
 * Gives the vehicles' tunnels that meet at their points a room as tall as the tallest maxheight=* among them,
 * when it is lower than a road's: the signs at a car park's entrances tell the room inside, and tunnels sharing a
 * hall share its height; so do walkways' tunnels meeting them or beside them, when lower than theirs. Returns how
 * many tunnels got a room.
 */
export function setTunnelRooms(roads: Road[]): number {
  const tunnels = roads.filter((r) => inTunnel(r) && !WALKWAYS.has(r.kind) && r.line.length >= 2);
  const lowered: Road[] = [];
  for (const { ways } of meetingGroups(tunnels)) {
    const heights = ways.flatMap((way) => ("maxHeight" in way && way.maxHeight !== undefined ? [way.maxHeight] : []));
    const height = heights.length > 0 ? Math.max(...heights) : undefined;
    for (const way of tunnels.filter((t) => ways.includes(t))) {
      if (height !== undefined && height < CLEARANCE_M.vehicles) {
        way.room = Math.max(MIN_ROAD_CLEARANCE_M, height);
        lowered.push(way);
      }
    }
  }
  // a walkway's tunnel meeting one of them, or beside it in one hall, is no taller
  let walkways = 0;
  for (const way of roads.filter((r) => inTunnel(r) && WALKWAYS.has(r.kind) && r.line.length >= 2)) {
    const keys = new Set(way.line.map(pointKey));
    const touching = lowered.filter(
      (t) => t.line.some((p) => keys.has(pointKey(p))) || linesWithin(way.line, t.line, way.width / 2 + t.width / 2 + ROOM_SIDE_M * 2),
    );
    const room = Math.max(...touching.map((t) => t.room ?? CLEARANCE_M.vehicles));
    if (touching.length > 0 && room < CLEARANCE_M.people) {
      way.room = room;
      walkways++;
    }
  }
  return lowered.length + walkways;
}

/** The room's sides at a node and halfway to its neighbours, `half` either side of the line */
export function acrossRoom(nodes: Map<string, TunnelNode>, node: TunnelNode): Point[] {
  const sides: Point[] = [];
  for (const { key: q } of node.next) {
    const other = nodes.get(q);
    if (!other) {
      continue;
    }
    const [de, dn] = [other.p[0] - node.p[0], other.p[1] - node.p[1]];
    const length = Math.hypot(de, dn);
    if (length === 0) {
      continue;
    }
    const [ae, an] = [(-dn / length) * node.half, (de / length) * node.half];
    for (const [e, n] of [node.p, [node.p[0] + de / 2, node.p[1] + dn / 2]]) {
      sides.push([e + ae, n + an], [e - ae, n - an]);
    }
  }
  return sides;
}

/** The tunnel's line from a portal in, as far as `length` or to the next junction or end */
function inFromPortal(nodes: Map<string, TunnelNode>, start: string, length: number): Point[] {
  const first = nodes.get(start);
  if (!first) {
    return [];
  }
  const line: Point[] = [first.p];
  let previous = start;
  let step: { key: string; length: number } | undefined = first.next[0];
  let along = 0;
  while (step) {
    const node = nodes.get(step.key);
    if (!node) {
      break;
    }
    if (along + step.length >= length) {
      const a = line[line.length - 1];
      const t = (length - along) / step.length;
      line.push([a[0] + (node.p[0] - a[0]) * t, a[1] + (node.p[1] - a[1]) * t]);
      break;
    }
    line.push(node.p);
    along += step.length;
    if (node.next.length !== 2) {
      break;
    }
    const onward = node.next.find((n) => n.key !== previous);
    previous = step.key;
    step = onward;
  }
  return line;
}

/**
 * The ground under the ways over the portals' walls, raised to the wall's top under their width as far as the
 * model has it lower, the cut in front of a portal being often wider than the tunnel: up to LEVEL_REACH_M either
 * way along the way, and where the model is lower still past that, falling evenly to it over that reach rather than
 * in a step. Ways meeting the tunnels and ways in front of a portal are not over its wall, nor a way beside
 * it whose width only reaches over the room: the ground over the tunnel may be higher than a street along it.
 */
function levelWaysOver(roads: Road[], tunnels: Way[], walls: PortalWall[], modelAt: (e: number, n: number) => number | undefined): PortalWall[] {
  const meeting = new Set(tunnels.flatMap((t) => t.line.map(pointKey)));
  const candidates = roads
    .filter((r) => offStructures(r) && r.line.length >= 2 && !r.line.some((p) => meeting.has(pointKey(p))))
    .map((road) => ({ road, box: bounds(road.line) }));
  const levelled: PortalWall[] = [];
  for (const wall of walls) {
    const box = bounds(wall.line);
    for (const { road, box: b } of candidates) {
      const half = road.width / 2;
      const margin = wall.half + half;
      if (!rectsMeet(b, box, margin)) {
        continue;
      }
      // where along the road its width is over the wall: the wall widened by the road's half; its line must be too
      const reachOver = portalWallsAt([{ ...wall, half: margin }]);
      const lineOver = portalWallsAt([wall]);
      const length = lineLength(road.line);
      const onWall: number[] = [];
      let over = false;
      for (let d = 0; d <= length; d += LEVEL_STEP_M) {
        const p = pointAlong(road.line, d);
        if (p && reachOver(...p) !== undefined) {
          onWall.push(d);
          over ||= lineOver(...p) !== undefined;
        }
      }
      if (!over) {
        continue;
      }
      // on from there while the model is lower than the wall's top
      const lower = (d: number) => {
        const p = pointAlong(road.line, d);
        const h = p && modelAt(...p);
        return h !== undefined && h < wall.top - LEVEL_TOLERANCE_M;
      };
      const [first, last] = [onWall[0], onWall[onWall.length - 1]];
      let [from, to] = [first, last];
      while (from > 0 && first - from < LEVEL_REACH_M && lower(from - LEVEL_STEP_M)) {
        from = Math.max(0, from - LEVEL_STEP_M);
      }
      while (to < length && to - last < LEVEL_REACH_M && lower(to + LEVEL_STEP_M)) {
        to = Math.min(length, to + LEVEL_STEP_M);
      }
      // the model's height at the reach's end d, beyond: the next point on, when the model is lower there still
      const lowAt = (d: number, beyond: number) => {
        const reached = Math.abs(d - (beyond < d ? first : last)) >= LEVEL_REACH_M;
        const p = reached && beyond >= 0 && beyond <= length && lower(beyond) ? pointAlong(road.line, d) : undefined;
        const h = p && modelAt(...p);
        return h === undefined ? wall.top : h;
      };
      const [lowFrom, lowTo] = [lowAt(from, from - LEVEL_STEP_M), lowAt(to, to + LEVEL_STEP_M)];
      if (lowFrom === wall.top && lowTo === wall.top) {
        const line = stretchOf(road.line, from, to);
        if (line.length >= 2) {
          levelled.push({ line, half, top: wall.top, round: true });
        }
        continue;
      }
      const line = [...stretchOf(road.line, from, first), ...stretchOf(road.line, first, last).slice(1), ...stretchOf(road.line, last, to).slice(1)];
      const along = distancesAlong(line, from);
      const tops = along.map((d) =>
        d < first ? lowFrom + ((wall.top - lowFrom) * (d - from)) / (first - from) : d > last ? lowTo + ((wall.top - lowTo) * (to - d)) / (to - last) : wall.top,
      );
      levelled.push({ line, half, top: wall.top, round: true, tops });
    }
  }
  return levelled;
}

/** The part of a line from `from` to `to` meters along it */
function stretchOf(line: Point[], from: number, to: number): Point[] {
  const out: Point[] = [];
  let along = 0;
  for (let i = 0; i < line.length; i++) {
    const step = i > 0 ? Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]) : 0;
    along += step;
    if (along > from && along < to) {
      out.push(line[i]);
    }
  }
  const [a, c] = [pointAlong(line, from), pointAlong(line, to) ?? line[line.length - 1]];
  return [...(a ? [a] : []), ...out, c];
}

/** The ground's height, raised to the portals' walls (`portalWallsAt`) over the tunnels' ends */
export function raiseToWalls(
  heightAt: (e: number, n: number) => number | undefined,
  wallsAt: (e: number, n: number) => number | undefined,
): (e: number, n: number) => number | undefined {
  return (e, n) => {
    const h = heightAt(e, n);
    const top = h === undefined ? undefined : wallsAt(e, n);
    return h === undefined || top === undefined ? h : Math.max(h, top);
  };
}

/** The height the portals' walls raise the ground to at a point (the highest wall there), or undefined off them */
export function portalWallsAt(walls: readonly PortalWall[]): (e: number, n: number) => number | undefined {
  const cell = (v: number) => Math.floor(v / WALL_CELL_M);
  const cellKey = (x: number, y: number) => (x + 0x8000) * 0x10000 + (y + 0x8000);
  const cells = new Map<number, PortalWall[]>();
  for (const wall of walls) {
    const box = bounds(wall.line);
    for (let x = cell(box.minX - wall.half); x <= cell(box.maxX + wall.half); x++) {
      for (let y = cell(box.minY - wall.half); y <= cell(box.maxY + wall.half); y++) {
        pushTo(cells, cellKey(x, y), wall);
      }
    }
  }
  // the wall's height over the room: beside a stretch of the line, not beyond the portal or the wall's inner end
  // (unless round); undefined off it
  const over = (wall: PortalWall, e: number, n: number) => {
    const at = (i: number) => wall.tops?.[i] ?? wall.top;
    let top: number | undefined;
    const raise = (h: number) => {
      top = Math.max(top ?? -Infinity, h);
    };
    wall.line.forEach((a, i) => {
      const c = wall.line[i + 1];
      if (!c) {
        return;
      }
      const [dx, dy] = [c[0] - a[0], c[1] - a[1]];
      const lengthSq = dx * dx + dy * dy;
      const t = lengthSq > 0 ? ((e - a[0]) * dx + (n - a[1]) * dy) / lengthSq : -1;
      if (t >= 0 && t <= 1) {
        if (Math.abs((e - a[0]) * dy - (n - a[1]) * dx) <= wall.half * Math.sqrt(lengthSq)) {
          raise(at(i) + (at(i + 1) - at(i)) * t);
        }
      } else if (wall.round === true) {
        if (Math.hypot(e - a[0], n - a[1]) <= wall.half) {
          raise(at(i));
        }
        if (Math.hypot(e - c[0], n - c[1]) <= wall.half) {
          raise(at(i + 1));
        }
      }
    });
    return top;
  };
  return (e, n) => {
    let top: number | undefined;
    for (const wall of cells.get(cellKey(cell(e), cell(n))) ?? []) {
      if (wall.top > (top ?? -Infinity)) {
        const h = over(wall, e, n);
        if (h !== undefined && h > (top ?? -Infinity)) {
          top = h;
        }
      }
    }
    return top;
  };
}

/** A node's point and the points halfway to its neighbours */
export function pointsAround(nodes: Map<string, TunnelNode>, node: TunnelNode): Point[] {
  return [node.p, ...node.next.map(({ key: q }) => nodes.get(q)?.p).filter((q) => q !== undefined).map((q): Point => [(node.p[0] + q[0]) / 2, (node.p[1] + q[1]) / 2])];
}

/** The tunnels in groups that meet at their points (not those only side by side or crossing), and their points' keys */
function meetingGroups(tunnels: Way[]): { ways: Way[]; keys: Set<string> }[] {
  const parent = tunnels.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byKey = new Map<string, number>();
  tunnels.forEach((way, i) => {
    for (const p of way.line) {
      const other = byKey.get(pointKey(p));
      if (other === undefined) {
        byKey.set(pointKey(p), i);
      } else {
        parent[find(i)] = find(other);
      }
    }
  });
  const groups = new Map<number, { ways: Way[]; keys: Set<string> }>();
  tunnels.forEach((way, i) => {
    const group = groups.get(find(i)) ?? { ways: [], keys: new Set<string>() };
    group.ways.push(way);
    for (const p of way.line) {
      group.keys.add(pointKey(p));
    }
    groups.set(find(i), group);
  });
  return [...groups.values()];
}

/** Whether two lines come within `reach` of each other anywhere (looked at every meter along the first) */
function linesWithin(line: Point[], other: Point[], reach: number): boolean {
  for (let i = 0; i + 1 < line.length; i++) {
    for (const p of metersAlong(line[i], line[i + 1])) {
      for (let k = 0; k + 1 < other.length; k++) {
        if (distanceToSegment(p, other[k], other[k + 1]) < reach) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Shortest-path search: the least start + cost(meters along the tunnels) at every node reached */
export function spread(nodes: Map<string, TunnelNode>, starts: [string, number][], cost: (length: number) => number): Map<string, number> {
  const best = new Map<string, number>();
  const heap = new MinHeap<string>();
  const reach = (k: string, value: number) => {
    if (value < (best.get(k) ?? Infinity)) {
      best.set(k, value);
      heap.push(k, value);
    }
  };
  starts.forEach(([k, value]) => reach(k, value));
  for (let top = heap.pop(); top; top = heap.pop()) {
    if (top.value > (best.get(top.item) ?? Infinity)) {
      continue;
    }
    for (const { key: k, length } of nodes.get(top.item)?.next ?? []) {
      reach(k, top.value + cost(length));
    }
  }
  return best;
}
