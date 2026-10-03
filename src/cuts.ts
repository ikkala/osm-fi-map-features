// Tunnels in cuts. The bare-ground elevation model shows a shallow decked tunnel as an open cut, so it gets
// a lid at the cut's rim, the ways over it become bridges, and buildings over it open. Deep tunnels are
// left to tunnels.ts.
import { crossing, openPassages, type MapFeatures, type Rail, type Road } from "./osm.ts";
import { deckAt } from "./bridges.ts";
import type { Point } from "./geometry.ts";

/** How far beyond its way a tunnel's lid reaches on both sides (m), and how thick it is */
export const LID_EDGE_M = 2;
export const LID_THICKNESS_M = 1;
/** A rail's lid is as wide as its ballast */
const RAIL_WIDTH_M = 3;
/** The ground beside a tunnel is looked for this far out on both sides, this often (m) */
const SIDE_REACH_M = 25;
const SIDE_STEP_M = 2;
/** A tunnel is in a cut where the ground beside it is this much higher on both sides (m) ... */
const MIN_CUT_M = 3;
/** ... at this share of the points along it, sampled this often (m) */
const CUT_SHARE = 0.5;
const SAMPLE_M = 2;
/** The rim of a cut is where the ground rises less than this in a step (m), as at a bridge's approach */
const RIM_RISE_M = 0.2;
/** The lid leaves at least this much room over the floor (m), a typical underpass height */
const CLEARANCE_M = 3.5;
/** A tunnel this close to the lid of a tunnel in a cut (m, edge to edge) is beside it, in the same cut */
const BESIDE_M = 2;
/** A way meeting a tunnel this close to the tunnel's end (m) leads on from it */
const AT_PORTAL_M = 1;

type Way = Road | Rail;

/** Gives tunnels in cuts lids, makes the ways over them bridges and opens the buildings over them */
export function coverCutTunnels(features: MapFeatures, heightAt: (e: number, n: number) => number | undefined): { tunnels: number; crossings: number } {
  const tunnels: { way: Way; width: number }[] = [];
  const ways: { way: Way; width: number }[] = [
    ...features.roads.map((way) => ({ way, width: way.width })),
    ...features.rails.map((way) => ({ way, width: RAIL_WIDTH_M })),
  ];
  for (const { way, width } of ways) {
    if (way.tunnel && way.layer >= -1 && way.line.length >= 2) {
      const lid = cutLid(way.line, heightAt);
      if (lid) {
        way.lid = lid;
        tunnels.push({ way, width: width + 2 * LID_EDGE_M });
      }
    }
  }
  // a tunnel beside one in a cut shares its cut, whose rims it would not find itself; it is often mapped
  // on the cut's wall, so its floor is taken from the cut tunnel
  const cuts = [...tunnels];
  for (const { way, width } of ways) {
    if (way.tunnel && !way.lid && way.layer >= -1 && way.line.length >= 2) {
      const beside = besideCut(way.line, width, cuts, heightAt);
      if (beside) {
        way.lid = beside.lid;
        way.floor = beside.floor;
        tunnels.push({ way, width: width + 2 * LID_EDGE_M });
      }
    }
  }
  const crossings = bridgeOverLids(features.roads, tunnels) + bridgeOverLids(features.rails, tunnels);
  openPassages(
    features.buildings,
    // open up to the building's floor: the tunnel is in the cut under it
    tunnels.map(({ way, width }) => ({ line: way.line, width, height: 0 })),
  );
  return { tunnels: tunnels.length, crossings };
}

