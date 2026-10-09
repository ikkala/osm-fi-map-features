// Tunnel floors. OSM does not tell a tunnel's depth, so the floor hangs between its portals' ground (a
// branching network like a stretched net), deep enough for the room and roof, and no steeper than a road
// tunnel, and deep enough under the ways crossing over it. Tunnels in cuts (cuts.ts) are left to their cut.
import { pointAlong } from "./bridges.ts";
import { pointInPolygon, pointKey, type Point } from "./geometry.ts";
import { bounds, openPassages, type MapFeatures, type Rail, type Road } from "./osm.ts";

/** Room over the floor for people, vehicles and trains (m) */
export const WALK_CLEARANCE_M = 3;
export const ROAD_CLEARANCE_M = 4.8;
export const RAIL_CLEARANCE_M = 6;
/** The roof over the room, under the ground (m) */
export const ROOF_M = 1;
/** The elevation model has the water's surface: the water is taken this deep over a tunnel (m) */
export const WATER_DEPTH_M = 3;
/** Ways for people only (as osm.ts's NOT_FOR_VEHICLES) */
export const WALKWAYS = new Set(["footway", "pedestrian", "cycleway", "path", "track", "bridleway", "steps", "corridor"]);
/** A tunnel's lines get a point at least this often (m) */
const FLOOR_STEP_M = 10;
/** The floor rises or falls at most this much a meter */
const MAX_GRADE = 0.07;
/** Stairs out of a tunnel rise at most this much a meter */
const STAIRS_GRADE = 0.6;
/** Ways that rise out of a tunnel as stairs do: a corridor goes on at the tunnel's level into a building and up in it */
const RISING = new Set(["steps", "corridor"]);
/** A portal's floor is the lowest ground at the tunnel's end and this far out along the ways leading on, and on past a short one (m) */
const PORTAL_REACH_M = 4;
const PORTAL_STEP_M = 2;
/** The floor is as deep under the ground as the way needs from this far in from a portal (m) */
const PORTAL_EASE_M = 30;
/** A way leading on from a portal ramps down to the floor when the ground there is this much over it (m); sampling step and reach (m) */
const RAMP_TOLERANCE_M = 0.3;
const RAMP_STEP_M = 2;
const RAMP_REACH_M = 40;
/** A ramp goes on past a short way out of a portal at most this far from the portal (m): beyond the wall the model has the open ground */
const RAMP_ON_M = 8;
/** ... and only with at least this much of that left to rise in (m), so the ramp going on is no wall */
const RAMP_ON_LEFT_M = 4;
/** A tunnel this share under buildings, whose ground rises nowhere this much over its ends (m), runs at the ground; sampling step (m) */
const UNDER_BUILDINGS_SHARE = 0.5;
const AT_GRADE_RISE_M = 3;
const AT_GRADE_STEP_M = 2;
/** A way's room reaches this far beyond it on both sides (m) */
const ROOM_SIDE_M = 1;
/** A building raised over such a tunnel is at least this tall (m) */
const MIN_RAISED_M = 3;
/** A railway's width, for the openings in the walls of buildings over it (as cuts.ts's) */
const RAIL_WIDTH_M = 3;
/** A way crossing a tunnel this near its free end (m), or beyond it, passes its portal, not over it */
const OVER_PORTAL_M = 1;
/** The model smooths a portal's wall into a slope over the tunnel's end: the ground over the room is raised to the ground this far in (m) */
const PORTAL_WALL_M = 6;
/** The portals' walls are looked up in squares this big (m) */
const WALL_CELL_M = 20;
/** A way over a portal's wall is levelled this far along it either way at most (m), looked at this often (m) */
const LEVEL_REACH_M = 10;
const LEVEL_STEP_M = 1;
/** A floor bends over the line between its neighbours at most this much (m) at a point, smoothed this many rounds at most */
const MAX_BEND_M = 0.1;
const SMOOTH_ROUNDS = 500;
/** Junction floors are averaged this many rounds (they settle in far fewer) */
const ROUNDS = 1000;

type Way = Road | Rail;

