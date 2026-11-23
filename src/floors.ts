// The floors of the bored tunnels, over the network of their points (tunnels.ts): a linear program for each group of
// tunnels that touch (lp.ts), their bounds missed only by priority, at the least cost (HARD_COST and on), and each
// conflict told with its way and place:
// - the floors known from plans hold;
// - straight between known floors of a tunnel and on to its portals, a tunnel's grade between its points, its floor
//   bending no more than MAX_BEND_M over BEND_SPAN_M, tunnels of one layer whose rooms overlap one hall (a point of
//   one and its point on the other share a floor), and a car park's floor no lower than its level;
// - room and roof under the ways, decks, tunnels in cuts and buildings' footings over them, and under the floors of
//   the tunnels of a higher layer whose rooms overlap theirs;
// - the portals at the ground there, lower only for those;
// - cover under the ground for their users' room and roof, eased in from the portals, and under water a bed; where
//   it is missed, the roof is a lid.
// Within the bounds a floor keeps as high as it can, no higher than it hangs between its portals.
import { deckAt } from "./bridges.ts";
import { distanceToRing, distanceToSegment, grownRect, indexOwnBoxes, inRect, MinHeap, nearestOnLine, nearestOnSegment, pointInPolygon, pointKey, pushTo, RESOLUTION_M, type Point } from "./geometry.ts";
import type { LinearProgram, SolveLp } from "./lp.ts";
import { bounds, type Building, type MapFeatures, type Road } from "./osm.ts";
import { inTunnel, isBridge } from "./profile.ts";
import { acrossRoom, BED_M, COVER_M, densify, lowestGround, pointsAround, spread, WALL_FOOTING_M, WATER_DEPTH_M, type TunnelNetwork, type TunnelNode } from "./tunnels.ts";
import { isRoad, ROOM_SIDE_M, TUNNEL_GRADE, widthOf, type Way } from "./ways.ts";

/** A known floor is the floor of the tunnel's point nearest it within this far (m) */
const KNOWN_REACH_M = 6;
/** A way crossing a tunnel this near its free end (m), or beyond it, passes its portal, not over it */
const OVER_PORTAL_M = 1;
/** A tunnel at least this share under an open roof over its portal is a covered ramp */
const COVERED_SHARE = 0.5;
/** A tunnel's junctions are averaged this many rounds as it hangs between its portals (they settle in far fewer) */
const HANG_ROUNDS = 1000;
/** A floor bends over the line between its heights BEND_SPAN_M before and after it at most MAX_BEND_M (m), so that it does not kink */
const BEND_SPAN_M = 10;
const MAX_BEND_M = 0.1;
/**
 * The floors' bounds by priority, as the cost (per meter) of missing one at a point: the known floors hold; then the
 * straight floors between them, grades, bends and halls' shared floors (missed only where those leave no room for
 * them); then the room under what is over a tunnel and over what is under it; then a portal at its height (no higher,
 * and lower only for those); then the cover, a shortfall making the roof a lid. Each meter a floor is deeper than it
 * needs costs SHALLOW_COST, so that the floors keep as high as their bounds let them.
 */
const HARD_COST = 1e5;
const ROOM_COST = 1e3;
const PORTAL_COST = 1e2;
const COVER_COST = 1;
const SHALLOW_COST = 1e-3;
/** A point this far (m) past the end of another tunnel's line is on a way going on from it, not beside it */
const PAST_END_M = 0.5;

/**
 * A tunnel's floor known at a point (m), from a plan or a survey rather than from the ground over it: the height of
 * its way's surface there
 */
export interface KnownFloor {
  p: Point;
  floor: number;
  /**
   * The tunnel's name=*, or for a tunnel without one its way's OSM element (w123): only its ways' points are looked at,
   * so that another tunnel passing nearer does not take it, and between two known floors of one name the floor runs
   * straight along its ways
   */
  name?: string;
}

/** A floor's bound missed (the bounds' costs by priority): on which way, where most and by how much (m) */
export interface FloorConflict {
  way: string;
  bound: "known" | "grade" | "bend" | "hall" | "room" | "portal" | "cover";
  at: Point;
  by: number;
}

/** A bound on a sum of floors (their points' keys and factors), missed at its cost a meter, told at k */
interface FloorBound {
  cost: number;
  bound: FloorConflict["bound"];
  k: string;
  terms: [string, number][];
  lower: number;
  upper: number;
}

/**
 * Solves the floors of the bored tunnels (tunnels.ts' network) with lp, as high as their bounds let them and no higher
 * than they hang between their portals, and under the decks over them (deckOver: the deck over a point, over a way on
 * a layer, as the decks will be set). Under a bridge (`underBridge`) the floor is not kept under the elevation model,
 * which has no ground there. Returns how many tunnels got floors, how many of the known floors were on a tunnel, the
 * ways of the tunnels going down from a portal in a building under it (a ramp into a basement and the ways on from
 * it; see `openPortals`), and the bounds missed.
 */
