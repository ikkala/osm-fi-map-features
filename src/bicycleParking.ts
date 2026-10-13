// Bicycle parking (amenity=bicycle_parking): a stand or rack at a node, or an area of them, with how many bicycles
// it takes, what kind it is and whether it is covered, as far as OSM tells.
import { dedupe, ringArea, ringCentroid, type Point, type Ring } from "./geometry.ts";
import type { GeoBox, OverpassResponse } from "./osm.ts";
import { LocalProjection, type GeoPoint } from "./projection.ts";

/** Bicycle parking: at a point, or an area with its outline */
export interface BicycleParking {
  /** OSM element, e.g. "n123" */
  osm: string;
  /** A node's point, an area's middle */
  point: Point;
  /** An area's outline, counterclockwise */
  outline?: Ring;
  /** bicycle_parking=*: stands, wall_loops, rack, shed, building, ..., when OSM tells */
  kind?: string;
  /** capacity=*: how many bicycles, when OSM tells */
  capacity?: number;
  /** covered=yes, or a shed or building of its own */
  covered?: boolean;
  /** access=* when not for everyone (private, customers, ...) */
  access?: string;
  /** level=* below or above the ground floor (a car park's basement), when OSM tells */
  level?: number;
}

export function bicycleParkingQuery(box: GeoBox): string {
  const bbox = [box.south, box.west, box.north, box.east].join(",");
  return `[out:json][timeout:60][bbox:${bbox}];\n(\n  node[amenity=bicycle_parking];\n  way[amenity=bicycle_parking];\n);\nout geom;`;
}

const PUBLIC_ACCESS = new Set(["yes", "public", "permissive"]);
const ROOFED = new Set(["shed", "building", "lockers"]);

/** The bicycle parking of an Overpass response ("out geom") in meters around origin */
export function parseBicycleParking(elements: OverpassResponse["elements"], origin: GeoPoint): BicycleParking[] {
  const projection = new LocalProjection(origin);
  const toPoint = (p: { lat: number; lon: number }): Point => projection.toMeters({ latitude: p.lat, longitude: p.lon });
  const result: BicycleParking[] = [];
  for (const element of elements) {
    const tags = element.tags ?? {};
    if (tags.amenity !== "bicycle_parking") {
      continue;
    }
    const kind = tags.bicycle_parking?.trim().toLowerCase();
    const capacity = /^[0-9]+$/.test(tags.capacity ?? "") ? Number(tags.capacity) : undefined;
    const access = tags.access?.trim().toLowerCase();
    const level = Number.parseFloat(tags.level ?? "");
    const details = {
      ...(kind && { kind }),
      ...(capacity !== undefined && capacity > 0 && { capacity }),
      ...((tags.covered === "yes" || (kind !== undefined && ROOFED.has(kind))) && { covered: true }),
      ...(access && !PUBLIC_ACCESS.has(access) && { access }),
      ...(Number.isFinite(level) && level !== 0 && { level }),
    };
    if (element.type === "node" && element.lat !== undefined && element.lon !== undefined) {
      result.push({ osm: `n${element.id}`, point: toPoint({ lat: element.lat, lon: element.lon }), ...details });
    } else if (element.type === "way" && element.geometry) {
      const geometry = element.geometry;
      const points = dedupe(geometry.map(toPoint));
      const [first, last] = [geometry[0], geometry[geometry.length - 1]];
      const closed = geometry.length >= 4 && first.lat === last.lat && first.lon === last.lon;
      if (closed && points.length >= 3) {
        const outline = ringArea(points) > 0 ? points : [...points].reverse();
        result.push({ osm: `w${element.id}`, point: ringCentroid(outline), outline, ...details });
      } else if (points.length >= 2) {
        // a row of stands drawn as a line: at its middle
        const [a, b] = [points[0], points[points.length - 1]];
        result.push({ osm: `w${element.id}`, point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], ...details });
      }
    }
  }
  return result;
}