interface Node {
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
  /** The storeys (level=*) of the tunnel ways through it, when OSM tells */
  storeys?: number[];
  floor: number;
}

/** The ground over a tunnel's end, raised to `top` within `half` of `line` (from the portal in); `round`: around its ends too */
export interface PortalWall {
  line: Point[];
  half: number;
  top: number;
  round?: boolean;
}

/**
 * Turns tunnels (`layer` >= -1, not in a cut) that run at the ground under buildings into ground ways,
 * opening the buildings' walls and raising what is over them. The elevation model leaves buildings out, so
 * such a way's ground is level with its ends. Tunnels joined at a point are one network, which runs at the
 * ground or under it as a whole. Returns how many ways run at the ground.
 */
export function uncoverAtGrade(features: MapFeatures, heightAt: (e: number, n: number) => number | undefined): number {
  const buildings = features.buildings
    .filter((b) => !b.part && b.shelter === undefined)
    .map((b) => ({ polygon: b.polygon, box: bounds(b.polygon.outer) }));
  const underBuilding = ([e, n]: Point) =>
    buildings.some(({ polygon, box }) => e >= box.minX && e <= box.maxX && n >= box.minY && n <= box.maxY && pointInPolygon([e, n], polygon));
  const tunnels = [...features.roads, ...features.rails]
    .filter((way) => way.tunnel && !way.lid && way.layer >= -1 && way.line.length >= 2)
    .map((way) => {
      const points = densify(way.line, AT_GRADE_STEP_M);
      const ground = points.map((p) => heightAt(...p));
      const ends = [ground[0], ground[ground.length - 1]];
      const top = Math.max(...ends.map((h) => h ?? Infinity));
      const level = ground.every((h) => h !== undefined && h <= top + AT_GRADE_RISE_M);
      // a road under a street has the street's level in the model, so it must be mostly under buildings;
      // railways are not under basements, and tracks beside them under one deck are only partly covered
      const road = "width" in way;
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
    byNetwork.set(k, [...(byNetwork.get(k) ?? []), tunnel]);
  }
  const passages: { line: Point[]; width: number; height: number; railway: boolean }[] = [];
  for (const network of byNetwork.values()) {
    const points = network.reduce((sum, t) => sum + t.points, 0);
    const covered = network.reduce((sum, t) => sum + t.covered, 0);
    if (!network.every((t) => t.level) || covered < points * UNDER_BUILDINGS_SHARE) {
      continue;
    }
    for (const { way } of network) {
      const road = "width" in way;
      way.tunnel = false;
      passages.push({
        line: way.line,
        width: road ? way.width : RAIL_WIDTH_M,
        height: road ? (WALKWAYS.has(way.kind) ? WALK_CLEARANCE_M : ROAD_CLEARANCE_M) : RAIL_CLEARANCE_M,
        railway: !road,
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
    const near = rooms.filter((r) => r.box.minX <= box.maxX && r.box.maxX >= box.minX && r.box.minY <= box.maxY && r.box.maxY >= box.minY);
    if (near.length === 0) {
      continue;
    }
    const outline = densify([...b.polygon.outer, b.polygon.outer[0]], AT_GRADE_STEP_M);
    const low = Math.min(...outline.map((p) => heightAt(...p) ?? Infinity));
    for (const { passage, points } of near) {
      const under = points.filter(([e, n]) => e >= box.minX && e <= box.maxX && n >= box.minY && n <= box.maxY && pointInPolygon([e, n], b.polygon));
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

/**
 * Sets `floor` on tunnels not in a cut (densifying their lines) and on ramps split off the ways leading on
 * from their portals. Ways on another storey (`levels`) do not lead on: they go on from a lift. Returns the
 * portals' walls, which raise the ground over the tunnels' ends (see `portalWallsAt`).
 */
export function setTunnelFloors(
  features: MapFeatures,
  modelAt: (e: number, n: number) => number | undefined,
  levels: ReadonlyMap<Way, number[]> = new Map(),
): { floors: number; ramps: number; walls: PortalWall[] } {
  const tunnels: Way[] = [...features.roads, ...features.rails].filter((w) => w.tunnel && !w.lid && w.line.length >= 2);
  const key = pointKey;
  const nodes = new Map<string, Node>();
  for (const way of tunnels) {
    way.line = densify(way.line, FLOOR_STEP_M);
    const depth = ROOF_M + ("width" in way ? (WALKWAYS.has(way.kind) ? WALK_CLEARANCE_M : ROAD_CLEARANCE_M) : RAIL_CLEARANCE_M);
    const half = ("width" in way ? way.width : RAIL_WIDTH_M) / 2 + ROOM_SIDE_M;
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

  // portals: the tunnels' free ends where other ways lead on
  const inTunnels = new Set(tunnels);
  // the other ways by their ends, to look on past a short way out of a portal
  const byEnd = new Map<string, Way[]>();
  for (const way of [...features.roads, ...features.rails]) {
    if (!inTunnels.has(way) && way.line.length >= 2) {
      for (const p of [way.line[0], way.line[way.line.length - 1]]) {
        byEnd.set(key(p), [...(byEnd.get(key(p)) ?? []), way]);
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
    const length = outward.reduce((sum, q, i) => (i > 0 ? sum + Math.hypot(q[0] - outward[i - 1][0], q[1] - outward[i - 1][1]) : 0), 0);
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
      if (node && node.next.length === 1 && "width" in way && RISING.has(way.kind)) {
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

  // the portals' walls: from here on the ground over a tunnel's end is no lower than the ground in from it
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
  walls.push(...levelWaysOver(features.roads, tunnels, walls, modelAt));
  const heightAt = raiseToWalls(modelAt, portalWallsAt(walls));

  hang(nodes);

  // deep enough under the ground here and halfway to the neighbours; eased in from the portals, whose
  // walls the elevation model smooths into slopes
  const waters = features.areas.filter((a) => a.kind === "water").map((a) => ({ polygon: a.polygon, box: bounds(a.polygon.outer) }));
  const inWater = ([e, n]: Point) =>
    waters.some(({ polygon, box }) => e >= box.minX && e <= box.maxX && n >= box.minY && n <= box.maxY && pointInPolygon([e, n], polygon));
  for (const [k, node] of nodes) {
    const around = [node.p, ...node.next.map(({ key: q }) => nodes.get(q)?.p).filter((q) => q !== undefined).map((q): Point => [(node.p[0] + q[0]) / 2, (node.p[1] + q[1]) / 2])];
    const ground = around.map((p) => heightAt(...p)).filter((h) => h !== undefined);
    if (ground.length > 0) {
      const depth = node.depth * Math.min(1, (fromPortal.get(k) ?? Infinity) / PORTAL_EASE_M) + (inWater(node.p) ? WATER_DEPTH_M : 0);
      node.floor = Math.min(node.floor, Math.min(...ground) - depth);
    }
  }

  // deep enough under the ways crossing over: from there the floor rises no steeper than MAX_GRADE, also to
  // the portals, whose ways leading on then ramp down to them
  const crossed = spread(nodes, underCrossings(features, tunnels, nodes, heightAt), (length) => MAX_GRADE * length);
  for (const [k, node] of nodes) {
    node.floor = Math.min(node.floor, crossed.get(k) ?? Infinity);
  }

  // no steeper than MAX_GRADE: the floor is lowered toward the low points, but not at the portals
  const lowest = spread(
    nodes,
    [...nodes].filter(([, node]) => Number.isFinite(node.floor)).map(([k, node]) => [k, node.floor]),
    (length) => MAX_GRADE * length,
  );
  for (const [k, node] of nodes) {
    if (node.portal === undefined) {
      node.floor = lowest.get(k) ?? node.floor;
    }
  }

  smoothFloors(nodes);

  let floors = 0;
  for (const way of tunnels) {
    const floor = way.line.map((p) => nodes.get(key(p))?.floor ?? Infinity);
    if (floor.every(Number.isFinite)) {
      way.floor = floor;
      floors++;
    }
  }

  // the ways leading on ramp down to the floor (the model has the portal wall's top), outside the walls
  const portalFloor = (p: Point) => {
    const node = nodes.get(key(p));
    return (node?.portal !== undefined || node?.stairs) && Number.isFinite(node.floor) ? node.floor : undefined;
  };
  const ramps = rampOut(features.roads, inTunnels, portalFloor, modelAt) + rampOut(features.rails, inTunnels, portalFloor, modelAt);
  return { floors, ramps, walls };
}

/** The tunnel's line from a portal in, as far as `length` or to the next junction or end */
function inFromPortal(nodes: Map<string, Node>, start: string, length: number): Point[] {
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
 * way along the way. Ways meeting the tunnels and ways in front of a portal are not over its wall.
 */
function levelWaysOver(roads: Road[], tunnels: Way[], walls: PortalWall[], modelAt: (e: number, n: number) => number | undefined): PortalWall[] {
  const meeting = new Set(tunnels.flatMap((t) => t.line.map(pointKey)));
  const candidates = roads
    .filter((r) => !r.tunnel && !r.bridge && !r.deck && !r.lid && !r.floor && r.line.length >= 2 && !r.line.some((p) => meeting.has(pointKey(p))))
    .map((road) => ({ road, box: bounds(road.line) }));
  const levelled: PortalWall[] = [];
  for (const wall of walls) {
    const box = bounds(wall.line);
    for (const { road, box: b } of candidates) {
      const half = road.width / 2;
      const margin = wall.half + half;
      if (b.maxX < box.minX - margin || b.minX > box.maxX + margin || b.maxY < box.minY - margin || b.minY > box.maxY + margin) {
        continue;
      }
      // where along the road its width is over the wall: the wall widened by the road's half
      const reachOver = portalWallsAt([{ ...wall, half: margin }]);
      const length = road.line.reduce((sum, q, i) => (i > 0 ? sum + Math.hypot(q[0] - road.line[i - 1][0], q[1] - road.line[i - 1][1]) : 0), 0);
      const onWall: number[] = [];
      for (let d = 0; d <= length; d += LEVEL_STEP_M) {
        const p = pointAlong(road.line, d);
        if (p && reachOver(...p) !== undefined) {
          onWall.push(d);
        }
      }
      if (onWall.length === 0) {
        continue;
      }
      // on from there while the model is lower than the wall's top
      const lower = (d: number) => {
        const p = pointAlong(road.line, d);
        const h = p && modelAt(...p);
        return h !== undefined && h < wall.top - RAMP_TOLERANCE_M;
      };
      let [from, to] = [onWall[0], onWall[onWall.length - 1]];
      while (from > 0 && onWall[0] - from < LEVEL_REACH_M && lower(from - LEVEL_STEP_M)) {
        from = Math.max(0, from - LEVEL_STEP_M);
      }
      while (to < length && to - onWall[onWall.length - 1] < LEVEL_REACH_M && lower(to + LEVEL_STEP_M)) {
        to = Math.min(length, to + LEVEL_STEP_M);
      }
      const line = stretchOf(road.line, from, to);
      if (line.length >= 2) {
        levelled.push({ line, half, top: wall.top, round: true });
      }
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
        cells.set(cellKey(x, y), [...(cells.get(cellKey(x, y)) ?? []), wall]);
      }
    }
  }
  // over the room: beside a stretch of the line, not beyond the portal or the wall's inner end (unless round)
  const over = (wall: PortalWall, e: number, n: number) =>
    wall.line.some((a, i) => {
      const c = wall.line[i + 1];
      if (!c) {
        return false;
      }
      const [dx, dy] = [c[0] - a[0], c[1] - a[1]];
      const lengthSq = dx * dx + dy * dy;
      const t = lengthSq > 0 ? ((e - a[0]) * dx + (n - a[1]) * dy) / lengthSq : -1;
      if (t >= 0 && t <= 1) {
        return Math.abs((e - a[0]) * dy - (n - a[1]) * dx) <= wall.half * Math.sqrt(lengthSq);
      }
      return wall.round === true && Math.min(Math.hypot(e - a[0], n - a[1]), Math.hypot(e - c[0], n - c[1])) <= wall.half;
    });
  return (e, n) => {
    let top: number | undefined;
    for (const wall of cells.get(cellKey(cell(e), cell(n))) ?? []) {
      if (wall.top > (top ?? -Infinity) && over(wall, e, n)) {
        top = wall.top;
      }
    }
    return top;
  };
}

/**
 * The floors the ways over tunnels need at the tunnels' points either side of where a way passes over: the
 * room and roof under the ground there. A way is over a tunnel where its width and the tunnel's room overlap,
 * looked at every meter along the tunnel but not at its free ends, nor beyond them (a way going on past a
 * portal from a short way out of it). Ways at a tunnel's level or under it,
 * bridges, tunnels and the ways meeting it are not over it.
 */
function underCrossings(features: MapFeatures, tunnels: Way[], nodes: Map<string, Node>, heightAt: (e: number, n: number) => number | undefined): [string, number][] {
  const inTunnels = new Set(tunnels);
  const over = [...features.roads, ...features.rails]
    .filter((w) => !inTunnels.has(w) && !w.tunnel && !w.bridge && w.line.length >= 2)
    .map((way) => ({ way, box: bounds(way.line), half: ("width" in way ? way.width : RAIL_WIDTH_M) / 2 }));
  const floors: [string, number][] = [];
  for (const tunnel of tunnels) {
    const reach = ("width" in tunnel ? tunnel.width : RAIL_WIDTH_M) / 2 + ROOM_SIDE_M;
    const box = bounds(tunnel.line);
    const points = new Set(tunnel.line.map(pointKey));
    // the free ends, each with the way in from it
    const last = tunnel.line.length - 1;
    const freeEnds = [
      [tunnel.line[0], tunnel.line[1]],
      [tunnel.line[last], tunnel.line[last - 1]],
    ]
      .filter(([q]) => nodes.get(pointKey(q))?.next.length === 1)
      .map(([q, r]) => {
        const length = Math.hypot(r[0] - q[0], r[1] - q[1]) || 1;
        return { q, inward: [(r[0] - q[0]) / length, (r[1] - q[1]) / length] satisfies Point };
      });
    // a way's point beyond a free end, or within OVER_PORTAL_M in from it, passes the portal
    const pastPortal = (p: Point, at: Point, margin: number) =>
      freeEnds.some(
        ({ q, inward }) =>
          Math.hypot(p[0] - q[0], p[1] - q[1]) <= margin + OVER_PORTAL_M && (at[0] - q[0]) * inward[0] + (at[1] - q[1]) * inward[1] < OVER_PORTAL_M,
      );
    for (const { way, box: b, half } of over) {
      const margin = reach + half;
      if (
        way.layer <= tunnel.layer ||
        b.maxX < box.minX - margin || b.minX > box.maxX + margin || b.maxY < box.minY - margin || b.minY > box.maxY + margin ||
        way.line.some((p) => points.has(pointKey(p)))
      ) {
        continue;
      }
      for (let i = 0; i + 1 < tunnel.line.length; i++) {
        const [a, c] = [tunnel.line[i], tunnel.line[i + 1]];
        const length = Math.hypot(c[0] - a[0], c[1] - a[1]);
        let deepest = Infinity;
        for (let d = 0; d <= length; d += 1) {
          const p: Point = length > 0 ? [a[0] + ((c[0] - a[0]) * d) / length, a[1] + ((c[1] - a[1]) * d) / length] : a;
          if (freeEnds.some(({ q }) => Math.hypot(q[0] - p[0], q[1] - p[1]) < OVER_PORTAL_M)) {
            continue;
          }
          for (let k = 0; k + 1 < way.line.length; k++) {
            const { distance, at } = nearestOnSegment(p, way.line[k], way.line[k + 1]);
            const ground = distance <= margin && !pastPortal(p, at, margin) ? heightAt(...at) : undefined;
            if (ground !== undefined) {
              deepest = Math.min(deepest, ground);
            }
          }
        }
        if (Number.isFinite(deepest)) {
          for (const q of [a, c]) {
            const node = nodes.get(pointKey(q));
            if (node) {
              floors.push([pointKey(q), deepest - node.depth]);
            }
          }
        }
      }
    }
  }
  return floors;
}

/** The nearest point of segment a-c to p, and how far it is */
function nearestOnSegment(p: Point, a: Point, c: Point): { distance: number; at: Point } {
  const [dx, dy] = [c[0] - a[0], c[1] - a[1]];
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq > 0 ? Math.min(Math.max(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq, 0), 1) : 0;
  const at: Point = [a[0] + dx * t, a[1] + dy * t];
  return { distance: Math.hypot(at[0] - p[0], at[1] - p[1]), at };
}

/**
 * Splits ramps off ways leading on from portals, rising from the floor until they meet the ground. A way that
 * ends before its ramp meets the ground, where other ways go on, rises as the grade lets it, and they ramp on
 * from there, up to RAMP_ON_M from the portal. Returns the count.
 */
function rampOut<T extends Way>(
  ways: T[],
  tunnels: Set<Way>,
  portalFloor: (p: Point) => number | undefined,
  heightAt: (e: number, n: number) => number | undefined,
): number {
  const added: T[] = [];
  let count = 0;
  const free = (way: T) => !tunnels.has(way) && way.line.length >= 2 && !way.deck && !way.lid && !way.floor;
  // how many of the ways that may ramp end at each point; a ramp goes on only where no other way passes or stays
  const ends = new Map<string, number>();
  const held = new Set<string>();
  for (const way of ways) {
    way.line.forEach((p, i) => {
      if (free(way) && (i === 0 || i === way.line.length - 1)) {
        ends.set(pointKey(p), (ends.get(pointKey(p)) ?? 0) + 1);
      } else {
        held.add(pointKey(p));
      }
    });
  }
  // where ramps start: the floor there, how much further they may reach, and whether that is on past a short way
  let startAt = (p: Point): { floor: number; reach: number; on?: boolean } | undefined => {
    const floor = portalFloor(p);
    return floor === undefined ? undefined : { floor, reach: RAMP_REACH_M };
  };
  for (;;) {
    const onward = new Map<string, { floor: number; reach: number; on: boolean }>();
    for (const way of ways) {
      for (const atStart of [true, false]) {
        if (!free(way)) {
          break;
        }
        const outward = atStart ? way.line : [...way.line].reverse();
        const start = startAt(outward[0]);
        if (start === undefined || (heightAt(...outward[0]) ?? start.floor) <= start.floor + RAMP_TOLERANCE_M) {
          continue;
        }
        const floor = start.floor;
        const along = [0];
        for (let i = 1; i < outward.length; i++) {
          along.push(along[i - 1] + Math.hypot(outward[i][0] - outward[i - 1][0], outward[i][1] - outward[i - 1][1]));
        }
        const length = along[along.length - 1];
        const reach = Math.min(start.reach, length);
        const grade = "width" in way && RISING.has(way.kind) ? STAIRS_GRADE : MAX_GRADE;
        let end = reach;
        let met = false;
        for (let d = RAMP_STEP_M; d < reach; d += RAMP_STEP_M) {
          const p = pointAlong(outward, d);
          const h = p && heightAt(...p);
          if (h !== undefined && h <= floor + grade * d) {
            end = d;
            met = true;
            break;
          }
        }
        const last = outward[outward.length - 1];
        const endPoint = end >= length - 0.01 ? last : (pointAlong(outward, end) ?? last);
        const ground = heightAt(...endPoint) ?? floor;
        // short of the ground at the way's end: the ways going on from there ramp on
        const goesOn =
          !met &&
          end >= length - 0.01 &&
          (start.on ? start.reach : RAMP_ON_M) - length >= RAMP_ON_LEFT_M &&
          ground > floor + grade * length + RAMP_TOLERANCE_M &&
          (ends.get(pointKey(last)) ?? 0) > 1 &&
          !held.has(pointKey(last));
        const top = goesOn ? floor + grade * length : ground;
        if (goesOn) {
          const reachOn = (start.on ? start.reach : RAMP_ON_M) - length;
          onward.set(pointKey(last), { floor: Math.min(top, onward.get(pointKey(last))?.floor ?? Infinity), reach: reachOn, on: true });
        }
        const ramp: Point[] = [...outward.filter((_, i) => along[i] < end), endPoint];
        let d = 0;
        const heights = ramp.map((p, i) => {
          d += i > 0 ? Math.hypot(p[0] - ramp[i - 1][0], p[1] - ramp[i - 1][1]) : 0;
          return end > 0 ? floor + ((top - floor) * d) / end : floor;
        });
        count++;
        if (end >= length - 0.01) {
          way.floor = atStart ? heights : heights.reverse();
          break;
        }
        const rest = [endPoint, ...outward.filter((_, i) => along[i] > end)];
        way.line = atStart ? rest : rest.reverse();
        added.push({ ...way, line: atStart ? ramp : ramp.reverse(), floor: atStart ? heights : heights.reverse() });
      }
    }
    if (onward.size === 0) {
      break;
    }
    startAt = (p) => onward.get(pointKey(p));
  }
  ways.push(...added);
  return count;
}

/**
 * Smooths the floors along the tunnels where they follow the ground's humps, lowering them only (deeper is
 * always deep enough): a point more than MAX_BEND_M over the line between its neighbours comes down to it.
 * Portals, stairs' feet and junctions stay where they are.
 */
function smoothFloors(nodes: Map<string, Node>): void {
  for (let round = 0; round < SMOOTH_ROUNDS; round++) {
    let moved = 0;
    for (const node of nodes.values()) {
      const [a, b] = node.next.map((n) => nodes.get(n.key));
      if (node.next.length !== 2 || node.portal !== undefined || node.stairs || !a || !b || ![node.floor, a.floor, b.floor].every(Number.isFinite)) {
        continue;
      }
      const [la, lb] = [node.next[0].length, node.next[1].length];
      // a and b weigh in the line between them by nearness
      const bend = node.floor - (a.floor * lb + b.floor * la) / (la + lb);
      if (bend > MAX_BEND_M) {
        node.floor -= bend - MAX_BEND_M;
        moved = Math.max(moved, bend - MAX_BEND_M);
      }
    }
    if (moved < 0.0001) {
      break;
    }
  }
}

/**
 * Sets floors from the portals: junctions get the inverse-distance average of their neighbours, stretches
 * between are linear. Nodes reaching no portal keep an infinite floor.
 */
function hang(nodes: Map<string, Node>): void {
  const isKey = (node: Node) => node.next.length !== 2 || node.portal !== undefined;
  // the stretches between key nodes: their nodes in order and each one's distance from the first
  const stretches: { keys: string[]; along: number[] }[] = [];
  const walked = new Set<string>();
  const edge = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const walkFrom = (start: string) => {
    for (const first of nodes.get(start)?.next ?? []) {
      if (walked.has(edge(start, first.key))) {
        continue;
      }
      const keys = [start];
      const along = [0];
      let step = first;
      for (;;) {
        walked.add(edge(keys[keys.length - 1], step.key));
        keys.push(step.key);
        along.push(along[along.length - 1] + step.length);
        const node = nodes.get(step.key);
        if (!node || isKey(node) || step.key === start) {
          break;
        }
        const previous = keys[keys.length - 2];
        const onward = node.next.find((n) => n.key !== previous);
        if (!onward) {
          break;
        }
        step = onward;
      }
      stretches.push({ keys, along });
    }
  };
  const keys = [...nodes].filter(([, node]) => isKey(node)).map(([k]) => k);
  keys.forEach(walkFrom);
  // loops without key nodes: any node of one will do
  for (const [k, node] of nodes) {
    if (node.next.some((n) => !walked.has(edge(k, n.key)))) {
      keys.push(k);
      walkFrom(k);
    }
  }

  const value = new Map<string, number>();
  for (const k of keys) {
    const portal = nodes.get(k)?.portal;
    if (portal !== undefined) {
      value.set(k, portal);
    }
  }
  const ends = new Map<string, { other: string; length: number }[]>();
  for (const { keys: s, along } of stretches) {
    const [a, b, length] = [s[0], s[s.length - 1], along[along.length - 1]];
    if (a !== b && length > 0) {
      ends.set(a, [...(ends.get(a) ?? []), { other: b, length }]);
      ends.set(b, [...(ends.get(b) ?? []), { other: a, length }]);
    }
  }
  for (let round = 0; round < ROUNDS; round++) {
    let moved = 0;
    for (const k of keys) {
      if (nodes.get(k)?.portal !== undefined) {
        continue;
      }
      let sum = 0;
      let weight = 0;
      for (const { other, length } of ends.get(k) ?? []) {
        const v = value.get(other);
        if (v !== undefined) {
          sum += v / length;
          weight += 1 / length;
        }
      }
      if (weight > 0) {
        const v = sum / weight;
        moved = Math.max(moved, Math.abs(v - (value.get(k) ?? Infinity)));
        value.set(k, v);
      }
    }
    if (moved < 0.001) {
      break;
    }
  }

  for (const { keys: s, along } of stretches) {
    const a = value.get(s[0]);
    const b = value.get(s[s.length - 1]);
    const total = along[along.length - 1];
    s.forEach((k, i) => {
      const node = nodes.get(k);
      if (node && a !== undefined && b !== undefined) {
        node.floor = a + (b - a) * (total > 0 ? along[i] / total : 0);
      } else if (node) {
        node.floor = a ?? b ?? Infinity;
      }
    });
  }
}

/** Shortest-path search: the least start + cost(meters along the tunnels) at every node reached */
function spread(nodes: Map<string, Node>, starts: [string, number][], cost: (length: number) => number): Map<string, number> {
  const best = new Map<string, number>();
  const heap = new MinHeap<string>();
  for (const [k, value] of starts) {
    if (value < (best.get(k) ?? Infinity)) {
      best.set(k, value);
      heap.push(k, value);
    }
  }
  for (let top = heap.pop(); top; top = heap.pop()) {
    if (top.value > (best.get(top.item) ?? Infinity)) {
      continue;
    }
    for (const { key: k, length } of nodes.get(top.item)?.next ?? []) {
      const value = top.value + cost(length);
      if (value < (best.get(k) ?? Infinity)) {
        best.set(k, value);
        heap.push(k, value);
      }
    }
  }
  return best;
}

/** The line with points added so that none are further apart than step */
export function densify(line: Point[], step: number): Point[] {
  const out: Point[] = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const [a, c] = [line[i - 1], line[i]];
    const pieces = Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / step);
    for (let k = 1; k < pieces; k++) {
      out.push([a[0] + ((c[0] - a[0]) * k) / pieces, a[1] + ((c[1] - a[1]) * k) / pieces]);
    }
    out.push(c);
  }
  return out;
}

/** A binary heap of items by value, smallest first */
class MinHeap<T> {
  readonly #entries: { item: T; value: number }[] = [];

  push(item: T, value: number): void {
    const entries = this.#entries;
    entries.push({ item, value });
    for (let i = entries.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (entries[parent].value <= entries[i].value) {
        break;
      }
      [entries[parent], entries[i]] = [entries[i], entries[parent]];
      i = parent;
    }
  }

  pop(): { item: T; value: number } | undefined {
    const entries = this.#entries;
    const top = entries[0];
    const last = entries.pop();
    if (entries.length > 0 && last) {
      entries[0] = last;
      for (let i = 0; ; ) {
        const [l, r] = [2 * i + 1, 2 * i + 2];
        let smallest = i;
        if (l < entries.length && entries[l].value < entries[smallest].value) {
          smallest = l;
        }
        if (r < entries.length && entries[r].value < entries[smallest].value) {
          smallest = r;
        }
        if (smallest === i) {
          break;
        }
        [entries[smallest], entries[i]] = [entries[i], entries[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}