export function solveFloors(
  features: MapFeatures,
  network: TunnelNetwork,
  lp: SolveLp,
  underBridge: (p: Point) => boolean = () => false,
  known: readonly KnownFloor[] = [],
  deckOver?: (p: Point, layer: number) => { deck: number } | undefined,
): { floors: number; known: number; basements: Road[]; conflicts: FloorConflict[] } {
  const { tunnels, nodes, through, heightAt } = network;
  const { beside, under } = besides(tunnels, nodes, through);
  // the tunnels that touch a portal in a building go down into a basement under it
  const groups = touching(network, [...beside, ...under]);
  const basements = groups.filter(({ keys }) => keys.some((k) => nodes.get(k)?.inBuilding)).flatMap(({ ways }) => ways.filter(isRoad));
  const at = (cost: number, bound: FloorConflict["bound"], lower: boolean) => ([k, v]: [string, number]): FloorBound =>
    ({ cost, bound, k, terms: [[k, 1]], lower: lower ? v : -Infinity, upper: lower ? Infinity : v });
  const bounds = [
    ...[
      ...underWays(features, tunnels, nodes, heightAt, underBridge),
      ...underDecks([...features.roads, ...features.rails], network, deckOver),
      ...underFootings(features.buildings, network, new Set(basements)),
    ].map(at(ROOM_COST, "room", false)),
    ...under.map(([low, high]): FloorBound => ({ cost: ROOM_COST, bound: "room", k: low, terms: [[low, 1], [high, -1]], lower: -Infinity, upper: -(nodes.get(low)?.depth ?? 0) })),
    ...[...covers(features, network, underBridge), ...hang(nodes)].map(at(COVER_COST, "cover", false)),
  ];
  nodes.forEach((node) => (node.floor = node.portal ?? Infinity));
  const { count: knownAt, straight } = holdKnown(nodes, through, known);
  bounds.push(...[...straight].map(([k, { from, to, at }]): FloorBound => ({ cost: ROOM_COST, bound: "known", k, terms: [[k, 1], [from, at - 1], [to, -at]], lower: 0, upper: 0 })));
  bounds.push(...[...nodes].filter(([, node]) => node.portal !== undefined && !node.known).map(([k, node]): [string, number] => [k, node.floor]).map(at(PORTAL_COST, "portal", true)));
  // a known floor keeps its own, in a hall too, where the other has its own
  bounds.push(...beside.filter(([p, q]) => p !== q && !(nodes.get(p)?.known && nodes.get(q)?.known)).map(([p, q]): FloorBound => ({ cost: HARD_COST, bound: "hall", k: p, terms: [[p, 1], [q, -1]], lower: 0, upper: 0 })));
  const { floors, conflicts } = optimize(network, groups, bounds, lp);
  for (const [k, node] of nodes) {
    node.floor = floors.get(k) ?? Infinity;
  }
  const floored = tunnels.filter((way) => way.line.every((p) => Number.isFinite(nodes.get(pointKey(p))?.floor)));
  floored.forEach((way) => (way.floor = way.line.map((p) => nodes.get(pointKey(p))?.floor ?? Infinity)));
  return { floors: floored.length, known: knownAt, basements, conflicts };
}

/**
 * The floors at the least cost of the bounds they miss (FloorBounds, by the priorities' costs), one linear program for
 * each group of tunnels that meet, share a hall or cross: a floor no steeper than TUNNEL_GRADE between a way's points,
 * bending no more than MAX_BEND_M from the line between its heights BEND_SPAN_M before and after along a way (on a
 * curve as gentle near its ends), and a car park's no lower than its level. A group with no bound gets no floors.
 */
