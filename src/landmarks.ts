// What stands in the landscape apart from buildings and ways, from a query of its own: lighthouses, lights, beacons
// and buoys (seamarks.ts), masts, flagpoles, boulders, fountains, artworks and memorials, power lines with their
// towers and poles, piers, dams and weirs, amusement rides (rides.ts) and ski and skating tracks.
import { dedupe, distanceToSegment, nearestPlace, RectGrid, ringArea, ringCentroid, type Point, type Ring } from "./geometry.ts";
import { bounds, meters, NOT_FOR_VEHICLES, type GeoBox, type OverpassResponse, type Rail, type Road } from "./osm.ts";
import { LocalProjection, type GeoPoint } from "./projection.ts";
import { COURSE_KINDS, RIDE_KINDS, setCourseHeights, type Ride } from "./rides.ts";
import { parseSeamark, type Seamark } from "./seamarks.ts";

export type LandmarkKind = "flagpole" | "mast" | "tower" | "stone" | "fountain" | "artwork" | "memorial" | "power_tower" | "power_pole";

export interface Landmark {
  osm: string;
  kind: LandmarkKind;
  /**
   * Its own kind in lower case, when OSM tells: a mast's or tower's tower:type (communication, lighting, ...), an
   * artwork's artwork_type (statue, sculpture, bust, ...), a memorial's memorial=* (stele, plaque, war_memorial, ...)
   * or monument (historic=monument), a fountain's fountain=*, a flagpole's flag:type
   */
  type?: string;
  /** Meters east and north of the origin: the node, or the middle of the way */
  point: Point;
  /** A closed way's outline, counter-clockwise */
  outline?: Ring;
  name?: string;
  /** Meters, when OSM tells */
  height?: number;
  /** material=* in lower case, when OSM tells */
  material?: string;
  /** A mast's or tower's tower:construction (lattice, freestanding, guyed_tube, ...), when OSM tells */
  construction?: string;
  /** A landmark on a bridge: the deck's height (m above sea level) it stands on (see standOnDecks) */
  base?: number;
}

export interface Pier {
  osm: string;
  name?: string;
  /** An open way's line, `width` wide */
  line?: Point[];
  /** Meters: width=*, else the usual width of a pier */
  width?: number;
  /** A closed way's outline, counter-clockwise */
  outline?: Ring;
  /** floating=yes: on pontoons, at the water's surface */
  floating?: boolean;
  /** surface=*, else material=*, in lower case (wood, concrete, ...), when OSM tells */
  surface?: string;
}

export interface Dam {
  osm: string;
  /** waterway=*: dam | weir | lock_gate */
  kind: string;
  name?: string;
  /** An open way's line, `width` wide */
  line?: Point[];
  width?: number;
  /** A closed way's outline, counter-clockwise */
  outline?: Ring;
  material?: string;
}

export interface PowerLine {
  osm: string;
  /** power=*: line | minor_line */
  kind: string;
  /** Volts (voltage=*, the highest of a list), when OSM tells */
  voltage?: number;
  /** cables=*, when OSM tells */
  cables?: number;
  line: Point[];
}

export interface Piste {
  osm: string;
  /** piste:type=* in lower case: nordic | ice_skate | downhill | sled | ski_jump | ... */
  kind: string;
  /** piste:grooming=* in lower case (classic;skating, classic+skating, backcountry, ...), when OSM tells */
  grooming?: string;
  /** piste:name=*, else name=* */
  name?: string;
  line?: Point[];
  outline?: Ring;
  /** Meters, when OSM tells */
  width?: number;
}

export interface Landmarks {
  seamarks: Seamark[];
  landmarks: Landmark[];
  piers: Pier[];
  dams: Dam[];
  rides: Ride[];
  powerLines: PowerLine[];
  pistes: Piste[];
}

