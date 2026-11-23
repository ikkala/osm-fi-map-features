// Playground equipment (playground=*), and where it faces. OSM seldom tells a piece's direction or size: a way
// tells them by its line or outline, a swing lines up with the next swing in its row, and other nodes with the
// nearest edge of the playground they stand in.
import { boxCentre, dedupe, distanceToSegment, inRect, orientedBox, pointInPolygon, ringArea, type Point, type Polygon, type Ring } from "./geometry.ts";
import { bounds, isClosed, meters, unionQuery, type GeoBox, type OverpassResponse, type PlayEquipment } from "./osm.ts";
import { latLonMeters, type GeoPoint } from "./projection.ts";

/** Nodes of a kind this close (m) are one piece mapped twice */
const SAME_M = 1.5;
/** A swing lines up with the nearest swing this close (m): frames in a row */
const ROW_M = 6;
const IN_ROWS = new Set(["swing", "basketswing"]);
/** A playground's edges shorter than this (m) tell no direction, unless all are */
const MIN_EDGE_M = 2;

export function playgroundQuery(box: GeoBox): string {
  return unionQuery(box, 60, ["node[playground]", "way[playground]"]);
}

/** The playground equipment of an Overpass response ("out geom") in meters around origin (playground=no left out) */
export function parsePlayEquipment(elements: OverpassResponse["elements"], origin: GeoPoint): PlayEquipment[] {
  const toPoint = latLonMeters(origin);
  const result: PlayEquipment[] = [];
  for (const element of elements) {
    const tags = element.tags ?? {};
    const kind = tags.playground?.trim().toLowerCase();
    if (!kind || kind === "no") {
      continue;
    }
    const capacity = /^[0-9]+$/.test(tags.capacity ?? "") ? Number(tags.capacity) : undefined;
    const material = tags.material?.trim().toLowerCase();
    const height = meters(tags.height);
    const theme = tags["playground:theme"]?.trim().toLowerCase();
    const details = {
      ...(capacity !== undefined && capacity > 0 && { capacity }),
      ...(tags.baby === "yes" ? { baby: true } : tags.baby === "no" ? { baby: false } : {}),
      ...(material && { material }),
      ...(height !== undefined && height > 0 && { height }),
      ...(theme && { theme }),
    };
    if (element.type === "node" && element.lat !== undefined && element.lon !== undefined) {
      result.push({ osm: `n${element.id}`, kind, point: toPoint({ lat: element.lat, lon: element.lon }), ...details });
    } else if (element.type === "way" && element.geometry) {
      const points = dedupe(element.geometry.map(toPoint));
      if (isClosed(element.geometry) && points.length >= 3) {
        result.push({ osm: `w${element.id}`, kind, ...boxOf(points), outline: ringArea(points) > 0 ? points : [...points].reverse(), ...details });
      } else if (points.length >= 2) {
        const [a, b] = [points[0], points[points.length - 1]];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (length > 0) {
          result.push({ osm: `w${element.id}`, kind, point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], along: degrees(b[0] - a[0], b[1] - a[1]), length, ...details });
        }
      }
    }
  }
  return result;
}

/** An outline's smallest box: its middle, the direction of its long side (0 .. 180) and its sides */
function boxOf(ring: Ring): { point: Point; along: number; length: number; width: number } {
  const box = orientedBox(ring);
  return { point: boxCentre(ring, box.angle), along: (box.angle * 180) / Math.PI, length: box.length, width: box.width };
}

/**
 * Merges nodes of a kind mapped twice into one, and sets `along` where OSM does not tell it: a swing's to the
 * nearest swing in its row, others' to the nearest edge of the playground they stand in. Returns the equipment and
 * how many nodes were merged, lined up in rows and with a playground's edge.
 */
export function placePlayEquipment(
  equipment: PlayEquipment[],
  playgrounds: Polygon[],
): { equipment: PlayEquipment[]; merged: number; rows: number; edges: number } {
  const placed = mergeTwice(equipment);
  const counts = { merged: equipment.length - placed.length, rows: 0, edges: 0 };
  const swings = placed.filter((p) => IN_ROWS.has(p.kind));
  const outlines = playgrounds.map((polygon) => ({ polygon, box: bounds(polygon.outer) }));
  for (const piece of placed) {
    if (piece.along !== undefined) {
      continue;
    }
    const [e, n] = piece.point;
    if (IN_ROWS.has(piece.kind)) {
      let nearest: PlayEquipment | undefined;
      let distance = ROW_M;
      for (const other of swings) {
        const d = Math.hypot(other.point[0] - e, other.point[1] - n);
        if (other !== piece && d > 0 && d <= distance) {
          nearest = other;
          distance = d;
        }
      }
      if (nearest) {
        piece.along = degrees(nearest.point[0] - e, nearest.point[1] - n) % 180;
        counts.rows++;
        continue;
      }
    }
    const playground = outlines.find(({ polygon, box }) => inRect(piece.point, box) && pointInPolygon(piece.point, polygon));
    if (playground) {
      piece.along = nearestEdge(piece.point, playground.polygon);
      counts.edges++;
    }
  }
  return { equipment: placed, ...counts };
}

/** Nodes (no way's size) of the same kind within SAME_M of each other become one, at their middle */
function mergeTwice(equipment: PlayEquipment[]): PlayEquipment[] {
  const groups: PlayEquipment[][] = [];
  const result: PlayEquipment[] = [];
  for (const piece of equipment) {
    if (piece.length !== undefined) {
      result.push(piece);
      continue;
    }
    const group = groups.find((g) => g[0].kind === piece.kind && g.some((p) => Math.hypot(p.point[0] - piece.point[0], p.point[1] - piece.point[1]) <= SAME_M));
    if (group) {
      group.push(piece);
    } else {
      groups.push([piece]);
    }
  }
  for (const group of groups) {
    const e = group.reduce((sum, p) => sum + p.point[0], 0) / group.length;
    const n = group.reduce((sum, p) => sum + p.point[1], 0) / group.length;
    // the first one's tags, with any the others add
    const merged: PlayEquipment = { ...group[0], point: [e, n] };
    for (const other of group.slice(1)) {
      merged.capacity ??= other.capacity;
      merged.baby ??= other.baby;
      merged.material ??= other.material;
      merged.height ??= other.height;
      merged.theme ??= other.theme;
    }
    result.push(merged);
  }
  return result;
}

/** The direction (0 .. 180) of the polygon's edge nearest to the point, of those at least MIN_EDGE_M long if any */
function nearestEdge(point: Point, polygon: Polygon): number {
  const edges: [Point, Point][] = [polygon.outer, ...polygon.holes].flatMap((ring) => ring.map((p, i): [Point, Point] => [p, ring[(i + 1) % ring.length]]));
  const long = edges.filter(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]) >= MIN_EDGE_M);
  let best: [Point, Point] = edges[0];
  let distance = Infinity;
  for (const edge of long.length > 0 ? long : edges) {
    const d = distanceToSegment(point, edge[0], edge[1]);
    if (d < distance) {
      best = edge;
      distance = d;
    }
  }
  return degrees(best[1][0] - best[0][0], best[1][1] - best[0][1]) % 180;
}

/** The direction of (dx, dy) in degrees counter-clockwise from east, 0 .. 360 */
function degrees(dx: number, dy: number): number {
  return (((Math.atan2(dy, dx) * 180) / Math.PI) % 360 + 360) % 360;
}