/** The lid's top at each point of a tunnel's line (the lower rim, at least clearance over the floor), or undefined if not in a cut */
export function cutLid(line: Point[], heightAt: (e: number, n: number) => number | undefined): number[] | undefined {
  // the rim beside p: walking out, where the ground stops rising after MIN_CUT_M, else the highest ground
  const beside = (p: Point, along: Point) => {
    const [dx, dy] = along;
    const [nx, ny] = [-dy, dx];
    const floor = heightAt(...p) ?? -Infinity;
    const side = (sign: number) => {
      let top = floor;
      for (let d = SIDE_STEP_M; d <= SIDE_REACH_M; d += SIDE_STEP_M) {
        const h = heightAt(p[0] + nx * d * sign, p[1] + ny * d * sign);
        if (h === undefined) {
          continue;
        }
        if (top - floor >= MIN_CUT_M && h - top < RIM_RISE_M) {
          break;
        }
        top = Math.max(top, h);
      }
      return top;
    };
    return Math.min(side(1), side(-1));
  };
  const direction = (a: Point, c: Point): Point => {
    const length = Math.hypot(c[0] - a[0], c[1] - a[1]);
    return length > 0 ? [(c[0] - a[0]) / length, (c[1] - a[1]) / length] : [1, 0];
  };
  let samples = 0;
  let deep = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const [a, c] = [line[i], line[i + 1]];
    const along = direction(a, c);
    const steps = Math.max(1, Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / SAMPLE_M));
    for (let k = 0; k < steps; k++) {
      const p: Point = [a[0] + ((c[0] - a[0]) * (k + 0.5)) / steps, a[1] + ((c[1] - a[1]) * (k + 0.5)) / steps];
      const floor = heightAt(...p);
      samples++;
      if (floor !== undefined && beside(p, along) - floor >= MIN_CUT_M) {
        deep++;
      }
    }
  }
  if (deep < samples * CUT_SHARE) {
    return undefined;
  }
  return line.map((p, i) => {
    const along = direction(line[Math.max(0, i - 1)], line[Math.min(line.length - 1, i + 1)]);
    const floor = heightAt(...p) ?? 0;
    return Math.max(beside(p, along), floor + CLEARANCE_M + LID_THICKNESS_M);
  });
}

/** The lid and floor of a tunnel mostly beside cut tunnels, from the nearest one's; undefined when not beside */
function besideCut(
  line: Point[],
  width: number,
  cuts: { way: Way; width: number }[],
  heightAt: (e: number, n: number) => number | undefined,
): { lid: number[]; floor: number[] } | undefined {
  const nearest = (p: Point) => {
    let best: { d: number; way: Way; at: Point } | undefined;
    for (const cut of cuts) {
      const { distance, at } = nearestOnLine(p, cut.way.line);
      const d = distance - cut.width / 2 - width / 2;
      if (!best || d < best.d) {
        best = { d, way: cut.way, at };
      }
    }
    return best;
  };
  let samples = 0;
  let beside = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const [a, c] = [line[i], line[i + 1]];
    const steps = Math.max(1, Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / SAMPLE_M));
    for (let k = 0; k < steps; k++) {
      const p: Point = [a[0] + ((c[0] - a[0]) * (k + 0.5)) / steps, a[1] + ((c[1] - a[1]) * (k + 0.5)) / steps];
      samples++;
      if ((nearest(p)?.d ?? Infinity) <= BESIDE_M) {
        beside++;
      }
    }
  }
  if (samples === 0 || beside < samples * CUT_SHARE) {
    return undefined;
  }
  const lid: number[] = [];
  const floor: number[] = [];
  for (const p of line) {
    const near = nearest(p);
    const ground = near && heightAt(...near.at);
    if (!near?.way.lid || ground === undefined) {
      return undefined;
    }
    lid.push(deckAt(near.way.line, near.way.lid, p));
    floor.push(ground);
  }
  return { lid, floor };
}

