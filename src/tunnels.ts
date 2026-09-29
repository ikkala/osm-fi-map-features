// Tunnels under hills and lakes. OSM does not tell how deep a tunnel is, and the elevation model has the
// ground over it, so its floor is worked out: from the ground at its portals (the lowest just outside:
// at the portal itself the model has the top of its wall), straight by distance between them (a tunnel
// that branches underground is a network: every junction's floor is the average of its neighbours' by
// distance, as a stretched net would hang), but deep enough under the ground for the way and the roof
// over it (and under the water, WATER_DEPTH_M more), and no steeper than a road tunnel. Lines are given points every FLOOR_STEP_M first, so the
// floor can follow the ground where it dips over the tunnel.
//
// Tunnels in cuts (cuts.ts) are drawn in their cut and are not given floors here.
import { pointAlong } from "./bridges.ts";
import { pointInPolygon, type Point } from "./geometry.ts";
import { bounds, openPassages, type MapFeatures, type Rail, type Road } from "./osm.ts";

/** Room over the floor for people, vehicles and trains (m) */
export const WALK_CLEARANCE_M = 3;
export const ROAD_CLEARANCE_M = 4.8;
export const RAIL_CLEARANCE_M = 6;
/** The roof over the room, under the ground (m) */
export const ROOF_M = 1;
/** Under water (water areas) the elevation model has the surface: the water is taken this deep over a tunnel (m) */
export const WATER_DEPTH_M = 3;
/** Ways for people only (as osm.ts's NOT_FOR_VEHICLES) */
const WALKWAYS = new Set(["footway", "pedestrian", "cycleway", "path", "track", "bridleway", "steps", "corridor"]);
/** A tunnel's lines get a point at least this often (m) */
const FLOOR_STEP_M = 10;
/** The floor rises or falls at most this much a meter */
const MAX_GRADE = 0.07;
/** A portal's floor is the lowest ground at the tunnel's end and this far out along the ways leading on (m) */
const PORTAL_REACH_M = 4;
const PORTAL_STEP_M = 2;
/** The floor is as deep under the ground as the way needs from this far in from a portal (m) */
const PORTAL_EASE_M = 30;
/**
 * A way leading on from a portal gets a ramp down to the floor where the ground by the portal is more than
 * this over it (m); the ground is looked at this often and at most this far on (m)
 */
const RAMP_TOLERANCE_M = 0.3;
const RAMP_STEP_M = 2;
const RAMP_REACH_M = 40;
/**
 * A tunnel at least this share under buildings, whose ground rises nowhere more than this over its ends
 * (m), runs at the ground under them; its ground is looked at this often (m)
 */
const UNDER_BUILDINGS_SHARE = 0.5;
const AT_GRADE_RISE_M = 3;
const AT_GRADE_STEP_M = 2;
/** A way's room reaches this far beyond it on both sides (m) */
const ROOM_SIDE_M = 1;
/** A building raised over such a tunnel is at least this tall (m) */
const MIN_RAISED_M = 3;
/** A railway's width, for the openings in the walls of buildings over it (as cuts.ts's) */
const RAIL_WIDTH_M = 3;
/** Junction floors are averaged this many rounds (they settle in far fewer) */
const ROUNDS = 1000;

type Way = Road | Rail;

interface Node {
  p: Point;
  next: { key: string; length: number }[];
  /** How deep under the ground the floor has to be: room and roof for the deepest way through */
  depth: number;
  /** The floor at a portal */
  portal?: number;
  floor: number;
}

/**
 * Finds the tunnels (`layer` -1 or above, not in a cut) that run at the ground under buildings, such as a
 * railway under an arena built over it: the elevation model leaves buildings out, so the ground along such
 * a way is its own, and rises nowhere more than AT_GRADE_RISE_M over the higher of its ends (a tunnel
 * under a hill does). A road or path must also be at least UNDER_BUILDINGS_SHARE under buildings (not
 * open roofs), since under a street or a railway the model has their level, not the tunnel's. They
 * become ways on the ground (not tunnels), the walls of the buildings they run through open for them (as
 * tall as the room a tunnel would have), and open roofs over them are raised over that room. Returns how many there are.
 */