function optimize(network: TunnelNetwork, groups: { keys: string[]; ways: Way[] }[], bounds: FloorBound[], lp: SolveLp): { floors: Map<string, number>; conflicts: FloorConflict[] } {
  const { nodes, through } = network;
  const floors = new Map<string, number>();
  const missed = new Map<string, FloorConflict>();
  for (const { keys, ways } of groups) {
    const index = new Map(keys.map((k, i) => [k, i]));
    const of = (k: string) => index.get(k) ?? -1;
    const program: LinearProgram = { cost: [], lower: [], upper: [], rows: [] };
    const column = (cost: number, lower: number, upper: number) => {
      program.lower.push(lower);
      program.upper.push(upper);
      return program.cost.push(cost) - 1;
    };
    keys.forEach((k) => {
      const node = nodes.get(k);
      const f = node?.known ? node.floor : undefined;
      column(f === undefined ? -SHALLOW_COST : 0, f ?? node?.level ?? -Infinity, node?.known || node?.portal !== undefined ? (node?.floor ?? Infinity) : Infinity);
    });
    const slacks: { column: number; k: string; bound: FloorConflict["bound"] }[] = [];
    // lower <= the terms' sum <= upper, missed by the slack's value at its cost
    const soft = ({ cost, bound, k, terms, lower, upper }: FloorBound) => {
      if (lower === -Infinity && upper === Infinity) {
        return;
      }
      const slack = column(cost, 0, Infinity);
      slacks.push({ column: slack, k, bound });
      const sum = new Map<number, number>();
      terms.forEach(([q, v]) => sum.set(of(q), (sum.get(of(q)) ?? 0) + v));
      if (upper < Infinity) {
        program.rows.push({ terms: new Map([...sum, [slack, -1]]), lower: -Infinity, upper });
      }
      if (lower > -Infinity) {
        program.rows.push({ terms: new Map([...sum, [slack, 1]]), lower, upper: Infinity });
      }
    };
    const grades = keys.flatMap((k) =>
      (nodes.get(k)?.next ?? []).filter(({ key }) => k < key).map(({ key, length }): FloorBound => ({ cost: HARD_COST, bound: "grade", k, terms: [[k, 1], [key, -1]], lower: -TUNNEL_GRADE * length, upper: TUNNEL_GRADE * length })),
    );
    const bent = ways.flatMap((way) => bends(way.line).map(({ k, terms, allowed }): FloorBound => ({ cost: HARD_COST, bound: "bend", k, terms, lower: -allowed, upper: allowed })));
    [...grades, ...bent, ...bounds.filter(({ k }) => index.has(k))].forEach(soft);
    // a group of tunnels with no bound gets no floors
    const x = lp(program);
    if (!x) {
      continue;
    }
    keys.forEach((k, i) => floors.set(k, x[i]));
    // the most each way misses each bound by
    for (const { column: c, k, bound } of slacks.filter(({ column: c }) => x[c] >= RESOLUTION_M / 2)) {
      const way = through.get(k)?.[0]?.osm ?? k;
      if (x[c] > (missed.get(`${way} ${bound}`)?.by ?? 0)) {
        missed.set(`${way} ${bound}`, { way, bound, at: nodes.get(k)?.p ?? [0, 0], by: x[c] });
      }
    }
  }
  return { floors, conflicts: [...missed.values()] };
}

/**
 * A line's bends: at each point its floor less the line between its neighbours' floors, as its key and the terms, and
 * how far that may be either way: as far as a curve bending MAX_BEND_M over BEND_SPAN_M either way does
 */
function bends(line: Point[]): { k: string; terms: [string, number][]; allowed: number }[] {
  const keys = line.map(pointKey);
  const length = (i: number) => Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
  return keys.slice(1, -1).flatMap((k, i) => {
    const [before, after] = [length(i), length(i + 1)];
    const terms: [string, number][] = [[k, 1], [keys[i], -after / (before + after)], [keys[i + 2], -before / (before + after)]];
    return before > 0 && after > 0 ? [{ k, terms, allowed: (MAX_BEND_M * before * after) / BEND_SPAN_M ** 2 }] : [];
  });
}

/**
 * Tunnels whose rooms overlap: each point of one has a point of the other beside it, added to its line where it has
 * none (not past its end: a way going on from another's end is not beside it), in one hall only the first way's. Returned by their keys: those of tunnels
 * of one layer (and storey, where OSM tells), in one hall, which share a floor, and those under a tunnel of a higher
 * layer with the point of it beside them, which keep their room and roof under its floor.
 */
