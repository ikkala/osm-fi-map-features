// Puts crossings, traffic signals and gates (OSM nodes) on their ways. The lines have been simplified by
// then, so a node is on the way passing nearest to it, if close enough.
import { deckAt } from "./bridges.ts";
import { nearestOnLine, type Point } from "./geometry.ts";
import { bounds, NOT_FOR_VEHICLES, type Crossing, type Gate, type MapFeatures, type Road, type StreetNode, type TrafficSignal, type WayPoint } from "./osm.ts";

/** A node this close (m) to a way's line is on it */
const ON_WAY_M = 1;
/** A gate in a fence or a wall, on no way, is this wide (m) unless OSM says */
const GATE_WIDTH_M = 1.2;

interface Candidate<T> {
  item: T;
  line: Point[];
  box: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * Puts the crossings, traffic signals and gates on their ways (features.crossings, signals and gates),
 * ignoring tunnels. Returns how many were left out for being on no way.
 */
export function placeStreetNodes(nodes: StreetNode[], features: MapFeatures): { dropped: number } {
  const candidates = <T extends { line: Point[] }>(items: T[]): Candidate<T>[] =>
    items.filter((i) => i.line.length >= 2).map((item) => ({ item, line: item.line, box: bounds(item.line) }));
  const roads = candidates(features.roads.filter((r) => !r.tunnel));
  const streets = roads.filter((c) => !NOT_FOR_VEHICLES.has(c.item.kind));
  const barriers = candidates(features.barriers);
  let dropped = 0;
  for (const node of nodes) {
    const onStreet = nearest(node.kind === "gate" ? roads : streets, node.point);
    const inBarrier = node.kind === "gate" && !onStreet ? nearest(barriers, node.point) : undefined;
    if (node.kind === "crossing" && onStreet) {
      features.crossings.push(wayPoint(onStreet.item, onStreet.segment, node.point) satisfies Crossing);
    } else if (node.kind === "signal" && onStreet) {
      const signal: TrafficSignal = { ...wayPoint(onStreet.item, onStreet.segment, node.point), ...(node.direction && { direction: node.direction }) };
      features.signals.push(signal);
    } else if (node.kind === "gate" && onStreet) {
      const way = wayPoint(onStreet.item, onStreet.segment, node.point);
      features.gates.push({
        point: node.point,
        across: (way.along + 90) % 360,
        width: node.width ?? way.width,
        ...(way.base !== undefined && { base: way.base }),
      } satisfies Gate);
    } else if (node.kind === "gate" && inBarrier) {
      const { line } = inBarrier.item;
      const across = direction(line[inBarrier.segment], line[inBarrier.segment + 1]);
      features.gates.push({ point: node.point, across, width: node.width ?? GATE_WIDTH_M } satisfies Gate);
    } else {
      dropped++;
    }
  }
  return { dropped };
}

/** The item whose line passes within ON_WAY_M of p nearest to it, and the segment it passes on */
function nearest<T>(candidates: Candidate<T>[], p: Point): { item: T; segment: number } | undefined {
  let best: { item: T; segment: number; distance: number } | undefined;
  for (const { item, line, box } of candidates) {
    if (p[0] < box.minX - ON_WAY_M || p[0] > box.maxX + ON_WAY_M || p[1] < box.minY - ON_WAY_M || p[1] > box.maxY + ON_WAY_M) {
      continue;
    }
    const { distance, segment } = nearestOnLine(line, p);
    if (distance <= ON_WAY_M && (!best || distance < best.distance)) {
      best = { item, segment, distance };
    }
  }
  return best;
}

/** p on a road: the road's direction on the segment, its kind and width, and its deck's height if any */
function wayPoint(road: Road, segment: number, p: Point): WayPoint {
  return {
    point: p,
    along: direction(road.line[segment], road.line[segment + 1]),
    kind: road.kind,
    width: road.width,
    ...(road.deck && { base: deckAt(road.line, road.deck, p) }),
  };
}

/** Degrees counter-clockwise from east from a to b, 0 .. 360 */
function direction(a: Point, b: Point): number {
  const degrees = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  return ((degrees % 360) + 360) % 360;
}