/** The nearest point of a line to p, and how far it is */
function nearestOnLine(p: Point, line: Point[]): { distance: number; at: Point } {
  let best = { distance: Infinity, at: line[0] };
  for (let i = 0; i + 1 < line.length; i++) {
    const [a, c] = [line[i], line[i + 1]];
    const [dx, dy] = [c[0] - a[0], c[1] - a[1]];
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq > 0 ? Math.min(Math.max(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq, 0), 1) : 0;
    const at: Point = [a[0] + dx * t, a[1] + dy * t];
    const distance = Math.hypot(at[0] - p[0], at[1] - p[1]);
    if (distance < best.distance) {
      best = { distance, at };
    }
  }
  return best;
}

/** Splits the ways crossing the lids and makes the stretches over them bridges. Returns how many. */
function bridgeOverLids<T extends Way>(ways: T[], tunnels: { way: Way; width: number }[]): number {
  const portals = tunnels.flatMap(({ way }) => [way.line[0], way.line[way.line.length - 1]]);
  const added: T[] = [];
  let count = 0;
  for (const way of ways) {
    if (way.tunnel || way.bridge || way.lid) {
      continue;
    }
    const along = [0];
    for (let i = 1; i < way.line.length; i++) {
      along.push(along[i - 1] + Math.hypot(way.line[i][0] - way.line[i - 1][0], way.line[i][1] - way.line[i - 1][1]));
    }
    const over: [number, number][] = [];
    for (const { way: tunnel, width } of tunnels) {
      for (let i = 0; i + 1 < way.line.length; i++) {
        for (let k = 0; k + 1 < tunnel.line.length; k++) {
          const hit = crossing(way.line[i], way.line[i + 1], tunnel.line[k], tunnel.line[k + 1], width);
          const [a, c] = [way.line[i], way.line[i + 1]];
          const p: Point | undefined = hit && [a[0] + (c[0] - a[0]) * hit.at, a[1] + (c[1] - a[1]) * hit.at];
          // a way meeting the tunnel at its end leads on from it, and does not cross it
          if (hit && p && !portals.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < AT_PORTAL_M)) {
            const at = along[i] + hit.at * (along[i + 1] - along[i]);
            over.push([Math.max(0, at - hit.half), Math.min(along[along.length - 1], at + hit.half)]);
          }
        }
      }
    }
    if (over.length === 0) {
      continue;
    }
    over.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [from, to] of over) {
      const last = merged[merged.length - 1];
      if (last && from <= last[1] + SAMPLE_M) {
        last[1] = Math.max(last[1], to);
      } else {
        merged.push([from, to]);
      }
    }
    // cut the way at the stretches' ends: the first piece stays in the way, the others are added
    const cuts = [0, ...merged.flat(), along[along.length - 1]];
    const pieces: { line: Point[]; bridge: boolean }[] = [];
    for (let j = 0; j + 1 < cuts.length; j++) {
      const piece = slice(way.line, along, cuts[j], cuts[j + 1]);
      if (piece.length >= 2) {
        pieces.push({ line: piece, bridge: j % 2 === 1 });
      }
    }
    const [first, ...rest] = pieces;
    if (!first) {
      continue;
    }
    way.line = first.line;
    way.bridge = first.bridge;
    for (const piece of rest) {
      added.push({ ...way, line: piece.line, bridge: piece.bridge });
    }
    count += merged.length;
  }
  ways.push(...added);
  return count;
}

/** The part of a line from `from` to `to` meters along it; along is each point's distance */
function slice(line: Point[], along: number[], from: number, to: number): Point[] {
  const at = (d: number): Point => {
    for (let i = 1; i < line.length; i++) {
      if (d <= along[i] || i === line.length - 1) {
        const span = along[i] - along[i - 1];
        const k = span > 0 ? Math.min(Math.max((d - along[i - 1]) / span, 0), 1) : 0;
        return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * k, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * k];
      }
    }
    return line[0];
  };
  const points: Point[] = [at(from)];
  for (let i = 0; i < line.length; i++) {
    if (along[i] > from && along[i] < to) {
      points.push(line[i]);
    }
  }
  points.push(at(to));
  return points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 1e-6);
}
