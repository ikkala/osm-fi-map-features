// A city's districts as areas in meters around an origin, from OpenStreetMap: its administrative divisions below
// the municipality and its places of a suburb's kind, each with its name and the kind it is mapped as, as cities
// map them differently. A user's points matched to them (districtOf) are a Derivative Database under the ODbL (see
// the README's Licences); the user's own data stays a database of its own.
import { dedupe, pointInPolygon, ringArea, ringCentroid, stitchRings, type Point, type Polygon } from "./geometry.ts";
import { fetchOverpass, type FetchOptions, type GeoBox, type OsmElement } from "./osm.ts";
import { LocalProjection, type GeoPoint } from "./projection.ts";

/** The kinds a district can be mapped as, from the largest commonly: "admin_level=<n>" or "place=<value>" */
export const DISTRICT_KINDS = ["admin_level=9", "admin_level=10", "place=suburb", "place=quarter", "place=neighbourhood"] as const;

export interface District {
  /** The OSM element: "r<id>" or "w<id>" */
  osm: string;
  name: string;
  /** One of DISTRICT_KINDS */
  kind: string;
  /** Outer rings counter-clockwise, holes clockwise */
  polygons: Polygon[];
  /** The area-weighted centroid of its largest ring, or its label node when it has one inside it */
  center: Point;
  /** m² */
  area: number;
}

/** The Overpass query of the districts in the box, with their geometry */
export function districtsQuery(box: GeoBox): string {
  const bbox = [box.south, box.west, box.north, box.east].join(",");
  const levels = DISTRICT_KINDS.flatMap((kind) => (kind.startsWith("admin_level=") ? [kind.slice("admin_level=".length)] : []));
  const places = DISTRICT_KINDS.flatMap((kind) => (kind.startsWith("place=") ? [kind.slice("place=".length)] : []));
  const selectors = [
    `relation[boundary=administrative][admin_level~"^(${levels.join("|")})$"][name]`,
    `relation[place~"^(${places.join("|")})$"][name]`,
    `way[place~"^(${places.join("|")})$"][name]`,
  ];
  return `[out:json][timeout:180][bbox:${bbox}];\n(\n${selectors.map((s) => `  ${s};`).join("\n")}\n);\nout geom;`;
}

/** The kind a district's tags map it as, or undefined for any other element */
export function districtKind(tags: Record<string, string>): string | undefined {
  const kinds: readonly string[] = DISTRICT_KINDS;
  if (tags.boundary === "administrative" && kinds.includes(`admin_level=${tags.admin_level}`)) {
    return `admin_level=${tags.admin_level}`;
  }
  return tags.place !== undefined && kinds.includes(`place=${tags.place}`) ? `place=${tags.place}` : undefined;
}

type LatLon = { lat: number; lon: number };

function sameLatLon(a: LatLon, b: LatLon): boolean {
  return a.lat === b.lat && a.lon === b.lon;
}

/** Outer rings counter-clockwise, holes clockwise */
function oriented(polygon: Polygon): Polygon {
  const orient = (ring: Point[], ccw: boolean) => (ringArea(ring) > 0 === ccw ? ring : [...ring].reverse());
  return { outer: orient(polygon.outer, true), holes: polygon.holes.map((hole) => orient(hole, false)) };
}

function polygonArea(polygon: Polygon): number {
  return Math.abs(ringArea(polygon.outer)) - polygon.holes.reduce((sum, hole) => sum + Math.abs(ringArea(hole)), 0);
}

/**
 * The districts of an Overpass answer (districtsQuery's), in meters around `origin`: a relation's outer and inner
 * members stitched into rings, a closed way a ring of its own; with warnings of the rings that do not close.
 */