/** A pier drawn as a line is this wide when OSM does not tell (m) */
export const PIER_WIDTH_M = 2;
/** A dam or weir drawn as a line is this thick when OSM does not tell (m) */
export const DAM_WIDTH_M = 3;
/** Pistes that are no longer or not yet there */
const NOT_PISTES = new Set(["construction", "proposed", "abandoned", "disused", "no"]);
/** A landmark keeps this much room (m) round its point clear of the roads for vehicles and the railways (this wide, m) */
const ROOM_M = 0.5;
const RAIL_WIDTH_M = 3;
/** A landmark on one moves at most this far (m) off it, to places looked at this far (m) apart */
const OFF_WAY_M = 6;
const OFF_WAY_STEP_M = 0.05;
/** Landmarks that stand where their line has its vertex */
const ON_LINES = new Set<LandmarkKind>(["power_tower", "power_pole"]);

export function landmarkQuery(box: GeoBox): string {
  const selectors = [
    'nwr[man_made~"^(lighthouse|mast|flagpole|pier)$"]',
    'node[man_made~"^(tower|communications_tower)$"]',
    'nwr["seamark:type"~"^(light|beacon_|buoy_)"]',
    'nwr[natural=stone]',
    "nwr[amenity=fountain]",
    "nwr[tourism=artwork]",
    'nwr[historic~"^(memorial|monument)$"]',
    'way[power~"^(line|minor_line)$"]',
    'node[power~"^(tower|pole)$"]',
    'way[waterway~"^(dam|weir|lock_gate)$"]',
    "nwr[attraction]",
    "way[roller_coaster=track]",
    'nwr["piste:type"]',
  ];
  const bbox = [box.south, box.west, box.north, box.east].join(",");
  return `[out:json][timeout:120][bbox:${bbox}];\n(\n${selectors.map((s) => `  ${s};`).join("\n")}\n);\nout geom;`;
}

/** The landmarks of an Overpass response ("out geom") in meters around origin; relations are left out */
export function parseLandmarks(elements: OverpassResponse["elements"], origin: GeoPoint): Landmarks {
  const projection = new LocalProjection(origin);
  const toPoint = (p: { lat: number; lon: number }): Point => projection.toMeters({ latitude: p.lat, longitude: p.lon });
  const result: Landmarks = { seamarks: [], landmarks: [], piers: [], dams: [], rides: [], powerLines: [], pistes: [] };
  for (const element of elements) {
    const tags = element.tags ?? {};
    let shape: Shape | undefined;
    if (element.type === "node" && element.lat !== undefined && element.lon !== undefined) {
      shape = { osm: `n${element.id}`, point: toPoint({ lat: element.lat, lon: element.lon }) };
    } else if (element.type === "way" && element.geometry && element.geometry.length >= 2) {
      shape = wayShape(`w${element.id}`, element.geometry.map(toPoint), tags);
    }
    if (!shape || tags.indoor === "yes") {
      continue;
    }
    addElement(result, tags, shape);
  }
  setCourseHeights(result.rides);
  return result;
}

/**
 * Moves a node's landmark on the ground (no base) whose room reaches onto a road for vehicles or a railway on the
 * ground, within its width, to the nearest place clear of them within OFF_WAY_M: OSM maps a work at a stop on the
 * platform's edge by the street, and a road's width is often its kind's. One with no such place is left out; power
 * supports stay where their lines have them. Returns how many were moved and left out.
 */