function besides(tunnels: Way[], nodes: Map<string, TunnelNode>, through: Map<string, Way[]>): { beside: [string, string][]; under: [string, string][] } {
  const beside: [string, string][] = [];
  const under: [string, string][] = [];
  const rooms = tunnels.map((way) => ({ way, half: widthOf(way) / 2 + ROOM_SIDE_M, box: bounds(way.line), points: [...way.line] }));
  const branches = branchesAt(tunnels, nodes, through);
  for (const [i, a] of rooms.entries()) {
    for (const [j, b] of rooms.entries()) {
      const reach = a.half + b.half;
      // in a hall, the points of one way on the other only, a branch's on the way it leaves: both ways, a point's and
      // its partner's would cross
      const branch = branches.get(a.way)?.has(b.way);
      const first = branch || (!branches.get(b.way)?.has(a.way) && i < j);
      if (a === b || (a.way.layer === b.way.layer && !first) || a.box.minX > b.box.maxX + reach || a.box.maxX < b.box.minX - reach || a.box.minY > b.box.maxY + reach || a.box.maxY < b.box.minY - reach) {
        continue;
      }
      const edges = branch ? hallEdges(a.way, b.way, reach, nodes, through) : [];
      for (const p of [...a.points, ...edges]) {
        const q = through.get(pointKey(p))?.includes(b.way) ? undefined : besideOn(b.way, p, reach, nodes, through);
        const [kp, kq] = [pointKey(p), q && pointKey(q)];
        if (kq === undefined) {
          continue;
        }
        // ways on storeys apart (level=*, where OSM tells) are no hall
        const [sp, sq] = [nodes.get(kp)?.storeys, nodes.get(kq)?.storeys];
        if (a.way.layer === b.way.layer && (!sp || !sq || sp.some((x) => sq.includes(x)))) {
          beside.push([kp, kq]);
        } else if (a.way.layer !== b.way.layer) {
          under.push(a.way.layer < b.way.layer ? [kp, kq] : [kq, kp]);
        }
      }
    }
  }
  return { beside, under };
}

/**
 * The ways each tunnel branches off at a junction of one layer: the ways running through it (on from it both ways), or
 * where none does, the two going on from it the straightest, host the others
 */
function branchesAt(tunnels: Way[], nodes: Map<string, TunnelNode>, through: Map<string, Way[]>): Map<Way, Set<Way>> {
  const branches = new Map<Way, Set<Way>>();
  for (const [k, node] of nodes) {
    const ways = (through.get(k) ?? []).filter((w) => tunnels.includes(w));
    if (node.next.length < 3 || ways.length < 2) {
      continue;
    }
    // the way out of the junction along each way, and whether it goes on past it
    const out = ways.map((way) => {
      const i = way.line.findIndex((p) => pointKey(p) === k);
      const q = way.line[i === 0 ? 1 : i - 1];
      const length = Math.hypot(q[0] - node.p[0], q[1] - node.p[1]) || 1;
      return { way, on: i > 0 && i < way.line.length - 1, d: [(q[0] - node.p[0]) / length, (q[1] - node.p[1]) / length] };
    });
    const runs = out.filter((o) => o.on);
    const straightest = out.flatMap((a, i) => out.slice(i + 1).map((b) => ({ pair: [a, b], turn: a.d[0] * b.d[0] + a.d[1] * b.d[1] }))).sort((x, y) => x.turn - y.turn)[0]?.pair ?? [];
    const hosts = runs.length > 0 ? runs : straightest;
    for (const { way } of out.filter((o) => !hosts.includes(o))) {
      const of = branches.get(way) ?? new Set<Way>();
      hosts.filter((h) => h.way.layer === way.layer).forEach((h) => of.add(h.way));
      branches.set(way, of);
    }
  }
  return branches;
}

/** The points of a's line, added to it, where it leaves b's room (within reach of b's line): their hall's edges */
function hallEdges(a: Way, b: Way, reach: number, nodes: Map<string, TunnelNode>, through: Map<string, Way[]>): Point[] {
  const inside = (x: Point) => nearestOnLine(b.line, x).distance < reach;
  const line = [...a.line];
  const edges: Point[] = [];
  for (const [k, p] of line.slice(0, -1).entries()) {
    const q = line[k + 1];
    const at = (t: number): Point => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    // halved until within the resolution
    let [into, out] = inside(p) ? [0, 1] : [1, 0];
    while (inside(p) !== inside(q) && Math.abs(out - into) * Math.hypot(q[0] - p[0], q[1] - p[1]) > RESOLUTION_M) {
      const middle = (into + out) / 2;
      [into, out] = inside(at(middle)) ? [middle, out] : [into, middle];
    }
    // not past b's end: a way going on from it is not beside it
    const beside = inside(p) !== inside(q) && besideOn(b, at(into), reach, nodes, through, false) !== undefined;
    const edge = beside ? besideOn(a, at(into), Infinity, nodes, through) : undefined;
    edges.push(...(edge ? [edge] : []));
  }
  return edges;
}

/** The tunnels' points and ways in groups that touch: meeting, beside each other or one over the other */
function touching(network: TunnelNetwork, pairs: [string, string][]): { keys: string[]; ways: Way[] }[] {
  const links = new Map([...network.nodes].map(([k, node]) => [k, node.next.map((n) => n.key)]));
  for (const [p, q] of pairs) {
    pushTo(links, p, q);
    pushTo(links, q, p);
  }
  const groupOf = new Map<string, { keys: string[]; ways: Way[] }>();
  for (const start of network.nodes.keys()) {
    const group: { keys: string[]; ways: Way[] } = { keys: [], ways: [] };
    const queue = [start];
    for (let k = queue.pop(); k !== undefined; k = queue.pop()) {
      if (!groupOf.has(k)) {
        groupOf.set(k, group);
        group.keys.push(k);
        queue.push(...(links.get(k) ?? []));
      }
    }
  }
  network.tunnels.forEach((way) => groupOf.get(pointKey(way.line[0]))?.ways.push(way));
  return [...new Set(groupOf.values())];
}