export function parseDistricts(elements: OsmElement[], origin: GeoPoint): { districts: District[]; warnings: string[] } {
  const projection = new LocalProjection(origin);
  const toPoint = (p: LatLon): Point => projection.toMeters({ latitude: p.lat, longitude: p.lon });
  const districts: District[] = [];
  const warnings: string[] = [];
  for (const element of elements) {
    const tags = element.tags ?? {};
    const kind = districtKind(tags);
    const name = tags.name?.trim();
    if (!kind || !name || element.type === "node") {
      continue;
    }
    let polygons: Polygon[] = [];
    let label: Point | undefined;
    if (element.type === "way") {
      const ring = dedupe((element.geometry ?? []).map(toPoint));
      const geometry = element.geometry ?? [];
      const closed = geometry.length >= 4 && sameLatLon(geometry[0], geometry[geometry.length - 1]);
      if (closed && ring.length >= 3) {
        polygons = [oriented({ outer: ring, holes: [] })];
      }
    } else {
      const members = element.members ?? [];
      const ways = members.flatMap((m) => (m.type === "way" && m.geometry && m.geometry.length >= 2 ? [{ role: m.role, geometry: m.geometry }] : []));
      const outer = stitchRings(ways.filter((m) => m.role !== "inner").map((m) => m.geometry), sameLatLon);
      const inner = stitchRings(ways.filter((m) => m.role === "inner").map((m) => m.geometry), sameLatLon);
      if (outer.unclosed + inner.unclosed > 0) {
        warnings.push(`r${element.id} (${name}): ${outer.unclosed + inner.unclosed} unclosed ring(s) dropped`);
      }
      const outers = outer.rings.map((ring) => dedupe(ring.map(toPoint))).filter((ring) => ring.length >= 3);
      const holes = inner.rings.map((ring) => dedupe(ring.map(toPoint))).filter((ring) => ring.length >= 3);
      polygons = outers.map((ring) => oriented({ outer: ring, holes: holes.filter((hole) => pointInPolygon(hole[0], { outer: ring, holes: [] })) }));
      const labelNode = members.find((m) => m.type === "node" && m.role === "label");
      if (labelNode && labelNode.lat !== undefined && labelNode.lon !== undefined) {
        label = toPoint({ lat: labelNode.lat, lon: labelNode.lon });
      }
    }
    if (polygons.length === 0) {
      continue;
    }
    const largest = polygons.reduce((a, b) => (polygonArea(b) > polygonArea(a) ? b : a));
    const inside = label !== undefined && polygons.some((polygon) => pointInPolygon(label, polygon));
    districts.push({
      osm: `${element.type === "way" ? "w" : "r"}${element.id}`,
      name,
      kind,
      polygons,
      center: inside && label ? label : ringCentroid(largest.outer),
      area: polygons.reduce((sum, polygon) => sum + polygonArea(polygon), 0),
    });
  }
  return { districts, warnings };
}

/** The districts in the box, from Overpass or the cache */
export async function fetchDistricts(box: GeoBox, origin: GeoPoint, options: FetchOptions): Promise<{ districts: District[]; warnings: string[]; cached: boolean }> {
  const { response, cached } = await fetchOverpass(districtsQuery(box), options);
  return { ...parseDistricts(response.elements, origin), cached };
}

/** The smallest of the districts of the kind (any, without one) that has the point in it, or undefined */
export function districtOf<T extends Pick<District, "kind" | "polygons" | "area">>(districts: T[], point: Point, kind?: string): T | undefined {
  let found: T | undefined;
  for (const district of districts) {
    if ((kind === undefined || district.kind === kind) && (found === undefined || district.area < found.area)) {
      if (district.polygons.some((polygon) => pointInPolygon(point, polygon))) {
        found = district;
      }
    }
  }
  return found;
}

/**
 * The kind the city's districts are mapped as: of those with at least `least` districts, the one whose districts
 * have the most of the points in them, the earlier in DISTRICT_KINDS on a tie; undefined when none has
 */
export function districtKindOf(districts: Pick<District, "kind" | "polygons" | "area">[], points: Point[], least = 2): string | undefined {
  let best: { kind: string; count: number } | undefined;
  for (const kind of DISTRICT_KINDS) {
    const ofKind = districts.filter((district) => district.kind === kind);
    if (ofKind.length < least) {
      continue;
    }
    const count = points.filter((point) => districtOf(ofKind, point) !== undefined).length;
    if (count > 0 && (best === undefined || count > best.count)) {
      best = { kind, count };
    }
  }
  return best?.kind;
}