export function moveLandmarksOffWays(landmarks: Landmark[], roads: Road[], rails: Rail[]): { moved: number; aside: number } {
  const free = new Set(landmarks.filter((l) => l.base === undefined && !l.outline && !ON_LINES.has(l.kind)));
  const ways = [
    ...roads.filter((r) => !r.tunnel && !r.bridge && !NOT_FOR_VEHICLES.has(r.kind)).map((r) => ({ line: r.line, half: r.width / 2 })),
    ...rails.filter((r) => !r.tunnel && !r.bridge).map((r) => ({ line: r.line, half: RAIL_WIDTH_M / 2 })),
  ];
  if (free.size === 0 || ways.length === 0) {
    return { moved: 0, aside: 0 };
  }
  const over = bounds([...free].map((l) => l.point));
  const reach = OFF_WAY_M + ROOM_M;
  const grid = new RectGrid<{ a: Point; b: Point; half: number }>(25, { minX: over.minX - reach, minY: over.minY - reach, maxX: over.maxX + reach, maxY: over.maxY + reach });
  for (const { line, half } of ways) {
    for (let i = 0; i + 1 < line.length; i++) {
      const [a, b] = [line[i], line[i + 1]];
      const r = half + ROOM_M;
      grid.add({ minX: Math.min(a[0], b[0]) - r, minY: Math.min(a[1], b[1]) - r, maxX: Math.max(a[0], b[0]) + r, maxY: Math.max(a[1], b[1]) + r }, { a, b, half });
    }
  }
  const clear = (p: Point) => (grid.at(p).every((s) => distanceToSegment(p, s.a, s.b) >= s.half + ROOM_M) ? p : undefined);
  let [moved, aside] = [0, 0];
  const kept = landmarks.filter((landmark) => {
    if (!free.has(landmark) || clear(landmark.point)) {
      return true;
    }
    const place = nearestPlace(landmark.point, OFF_WAY_M, OFF_WAY_STEP_M, clear);
    if (!place) {
      aside++;
      return false;
    }
    landmark.point = place;
    moved++;
    return true;
  });
  landmarks.splice(0, landmarks.length, ...kept);
  return { moved, aside };
}

/** A node's point, or a way's middle with its outline (closed) or line (open) */
interface Shape {
  osm: string;
  point: Point;
  outline?: Ring;
  line?: Point[];
}

function wayShape(osm: string, raw: Point[], tags: Record<string, string>): Shape | undefined {
  const closed = raw.length >= 4 && raw[0][0] === raw[raw.length - 1][0] && raw[0][1] === raw[raw.length - 1][1];
  const points = dedupe(raw);
  // a course's, a power line's or a piste's loop stays a line, closed back to its start
  const course =
    COURSE_KINDS.has(tags.attraction ?? "") || tags.roller_coaster === "track" || tags.power !== undefined || (tags["piste:type"] !== undefined && tags.area !== "yes");
  if (closed && points.length >= 3 && !course && tags.area !== "no") {
    const outline = ringArea(points) > 0 ? points : [...points].reverse();
    return { osm, point: ringCentroid(outline), outline };
  }
  const line = closed && course ? [...points, points[0]] : points;
  if (line.length < 2) {
    return undefined;
  }
  return { osm, point: middleOf(line), line };
}

/** The point halfway along a line */
function middleOf(line: Point[]): Point {
  const lengths = line.slice(1).map((p, i) => Math.hypot(p[0] - line[i][0], p[1] - line[i][1]));
  let left = lengths.reduce((sum, l) => sum + l, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i] && lengths[i] > 0) {
      const t = left / lengths[i];
      return [line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t];
    }
    left -= lengths[i];
  }
  return line[0];
}