/**
 * The point of a tunnel's line beside p within reach, not past its ends: its own within a step of RESOLUTION_M, the
 * tiles' resolution (or the nearer where another tunnel has one there), else one added to it and to the network (unless
 * not `add`)
 */
function besideOn(way: Way, p: Point, reach: number, nodes: Map<string, TunnelNode>, through: Map<string, Way[]>, add = true): Point | undefined {
  const line = way.line;
  const { point, distance, segment } = nearestOnLine(line, p);
  const [a, c] = [line[segment], line[segment + 1]];
  const length = Math.hypot(c[0] - a[0], c[1] - a[1]);
  const along = length > 0 ? ((p[0] - a[0]) * (c[0] - a[0]) + (p[1] - a[1]) * (c[1] - a[1])) / length : 0;
  const past = (segment === 0 && -along > PAST_END_M) || (segment === line.length - 2 && along - length > PAST_END_M);
  if (distance >= reach || past || !add) {
    return distance >= reach || past ? undefined : point;
  }
  const [na, nc] = [nodes.get(pointKey(a)), nodes.get(pointKey(c))];
  const off = (q: Point) => Math.hypot(q[0] - point[0], q[1] - point[1]);
  // another tunnel's point there (one crossing over or under) is not this one's
  // a step of the resolution apart or less, they are one: as two, the tiles' heights rounded at each would step
  const near = (q: Point) => Math.round(off(q) / RESOLUTION_M) <= 1;
  if (near(a) || near(c) || !na || !nc || nodes.has(pointKey(point))) {
    return off(a) <= off(c) ? a : c;
  }
  line.splice(segment + 1, 0, point);
  na.next = na.next.map((n) => (n.key === pointKey(c) ? { key: pointKey(point), length: off(a) } : n));
  nc.next = nc.next.map((n) => (n.key === pointKey(a) ? { key: pointKey(point), length: off(c) } : n));
  nodes.set(pointKey(point), { p: point, next: [{ key: pointKey(a), length: off(a) }, { key: pointKey(c), length: off(c) }], depth: Math.min(na.depth, nc.depth), half: Math.min(na.half, nc.half), floor: Infinity });
  through.set(pointKey(point), [way]);
  return point;
}

/**
 * The cover: deep enough under the ground for the room and roof here and halfway to the neighbours, eased in from
 * the portals, whose walls the elevation model smooths into slopes, on one curve from level at the portal that bends
 * no more than MAX_BEND_M and is no steeper than TUNNEL_GRADE; where it cannot be met by a portal, the roof is a lid
 * over a cut; from a portal in a building only under a building (the model leaves buildings out, and beyond its walls
 * the ground over the tunnel is the open ground). Under water deeper by its depth and a bed over the roof, across the
 * room's width too, as a water's surface falls across it where it flows
 */
function covers(features: MapFeatures, network: TunnelNetwork, underBridge: (p: Point) => boolean): [string, number][] {
  const { nodes, heightAt } = network;
  const portalsOf = (inBuilding: boolean): [string, number][] =>
    [...nodes].filter(([, node]) => node.portal !== undefined && !node.stairs && (node.inBuilding === true) === inBuilding).map(([k]) => [k, 0]);
  const [fromOpen, fromHouse] = [false, true].map((inBuilding) => spread(nodes, portalsOf(inBuilding), (length) => length));
  const waters = features.areas.filter((a) => a.kind === "water").map((a) => ({ polygon: a.polygon, box: bounds(a.polygon.outer) }));
  const inWater = (p: Point) => waters.some(({ polygon, box }) => inRect(p, box) && pointInPolygon(p, polygon));
  const cover: [string, number][] = [];
  for (const [k, node] of nodes) {
    const around = pointsAround(nodes, node);
    const wet = [...around, ...acrossRoom(nodes, node)].filter(inWater);
    // the model has no ground under a bridge: the tunnel there only has to fit under its deck
    const ground = [...around.filter((p) => !underBridge(p)), ...wet].map((p) => heightAt(...p)).filter((h) => h !== undefined);
    if (ground.length > 0) {
      const d = Math.min(fromOpen.get(k) ?? Infinity, node.house === undefined ? Infinity : (fromHouse.get(k) ?? Infinity));
      cover.push([k, Math.min(...ground) - easedDepth(node.depth, d) - (wet.length > 0 ? WATER_DEPTH_M + BED_M : 0)]);
    }
  }
  return cover;
}