export function uncoverAtGrade(features: MapFeatures, heightAt: (e: number, n: number) => number | undefined): number {
  const buildings = features.buildings
    .filter((b) => !b.part && b.shelter === undefined)
    .map((b) => ({ polygon: b.polygon, box: bounds(b.polygon.outer) }));
  const underBuilding = ([e, n]: Point) =>
    buildings.some(({ polygon, box }) => e >= box.minX && e <= box.maxX && n >= box.minY && n <= box.maxY && pointInPolygon([e, n], polygon));
  const passages: { line: Point[]; width: number; height: number; railway: boolean }[] = [];
  for (const way of [...features.roads, ...features.rails]) {
    if (!way.tunnel || way.lid || way.layer < -1 || way.line.length < 2) {
      continue;
    }
    const points = densify(way.line, AT_GRADE_STEP_M);
    const ends = [heightAt(...points[0]), heightAt(...points[points.length - 1])];
    const ground = points.map((p) => heightAt(...p));
    if (ends.some((h) => h === undefined) || ground.some((h) => h === undefined)) {
      continue;
    }
    const top = Math.max(...ends.filter((h) => h !== undefined));
    const road = "width" in way;
    // a railway runs at the ground wherever the ground is level along it: there are no railways under the
    // floors of basements, and its neighbours under the same deck are only partly under buildings
    const covered = !road || points.filter(underBuilding).length >= points.length * UNDER_BUILDINGS_SHARE;
    if (ground.every((h) => h !== undefined && h <= top + AT_GRADE_RISE_M) && covered) {
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
  // What is over such a way leaves it its room over the highest ground under it along the way, counted
  // from the lowest ground along the building's outline (a building stands no lower): an open roof (a
  // deck mapped as a roof) is raised over it, and a building raised off the ground (min_height, an arena
  // over a railway) starts over it, its top where it was (but at least MIN_RAISED_M tall). So does any
  // building over a railway: it stands on a deck over the tracks (a building over a road or a path at the
  // ground has a passage through it). An open roof over a railway is a deck, drawn as a building raised
  // over it ROOF_M thick, without the posts of a roof, which would stand on the tracks. A building is over
  // a way where the way's room, ROOM_SIDE_M wider than the way on both sides, is under it.
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
 * Sets `floor` on every tunnel that is not in a cut (no lid), adding points to its line, and on ramps
 * split off the ways leading on from its portals (not tunnels). heightAt gives the ground at map meters.
 * Returns how many tunnel ways got floors and how many ramps there are.
 */
export function setTunnelFloors(
  features: MapFeatures,
  heightAt: (e: number, n: number) => number | undefined,
): { floors: number; ramps: number } {
  const tunnels: Way[] = [...features.roads, ...features.rails].filter((w) => w.tunnel && !w.lid && w.line.length >= 2);
  const key = (p: Point) => `${p[0]},${p[1]}`;
  const nodes = new Map<string, Node>();
  for (const way of tunnels) {
    way.line = densify(way.line, FLOOR_STEP_M);
    const depth = ROOF_M + ("width" in way ? (WALKWAYS.has(way.kind) ? WALK_CLEARANCE_M : ROAD_CLEARANCE_M) : RAIL_CLEARANCE_M);
    way.line.forEach((p, i) => {
      const node = nodes.get(key(p)) ?? { p, next: [], depth: 0, floor: Infinity };
      node.depth = Math.max(node.depth, depth);
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
  for (const way of [...features.roads, ...features.rails]) {
    if (inTunnels.has(way) || way.line.length < 2) {
      continue;
    }
    for (const outward of [way.line, [...way.line].reverse()]) {
      const node = nodes.get(key(outward[0]));
      if (node && node.next.length === 1) {
        const heights = [heightAt(...node.p)];
        for (let d = PORTAL_STEP_M; d <= PORTAL_REACH_M; d += PORTAL_STEP_M) {
          const p = pointAlong(outward, d);
          heights.push(p && heightAt(...p));
        }
        const known = heights.filter((h) => h !== undefined);
        if (known.length > 0) {
          node.portal = Math.min(node.portal ?? Infinity, ...known);
        }
      }
    }
  }

  hang(nodes);

  // deep enough under the ground: at the point and halfway to its neighbours. The elevation model
  // smooths the portal's wall into a slope, so the depth is reached PORTAL_EASE_M in from the portal.
  const fromPortal = spread(nodes, [...nodes].filter(([, node]) => node.portal !== undefined).map(([k]) => [k, 0]), (length) => length);
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

  let floors = 0;
  for (const way of tunnels) {
    const floor = way.line.map((p) => nodes.get(key(p))?.floor ?? Infinity);
    if (floor.every(Number.isFinite)) {
      way.floor = floor;
      floors++;
    }
  }

  // the ways leading on from the portals come down to the floor: at a portal the elevation model has the
  // top of its wall, and a slope from it down to the way outside
  const portalFloor = (p: Point) => {
    const node = nodes.get(key(p));
    return node?.portal !== undefined && Number.isFinite(node.floor) ? node.floor : undefined;
  };
  const ramps = rampOut(features.roads, inTunnels, portalFloor, heightAt) + rampOut(features.rails, inTunnels, portalFloor, heightAt);
  return { floors, ramps };
}

/**
 * Splits off the stretches of ways leading on from portals where the ground by the portal is over its
 * floor, and gives them floors: straight from the portal's floor to where a way rising MAX_GRADE from it
 * meets the ground (at most RAMP_REACH_M on). Returns how many ramps there are.
 */
function rampOut<T extends Way>(
  ways: T[],
  tunnels: Set<Way>,
  portalFloor: (p: Point) => number | undefined,
  heightAt: (e: number, n: number) => number | undefined,
): number {
  const added: T[] = [];
  let count = 0;
  for (const way of ways) {
    for (const atStart of [true, false]) {
      if (tunnels.has(way) || way.line.length < 2 || way.deck || way.lid || way.floor) {
        break;
      }
      const outward = atStart ? way.line : [...way.line].reverse();
      const floor = portalFloor(outward[0]);
      if (floor === undefined || (heightAt(...outward[0]) ?? floor) <= floor + RAMP_TOLERANCE_M) {
        continue;
      }
      const along = [0];
      for (let i = 1; i < outward.length; i++) {
        along.push(along[i - 1] + Math.hypot(outward[i][0] - outward[i - 1][0], outward[i][1] - outward[i - 1][1]));
      }
      const length = along[along.length - 1];
      const reach = Math.min(RAMP_REACH_M, length);
      let end = reach;
      for (let d = RAMP_STEP_M; d < reach; d += RAMP_STEP_M) {
        const p = pointAlong(outward, d);
        const h = p && heightAt(...p);
        if (h !== undefined && h <= floor + MAX_GRADE * d) {
          end = d;
          break;
        }
      }
      const endPoint = pointAlong(outward, end) ?? outward[outward.length - 1];
      const top = heightAt(...endPoint) ?? floor;
      const ramp: Point[] = [...outward.filter((_, i) => along[i] < end), endPoint];
      let d = 0;
      const heights = ramp.map((p, i) => {
        d += i > 0 ? Math.hypot(p[0] - ramp[i - 1][0], p[1] - ramp[i - 1][1]) : 0;
        return floor + ((top - floor) * d) / end;
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
  ways.push(...added);
  return count;
}

/**
 * Sets every node's floor from the portals': straight by distance along the stretches between the
 * portals and junctions (and ends), and each junction's the average of the ends of its stretches, weighed
 * by how near they are. Nodes with no portal to go by keep an infinite floor.
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

/**
 * The least of start + cost(meters along the tunnels) from the given starts (node key, start) at every
 * node reached: a shortest path search.
 */
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