function addElement(result: Landmarks, tags: Record<string, string>, shape: Shape): void {
  const { osm, point, outline, line } = shape;
  const name = tags.name?.trim() || undefined;
  const height = positive(meters(tags.height));
  const width = positive(meters(tags.width));
  const material = lower(tags.material);
  const seamark = parseSeamark(tags, osm, point);
  if (seamark) {
    result.seamarks.push(seamark);
    return;
  }
  const attraction = lower(tags.attraction);
  if ((attraction && RIDE_KINDS.has(attraction)) || tags.roller_coaster === "track") {
    const layer = Number(tags.layer?.trim().replace("−", "-"));
    result.rides.push({
      osm,
      kind: attraction && RIDE_KINDS.has(attraction) ? attraction : "track",
      ...(name && { name }),
      point,
      ...(outline && { outline }),
      ...(line && { line }),
      ...(Number.isInteger(layer) && layer !== 0 && { layer }),
      ...(tags.tunnel === "yes" && { tunnel: true }),
      ...(height !== undefined && { height }),
      ...(tags.building && tags.building !== "no" && { building: true }),
    });
    return;
  }
  if (tags.man_made === "pier") {
    if (outline || line) {
      const surface = lower(tags.surface) ?? material;
      result.piers.push({
        osm,
        ...(name && { name }),
        ...(line && { line, width: width ?? PIER_WIDTH_M }),
        ...(outline && { outline }),
        ...(tags.floating === "yes" && { floating: true }),
        ...(surface && { surface }),
      });
    }
    return;
  }
  const waterway = lower(tags.waterway);
  if (waterway === "dam" || waterway === "weir" || waterway === "lock_gate") {
    if (outline || line) {
      result.dams.push({
        osm,
        kind: waterway,
        ...(name && { name }),
        ...(line && { line, width: width ?? DAM_WIDTH_M }),
        ...(outline && { outline }),
        ...(material && { material }),
      });
    }
    return;
  }
  if ((tags.power === "line" || tags.power === "minor_line") && line) {
    const voltages = (tags.voltage ?? "").split(";").map(Number).filter((v) => Number.isFinite(v) && v > 0);
    const cables = Number(tags.cables?.split(";")[0]);
    result.powerLines.push({
      osm,
      kind: tags.power,
      ...(voltages.length > 0 && { voltage: Math.max(...voltages) }),
      ...(Number.isInteger(cables) && cables > 0 && { cables }),
      line,
    });
    return;
  }
  const piste = lower(tags["piste:type"]);
  if (piste) {
    if (!NOT_PISTES.has(piste) && (line || outline)) {
      const pisteName = tags["piste:name"]?.trim() || name;
      result.pistes.push({
        osm,
        kind: piste,
        ...(lower(tags["piste:grooming"]) && { grooming: lower(tags["piste:grooming"]) }),
        ...(pisteName && { name: pisteName }),
        ...(line && { line }),
        ...(outline && { outline }),
        ...(width !== undefined && { width }),
      });
    }
    return;
  }
  // drawn as buildings already
  if (tags.building && tags.building !== "no") {
    return;
  }
  const landmark = landmarkKind(tags);
  if (landmark) {
    const construction = lower(tags["tower:construction"]);
    result.landmarks.push({
      osm,
      kind: landmark.kind,
      ...(landmark.type && { type: landmark.type }),
      point,
      ...(outline && { outline }),
      ...(name && { name }),
      ...(height !== undefined && { height }),
      ...(material && { material }),
      ...(construction && { construction }),
    });
  }
}

/** The kind of a landmark and its own kind, first match decides: a fountain that is an artwork is a fountain */
function landmarkKind(tags: Record<string, string>): { kind: LandmarkKind; type?: string } | undefined {
  const manMade = tags.man_made;
  if (tags.amenity === "fountain") {
    return { kind: "fountain", type: lower(tags.fountain) };
  }
  if (manMade === "flagpole") {
    return { kind: "flagpole", type: lower(tags["flag:type"]) };
  }
  if (manMade === "mast" || manMade === "tower" || manMade === "communications_tower") {
    return { kind: manMade === "mast" ? "mast" : "tower", type: lower(tags["tower:type"]) };
  }
  if (tags.power === "tower" || tags.power === "pole") {
    return { kind: tags.power === "tower" ? "power_tower" : "power_pole", type: lower(tags.design) };
  }
  if (tags.natural === "stone") {
    return { kind: "stone" };
  }
  if (tags.tourism === "artwork") {
    return { kind: "artwork", type: lower(tags.artwork_type) };
  }
  if (tags.historic === "memorial" || tags.historic === "monument") {
    return { kind: "memorial", type: tags.historic === "monument" ? "monument" : lower(tags.memorial) };
  }
  return undefined;
}

function lower(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || undefined;
}

function positive(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined;
}