/**
 * How deep a floor eased in from a portal is d meters in, on the way to `depth`: level at the portal, bending at most
 * as MAX_BEND_M lets it to TUNNEL_GRADE, on at that grade, and bending level again
 */
export function easedDepth(depth: number, d: number): number {
  const curve = (2 * MAX_BEND_M) / BEND_SPAN_M ** 2;
  // the bend's reach and how deep it takes the floor, half the way where the depth is too shallow for the grade
  const bend = Math.min(TUNNEL_GRADE / curve, Math.sqrt(depth / curve));
  const down = (curve * bend * bend) / 2;
  const straight = (depth - 2 * down) / TUNNEL_GRADE;
  if (d < bend) {
    return (curve * d * d) / 2;
  }
  if (d < bend + straight) {
    return down + TUNNEL_GRADE * (d - bend);
  }
  const left = Math.max(0, 2 * bend + straight - d);
  return depth - (curve * left * left) / 2;
}

/**
 * The floors under the buildings standing on the ground over a tunnel (but for the tunnels going down into a basement
 * from a portal in a building, which open its walls: openPortals, and a building a tunnel ends in or at, or a car
 * park's aisles are under):
 * their room and roof under the bottom of the walls' footings, WALL_FOOTING_M under the building's lowest ground, where
 * the room reaches under its outline
 */
function underFootings(buildings: Building[], network: TunnelNetwork, basements: Set<Way>): [string, number][] {
  const { nodes, through, heightAt } = network;
  const standing = buildings.filter((b) => b.shelter === undefined && b.minHeight === 0 && !b.hasParts && b.polygon.outer.length >= 3);
  if (standing.length === 0) {
    return [];
  }
  const boxes = standing.map((b) => bounds(b.polygon.outer));
  const near = indexOwnBoxes(boxes);
  const under = (node: TunnelNode) => near(grownRect(bounds([node.p]), node.half)).filter((i) => pointInPolygon(node.p, standing[i].polygon) || distanceToRing(node.p, standing[i].polygon.outer) < node.half);
  // a building a tunnel ends in or at (a portal, stairs up, a dead end), or a car park's aisles are under, is the
  // tunnel's: it goes into it
  const aisles = new Set(network.tunnels.filter((w) => isRoad(w) && w.service === "parking_aisle"));
  const entered = new Set(
    [...nodes].filter(([k, node]) => node.next.length === 1 || node.stairs || node.sideStairs || (through.get(k) ?? []).some((w) => aisles.has(w))).flatMap(([, node]) => under(node)),
  );
  const lows = new Map<number, number>();
  const lowest = (i: number) => lows.get(i) ?? lows.set(i, lowestGround(standing[i], heightAt)).get(i) ?? Infinity;
  const found: [string, number][] = [];
  for (const [k, node] of nodes) {
    if (!(through.get(k) ?? []).some((w) => basements.has(w))) {
      for (const i of under(node).filter((i) => !entered.has(i))) {
        found.push([k, lowest(i) - WALL_FOOTING_M - (node.depth - COVER_M)]);
      }
    }
  }
  return found;
}

/**
 * Floors known from plans or surveys: the tunnel's point nearest each has that floor, deeper or shallower than the
 * ground asks, and keeps it; between two of a tunnel's name, and from the last to its portal, the floor runs straight.
 * Returns how many were on a tunnel, and the floors that run straight.
 */
function holdKnown(nodes: Map<string, TunnelNode>, through: Map<string, Way[]>, known: readonly KnownFloor[]): { count: number; straight: Map<string, Straight> } {
  const knownByName = new Map<string, string[]>();
  const named = (k: string, name: string | undefined) =>
    name === undefined || (through.get(k) ?? []).some((way) => ("name" in way && way.name === name) || way.osm === name);
  let count = 0;
  for (const { p, floor, name } of known) {
    const off = (q: Point) => Math.hypot(q[0] - p[0], q[1] - p[1]);
    const [nearest] = [...nodes].filter(([k, node]) => off(node.p) <= KNOWN_REACH_M && named(k, name)).sort(([, a], [, b]) => off(a.p) - off(b.p));
    if (nearest) {
      nearest[1].floor = floor;
      nearest[1].known = true;
      count++;
      if (name !== undefined) {
        pushTo(knownByName, name, nearest[0]);
      }
    }
  }
  // the portals come down to them no steeper than TUNNEL_GRADE, which the floors run straight to from the last known floor
  const toKnown = spread(nodes, [...nodes].filter(([, node]) => node.known).map(([k, node]) => [k, node.floor]), (length) => TUNNEL_GRADE * length);
  for (const [k, node] of nodes) {
    if (node.portal !== undefined && !node.known) {
      node.floor = Math.min(node.floor, toKnown.get(k) ?? Infinity);
    }
  }
  const straight = new Map([...knownByName].flatMap(([name, at]) => [...betweenKnown(nodes, at, (q) => named(q, name))]));
  return { count, straight: new Map([...straight].filter(([k]) => !nodes.get(k)?.known)) };
}

/**
 * Fits the lids of tunnels in cuts to the decks of the bridges over them, which run from the ground at their ends: a
 * lid point under the lowest deck crossing its line beside it, within its width, goes down to it, or up to it but no
 * higher than the cut's higher rim there, and keeps its users' LEAST_CLEARANCE_M over its way's surface (a deck in the
/**
 * The floors the ways over tunnels need at the tunnels' points either side of where a way passes over: the
 * room and roof under the ground there. A way is over a tunnel where its width and the tunnel's room overlap,
 * looked at every meter along the tunnel but not at its free ends, nor beyond them (a way going on past a
 * portal from a short way out of it), nor under an open roof (a shelter's) over a portal of its (not stairs'
 * foot) and over most of it, where the tunnel is a covered ramp with no ground over it. Ways at a tunnel's
 * level or under it,
 * bridges, tunnels and the ways meeting it are not over it, nor a way's points under a bridge (`underBridge`), where
 * the model has no ground: an approach's end over the tunnel at a bridge's end.
 */
function underWays(
  features: MapFeatures,
  tunnels: Way[],
  nodes: Map<string, TunnelNode>,
  heightAt: (e: number, n: number) => number | undefined,
  underBridge: (p: Point) => boolean,
): [string, number][] {
  const inTunnels = new Set(tunnels);
  const over = [...features.roads, ...features.rails]
    .filter((w) => !inTunnels.has(w) && !inTunnel(w) && !isBridge(w) && w.line.length >= 2)
    .map((way) => ({ way, box: bounds(way.line), half: widthOf(way) / 2 }));
  const roofs = features.buildings
    .filter((b) => b.shelter !== undefined)
    .map((b) => ({ polygon: b.polygon, box: bounds(b.polygon.outer) }));
  const inBox = ([e, n]: Point, { box }: { box: ReturnType<typeof bounds> }, margin = 0) =>
    e >= box.minX - margin && e <= box.maxX + margin && n >= box.minY - margin && n <= box.maxY + margin;
  // a tunnel's portal on a roof's outline, or under it
  const endUnder = (q: Point, roof: (typeof roofs)[number]) => {
    const ring = roof.polygon.outer;
    return (
      inBox(q, roof, OVER_PORTAL_M) &&
      (pointInPolygon(q, roof.polygon) || ring.some((a, i) => distanceToSegment(q, a, ring[(i + 1) % ring.length]) < OVER_PORTAL_M))
    );
  };
  const floors: [string, number][] = [];
  for (const tunnel of tunnels) {
    const reach = widthOf(tunnel) / 2 + ROOM_SIDE_M;
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
    // the roofs over its portals
    const portals = freeEnds.filter(({ q }) => {
      const node = nodes.get(pointKey(q));
      return node?.portal !== undefined && !node.stairs;
    });
    const portalRoofs = roofs.filter((roof) => portals.some(({ q }) => endUnder(q, roof)));
    const underPortalRoof = (p: Point) => portalRoofs.some((roof) => inBox(p, roof) && pointInPolygon(p, roof.polygon));
    const along = portalRoofs.length > 0 ? densify(tunnel.line, 1) : [];
    const covered = along.length > 0 && along.filter(underPortalRoof).length >= along.length * COVERED_SHARE;
    const underRoof = (p: Point) => covered && underPortalRoof(p);
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
          if (freeEnds.some(({ q }) => Math.hypot(q[0] - p[0], q[1] - p[1]) < OVER_PORTAL_M) || underRoof(p)) {
            continue;
          }
          for (let k = 0; k + 1 < way.line.length; k++) {
            const at = nearestOnSegment(p, way.line[k], way.line[k + 1]);
            const distance = Math.hypot(at[0] - p[0], at[1] - p[1]);
            const ground = distance <= margin && !pastPortal(p, at, margin) && !underBridge(at) ? heightAt(...at) : undefined;
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

/**
 * The floors the decks over tunnels need at the tunnels' points and halfway to their neighbours: the bridges' (deckOver:
 * the deck over a point, over a way on a layer, as the decks will be set), and the floors of the tunnels in cuts over
 * them (not leading on into them) as decks: the room and roof under the deck, the deck as thick as a tunnel's roof. The
 * elevation model has no ground under a bridge, and at a bridge's end has it up at the deck, so that a tunnel under a
 * bridge's end would otherwise come out at the deck's height.
 */
function underDecks(ways: Way[], network: TunnelNetwork, deckOver?: (p: Point, layer: number) => { deck: number } | undefined): [string, number][] {
  const { nodes, through } = network;
  // a tunnel in a cut leading on into the tunnels is no deck over them
  const cuts = ways.filter((w) => w.lid !== undefined && w.line.length >= 2 && !w.line.some((p) => nodes.has(pointKey(p))));
  const found: [string, number][] = [];
  for (const [k, node] of nodes) {
    const layer = Math.max(...(through.get(k) ?? []).map((w) => w.layer));
    const decks = deckOver ? pointsAround(nodes, node).map((p) => deckOver(p, layer)?.deck) : [];
    const cutFloors = cuts.map((way) => (way.floor && way.layer > layer && nearestOnLine(way.line, node.p).distance < node.half + widthOf(way) / 2 ? deckAt(way.line, way.floor, node.p) : undefined));
    const over = [...decks, ...cutFloors].filter((d) => d !== undefined);
    if (over.length > 0) {
      found.push([k, Math.min(...over) - (node.depth - COVER_M)]);
    }
  }
  return found;
}

/**
 * The floors hanging from the portals, the highest the cover lets them: junctions get the inverse-distance average of
 * their neighbours, stretches between are linear. Nodes reaching no portal get an infinite floor.
 */
function hang(nodes: Map<string, TunnelNode>): [string, number][] {
  const { stretches, keys } = stretchesBetween(nodes, (node) => node.next.length !== 2 || node.portal !== undefined);

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
      pushTo(ends, a, { other: b, length });
      pushTo(ends, b, { other: a, length });
    }
  }
  for (let round = 0; round < HANG_ROUNDS; round++) {
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

  return stretches.flatMap(({ keys: s, along }) => {
    const [a, b] = [value.get(s[0]), value.get(s[s.length - 1])];
    const total = along[along.length - 1];
    return s.map((k, i): [string, number] => [k, a !== undefined && b !== undefined ? a + (b - a) * (total > 0 ? along[i] / total : 0) : (a ?? b ?? Infinity)]);
  });
}

/**
 * The stretches between key nodes: their nodes in order and each one's distance from the first, and the key
 * nodes (with a node of each loop that has none)
 */
function stretchesBetween(nodes: Map<string, TunnelNode>, isKey: (node: TunnelNode) => boolean): { stretches: { keys: string[]; along: number[] }[]; keys: string[] } {
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
  return { stretches, keys };
}

/**
 * The floors straight between known floors along a tunnel (`on`: its points), by the length along it: at each point on
 * the shortest way from one known floor to another, or to the tunnel's portal, with none between, the floor on the
 * line from one to the other (of the shortest such way, where a point is on several), as the line's ends and how far
 * along it the point is (0 to 1)
 */
function betweenKnown(nodes: Map<string, TunnelNode>, known: string[], on: (k: string) => boolean): Map<string, Straight> {
  const portals = [...nodes].filter(([k, node]) => node.portal !== undefined && !node.stairs && on(k)).map(([k]) => k);
  const isKnown = new Set(known);
  const found = new Map<string, Straight & { span: number }>();
  for (const start of known) {
    const best = new Map<string, number>([[start, 0]]);
    const previous = new Map<string, string>();
    const heap = new MinHeap<string>();
    heap.push(start, 0);
    for (let top = heap.pop(); top; top = heap.pop()) {
      // on to the next known floor, not past it
      if (top.value > (best.get(top.item) ?? Infinity) || (top.item !== start && isKnown.has(top.item))) {
        continue;
      }
      for (const { key: k, length } of nodes.get(top.item)?.next ?? []) {
        const value = top.value + length;
        if (on(k) && value < (best.get(k) ?? Infinity)) {
          best.set(k, value);
          previous.set(k, top.item);
          heap.push(k, value);
        }
      }
    }
    for (const end of [...known, ...portals]) {
      const span = best.get(end);
      if (end === start || span === undefined || span === 0) {
        continue;
      }
      for (let k = previous.get(end); k !== undefined && k !== start; k = previous.get(k)) {
        if (span < (found.get(k)?.span ?? Infinity)) {
          found.set(k, { from: start, to: end, at: (best.get(k) ?? 0) / span, span });
        }
      }
    }
  }
  return found;
}

/** A floor on the line between two others, at `at` (0 to 1) along it */
interface Straight {
  from: string;
  to: string;
  at: number;
}
