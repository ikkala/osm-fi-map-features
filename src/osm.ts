// Fetches OpenStreetMap data from an Overpass API server and turns it into map features in meters
// east / north of the map origin.
import { createHash } from "node:crypto";
import type { CacheOptions } from "./cache.ts";
import { field, isObject, items, optionalNumber, optionalString } from "./json.ts";
import { LocalProjection, type GeoPoint } from "./projection.ts";
import {
  dedupe,
  distanceToRing,
  extent,
  orientedBox,
  pointInPolygon,
  pointInRing,
  pointKey,
  ringArea,
  ringCentroid,
  stitchRings,
  type Point,
  type Polygon,
  type Ring,
} from "./geometry.ts";

export interface GeoBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface Road {
  /** OSM element, e.g. "w123" for way 123 */
  osm: string;
  /** highway=* value */
  kind: string;
  /** Meters */
  width: number;
  layer: number;
  bridge: boolean;
  tunnel: boolean;
  name?: string;
  /** One-way roads: 1 when traffic goes along line, -1 against it */
  oneway?: 1 | -1;
  /** Roads for vehicles: which sides have a sidewalk, when OSM tells (separate: drawn as ways of their own) */
  sidewalks?: Sidewalks;
  /** Walkways: footway=* value, e.g. sidewalk (beside a street) or crossing */
  footway?: string;
  /** foot=* and bicycle=* values, e.g. designated on a cycleway shared with people walking, no, use_sidepath */
  foot?: string;
  bicycle?: string;
  /** A way shared by people walking and cycling: true when each has a side of its own (segregated=yes) */
  segregated?: boolean;
  line: Point[];
  /** Bridges: deck height (meters above sea level) at every point of line, when heights are known */
  deck?: number[];
  /** A tunnel in a cut in the elevation model: its lid's top (m above sea level) at every point of line */
  lid?: number[];
  /**
   * Other tunnels, ramps down to their portals and tunnels beside tunnels in cuts: the floor (m above sea
   * level) at every point of line, when heights are known
   */
  floor?: number[];
  /**
   * People walking along the way (on its sidewalks for a street) on an average day of the year, both
   * directions together, at every point of line; unset where no one walks (see footfall.ts)
   */
  footfall?: number[];
  /** People cycling along the way on an average day of the year, as footfall (see footfall.ts) */
  cycling?: number[];
  /** Roads for vehicles: who may drive on it, from motor_vehicle=*, motorcar=*, vehicle=* or access=*, when OSM tells */
  motorVehicle?: string;
  /** service=* value of a service road, e.g. parking_aisle or driveway */
  service?: string;
  /** Roads for vehicles: whether buses may drive on it, from bus=* or psv=*, when OSM tells (e.g. designated on a bus lane closed to others) */
  bus?: string;
}

export type Sidewalks = "both" | "left" | "right" | "none" | "separate";

export interface Rail {
  osm: string;
  /** railway=* value */
  kind: string;
  layer: number;
  bridge: boolean;
  tunnel: boolean;
  line: Point[];
  /** Bridges: deck height (meters above sea level) at every point of line, when heights are known */
  deck?: number[];
  /** A tunnel in a cut in the elevation model: its lid's top (m above sea level) at every point of line */
  lid?: number[];
  /**
   * Other tunnels, ramps down to their portals and tunnels beside tunnels in cuts: the floor (m above sea
   * level) at every point of line, when heights are known
   */
  floor?: number[];
  /** Other railways: the track bed (m above sea level) at every point of line, the ground smoothed along it */
  bed?: number[];
}

export interface Building {
  osm: string;
  /** building=* or building:part=* value */
  kind: string;
  /** A building:part; parts describe the 3D shape of the building they are in. */
  part: boolean;
  /** An outline with parts inside it; draw the parts instead of the outline. */
  hasParts: boolean;
  /** Meters above the ground to the top of the roof */
  height: number;
  /** The height is a guess (no height or levels in OSM), which better data may replace */
  heightEstimated?: boolean;
  /**
   * The estimated height is guessed from what the building is (a tower, a tank, a church, see
   * HEIGHTS_BY_TYPE): a building register's storeys would tell it worse
   */
  heightByType?: boolean;
  /**
   * The height is counted from storeys (building:levels or a building register's) at LEVEL_HEIGHT_M each:
   * an old building's taller storeys may replace it (see ages.ts)
   */
  heightFromLevels?: boolean;
  /** Meters above the ground to the bottom (e.g. a part over a passage) */
  minHeight: number;
  /**
   * Meters above sea level that the building stands at, and its height and minHeight count from: its
   * highest ground, or its building's for a part (see setBuildingBases); unset without an elevation model
   */
  base?: number;
  /** Storeys in the walls, from minHeight to the eaves, when OSM or a building register has them */
  levels?: number;
  /** The building class in a building register (e.g. "0121", blocks of flats in Finland) */
  use?: string;
  /** The year it was built: start_date, or the completion year in a building register */
  year?: number;
  /** How the walls' windows are drawn (see WindowStyle); no windows when unset */
  windows?: WindowStyle;
  /** Tagged as no ordinary building (see isSpecial): a tower, a chimney, a church, a monument, ... */
  special?: boolean;
  /** A pitched roof (see RoofShape); no shape is a flat roof */
  roofShape?: RoofShape;
  /** Meters from the eaves to the top of the roof (included in height) */
  roofHeight?: number;
  /**
   * Degrees counter-clockwise from east: the ridge's direction, or for a skillion roof the direction
   * it slopes down to
   */
  roofAngle?: number;
  colour?: string;
  roofColour?: string;
  /** Wall material: building:material or material, or the facade from a building register */
  material?: string;
  /** The material is a guess (brick for an untagged chimney), which a building register's facade replaces */
  materialEstimated?: boolean;
  /**
   * An open structure, a roof on posts: "public_transport" for a bus or tram stop shelter, another
   * shelter_type (gazebo, ...) or "shelter" for other shelters, "roof" for building=roof (canopies)
   */
  shelter?: string;
  name?: string;
  /** Where ways run through the building (tunnel=building_passage): its walls are open there */
  passages?: Opening[];
  /** The rooms of the ways through the building, walled off from its insides */
  passageRooms?: PassageRoom[];
  /** Doors on the outline: OSM's entrance nodes, or guessed (see entrances.ts) */
  entrances?: Entrance[];
  /** Shops, restaurants, offices, ... inside the building (see businesses.ts) */
  businesses?: Business[];
  polygon: Polygon;
}

/** A door at a point on a building's outline */
export interface Entrance {
  at: Point;
  /** entrance=* value (main, staircase, shop, service, yes, ...) */
  kind: string;
  /** Not in OSM: guessed from the building's shape and the street next to it */
  guessed?: boolean;
}

/** The OSM key that tells what a business is */
export type BusinessCategory = "shop" | "office" | "craft" | "amenity" | "healthcare" | "tourism" | "leisure";

/** A shop, restaurant, office or the like in a building */
export interface Business {
  osm: string;
  category: BusinessCategory;
  /** The category's value: supermarket, restaurant, hairdresser, ... (shop=vacant is an empty shop) */
  kind: string;
  name?: string;
  /** The chain it belongs to (brand=*), e.g. "K-Market" */
  brand?: string;
  /** What a restaurant or cafe serves (cuisine=*), e.g. "pizza;burger" */
  cuisine?: string;
  /** The storey it is on (level=*, 0 the ground floor; the lowest of several), when OSM has it */
  level?: number;
  /** Meters east and north of the origin: OSM's node, or the centre of the element */
  point: Point;
  /** Where on the building's outline it shows, when it is near enough to a wall (see businesses.ts) */
  front?: BusinessFront;
}

/** A point on a building's outline where a business shows, e.g. for its sign */
export interface BusinessFront {
  at: Point;
  /** Degrees counter-clockwise from east: straight out of the wall */
  toward: number;
  /** At an OSM entrance of the building (entrance=shop, restaurant, main or yes) */
  entrance?: boolean;
}

/**
 * Windows guessed for ordinary buildings (there is no data on windows): a row per storey, spaced by the
 * style: "house" (few, far apart), "apartments" or "office" (narrow and close together)
 */
export type WindowStyle = "house" | "apartments" | "office";

/** A stretch of a building's outline from `from` to `to` (on one edge) that is open up to height meters */
export interface Opening {
  from: Point;
  to: Point;
  height: number;
  /**
   * Where the opening does not start at the building's base (a door up a slope, into a stair hall): the
   * ground there (m above sea level), which its height counts from
   */
  ground?: number;
}

/**
 * The room of a way through a building: a building is only its walls and roof, so from the openings in
 * its walls one would see into it. The room is walled along the way's sides and has a ceiling at height
 * meters over the ground, over the quadrilaterals between consecutive sections.
 */
export interface PassageRoom {
  /** Across the way, in order along it: where it comes in, its corners, where it goes out; [left, right] */
  sections: [Point, Point][];
  height: number;
  /** Whether the way ends inside the building at its first or last section, so a wall closes the room there */
  closed: [boolean, boolean];
  /**
   * The room's walls, each from point to point with the room on its right (so, as with the outline's
   * rings, the solid side is on the left): along its sides and across its closed ends, less where they
   * are in another room of the building (a way beside it or across it)
   */
  walls: [Point, Point][];
}

export type AreaKind = "water" | "grass" | "forest" | "sand" | "rock" | "pitch" | "paved";

export interface Area {
  osm: string;
  kind: AreaKind;
  /** What grows there: woods get trees and scrub shrubs (see forests.ts) */
  cover?: "trees" | "shrubs";
  polygon: Polygon;
}

/** Broadleaved and conifer trees, and shrubs (bushes) */
export type TreeKind = "broadleaved" | "conifer" | "shrub";

export interface Tree {
  /** Meters east and north of the origin */
  point: Point;
  kind: TreeKind;
  /** Meters from the ground to the top */
  height: number;
  /** Latin genus in lower case, e.g. "betula", when known */
  genus?: string;
  /** Meters around the trunk at chest height, when known */
  trunk?: number;
  /** A tree on a bridge: the deck's height (m above sea level) it stands on */
  base?: number;
}

/** A bridge's outline (man_made=bridge): the whole deck, of which OSM's ways on the bridge are lines */
export interface BridgeOutline {
  osm: string;
  name?: string;
  polygon: Polygon;
}

/**
 * A piece of a bridge's deck: its outline cut across the bridge into short pieces (see decks.ts), as
 * triangles with the height of the deck's top at their corners
 */
export interface BridgeDeck {
  osm: string;
  name?: string;
  /** Meters east and north of the origin */
  vertices: Point[];
  /** Three vertex numbers (from 0) each */
  triangles: number[];
  /** The deck's top (m above sea level) at each vertex */
  heights: number[];
}

/**
 * How a street lamp is held up: on a straight pole (the light on top), on a pole with an arm reaching
 * out, on a high mast (squares, junctions), on a tram or railway catenary mast (with an arm), on a wall,
 * or hung from a wire
 */
export type LampMount = "straight" | "angled" | "high" | "catenary" | "wall" | "wire";

export interface StreetLamp {
  /** Meters east and north of the origin */
  point: Point;
  /** Meters from its base to the light */
  height: number;
  /** Not in OSM: guessed from the mount and the street next to it (see lamps.ts) */
  heightEstimated?: boolean;
  /** When OSM tells it (lamp_mount, support, power=catenary_mast) */
  mount?: LampMount;
  /** Where the light faces: degrees counter-clockwise from east, toward the street next to it or OSM's direction */
  toward?: number;
  /** A lamp on a bridge: the deck's height (m above sea level) it stands on */
  base?: number;
  /** lamp_type=* in lower case (led, sodium, mercury, ...), when known */
  lampType?: string;
}

/** A point on a way (see streets.ts): where it is, which way the way runs there, and the way itself */
export interface WayPoint {
  /** Meters east and north of the origin, on the way's centre line */
  point: Point;
  /** The way's direction there: degrees counter-clockwise from east, along its line */
  along: number;
  /** The way's highway=* value and width (m) */
  kind: string;
  width: number;
  /** On a bridge: the deck's height (m above sea level) there */
  base?: number;
}

/** A crossing painted on a street (highway=crossing, not unmarked) */
export type Crossing = WayPoint;

export interface TrafficSignal extends WayPoint {
  /** The traffic the lights are for: going along the way's line, against it, or both when unset */
  direction?: "forward" | "backward";
}

/** A gate (barrier=gate): across the way it is on, or in the fence or wall it is on */
export interface Gate {
  point: Point;
  /** The direction the gate spans, degrees counter-clockwise from east */
  across: number;
  /** Meters from post to post */
  width: number;
  base?: number;
}

/** Fences, walls, retaining walls and hedges (barrier=*) */
export type BarrierKind = "fence" | "wall" | "retaining_wall" | "hedge";

export interface Barrier {
  osm: string;
  kind: BarrierKind;
  /** Meters above the ground */
  height: number;
  /** Not in OSM: the usual height of its kind */
  heightEstimated?: boolean;
  /** fence_type, material or wall=* in lower case (railing, wire, wood, brick, noise_barrier, ...), when known */
  material?: string;
  /** Cut open where ways cross it and at its gates (see barriers.ts) */
  line: Point[];
}

export interface MapFeatures {
  roads: Road[];
  rails: Rail[];
  buildings: Building[];
  areas: Area[];
  trees: Tree[];
  lamps: StreetLamp[];
  crossings: Crossing[];
  signals: TrafficSignal[];
  gates: Gate[];
  barriers: Barrier[];
  bridgeDecks: BridgeDeck[];
}

/**
 * Area tags and the kind they map to, most important first: an element matching several rules gets
 * the first one. "*" matches any value.
 */
const AREA_RULES: [key: string, values: Record<string, AreaKind>][] = [
  ["natural", { water: "water" }],
  ["waterway", { riverbank: "water" }],
  ["landuse", { reservoir: "water", basin: "water" }],
  ["amenity", { parking: "paved" }],
  ["place", { square: "paved" }],
  ["area:highway", { "*": "paved" }],
  ["leisure", { pitch: "pitch", playground: "sand", park: "grass", garden: "grass" }],
  ["natural", { sand: "sand", beach: "sand", shingle: "sand", bare_rock: "rock", scree: "rock" }],
  ["natural", { wood: "forest", scrub: "forest", grassland: "grass", heath: "grass" }],
  ["landuse", { forest: "forest" }],
  ["landuse", { grass: "grass", meadow: "grass", village_green: "grass", flowerbed: "grass", allotments: "grass", cemetery: "grass" }],
];

/** Default road widths in meters by highway=* value; other values are not roads. */
const ROAD_WIDTHS: Record<string, number> = {
  motorway: 11,
  trunk: 10,
  primary: 9,
  secondary: 8,
  tertiary: 7,
  motorway_link: 5,
  trunk_link: 5,
  primary_link: 5,
  secondary_link: 5,
  tertiary_link: 5,
  unclassified: 6,
  residential: 6,
  living_street: 5,
  service: 4,
  pedestrian: 5,
  track: 3,
  cycleway: 2.5,
  footway: 2.5,
  path: 1.5,
  bridleway: 2,
  steps: 2,
};

const LANE_WIDTH_M = 3.25;

/** Trees in a natural=tree_row stand this far apart (OSM has only the row's line) */
const TREE_ROW_SPACING_M = 8;
/** Heights of trees and shrubs whose height OSM does not have */
const DEFAULT_TREE_HEIGHTS: Record<TreeKind, number> = { broadleaved: 10, conifer: 12, shrub: 2 };

const RAIL_KINDS = new Set(["rail", "tram", "light_rail", "narrow_gauge", "subway", "monorail"]);

export const LEVEL_HEIGHT_M = 3;
/** Building types that are usually one storey when the levels are not tagged */
const SMALL_BUILDINGS = new Set(["shed", "kiosk", "garage", "garages", "carport", "roof", "hut", "cabin", "service", "toilets"]);
/** Height of a bus or tram stop shelter's roof when OSM does not have it */
const STOP_SHELTER_HEIGHT_M = 2.7;
/**
 * Structures (man_made=*) drawn as buildings even without building=*: tall or big enough to stand out
 */
const STRUCTURES = new Set(["chimney", "ventilation_shaft", "storage_tank", "silo", "water_tower", "tower", "gasometer"]);
/**
 * How tall a structure (by man_made=*, else building=*) or a church without a height or levels is guessed:
 * perWidth times its base's longest side, at most max meters. Storeys say little about these. From those
 * with a height in OSM in southern Finland (October 2026): the median of height / width, and about the upper
 * quartile of the heights; chimneys from Tampere's (10 to 18 times, mostly 12).
 */
const HEIGHTS_BY_TYPE = new Map<string, { perWidth: number; max: number }>([
  ["chimney", { perWidth: 12, max: 100 }],
  ["water_tower", { perWidth: 1.3, max: 45 }],
  ["gasometer", { perWidth: 1, max: 40 }],
  ["silo", { perWidth: 1.2, max: 40 }],
  ["storage_tank", { perWidth: 0.8, max: 15 }],
  ["tower", { perWidth: 3.9, max: 50 }],
  ["bell_tower", { perWidth: 3.9, max: 50 }],
  ["church", { perWidth: 0.45, max: 30 }],
  ["cathedral", { perWidth: 0.45, max: 30 }],
  ["chapel", { perWidth: 0.45, max: 30 }],
]);
/**
 * A roof that a road runs under (a canopy over a bus stop's lanes or a petrol station) is at least this
 * tall when OSM does not have its height: vehicles in Finland may be 4.4 m tall.
 */
const ROOF_OVER_ROAD_M = 5;
/** How tall a passage through a building is when its way has no maxheight: for vehicles, and for people */
const PASSAGE_HEIGHT_M = 4;
const WALKWAY_PASSAGE_HEIGHT_M = 3;
/** A covered way comes in at a door in OSM when one of its points is this close to it (m) */
const DOOR_ON_WAY_M = 0.5;
/** Ways indoors are kept this far on from a tunnel's end (m) */
const INDOOR_REACH_M = 30;
/** The passage of a way indoors out of a tunnel starts this far on from the tunnel's end (m) */
const OUT_OF_TUNNEL_M = 1;
/** A way crossing a wall at a slant opens it at most this much wider than the way */
const MAX_PASSAGE_SLANT = 3;
/** highway=* values that only people walk or cycle on */
export const NOT_FOR_VEHICLES = new Set(["footway", "pedestrian", "cycleway", "path", "track", "bridleway", "steps", "corridor"]);
/** Houses that are seldom over two storeys */
const HOUSES = new Set(["house", "detached", "semidetached_house", "terrace", "bungalow"]);

/**
 * The roof shapes: gabled (a ridge along the roof's angle), hipped (the ends slope too),
 * pyramidal (four faces meeting at the top) and skillion (one face)
 */
export type RoofShape = "gabled" | "hipped" | "pyramidal" | "skillion";
/** roof:shape values and the shape drawn for them; others (flat, many, butterfly, ...) are flat */
const ROOF_SHAPES: Record<string, RoofShape> = {
  gabled: "gabled",
  saltbox: "gabled",
  double_saltbox: "gabled",
  quadruple_saltbox: "gabled",
  gambrel: "gabled",
  round: "gabled",
  hipped: "hipped",
  "half-hipped": "hipped",
  side_hipped: "hipped",
  mansard: "hipped",
  pyramidal: "pyramidal",
  cone: "pyramidal",
  dome: "pyramidal",
  onion: "pyramidal",
  skillion: "skillion",
  lean_to: "skillion",
};
/** Building types with a gabled roof when OSM has no roof:shape */
const GABLED_BUILDINGS = new Set([
  ...HOUSES,
  "cabin",
  "hut",
  "shed",
  "garage",
  "farm",
  "farm_auxiliary",
  "barn",
  "stable",
  "cowshed",
  "sauna",
  "allotment_house",
  "church",
  "chapel",
]);
/** building=yes or residential gets a gabled roof too when it is at most this big (m²) and two storeys */
const SMALL_GABLED_AREA_M2 = 150;
/** A guessed roof needs an outline that fills this much of the rectangle around it */
const GUESS_MIN_FILL = 0.85;
/** Slope of a pitched roof whose height is not tagged */
const ROOF_PITCH = (27 * Math.PI) / 180;
const SKILLION_PITCH = (10 * Math.PI) / 180;
const MAX_GUESSED_ROOF_M = 6;
/** roof:direction compass points */
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

/**
 * Storeys of a building whose height and levels are not tagged, guessed from its type and floor area
 * (m²): sheds and anything under 40 m² get one, houses and anything under 150 m² two, others three.
 */
export function estimatedLevels(kind: string, area: number): number {
  if (SMALL_BUILDINGS.has(kind) || area < 40) {
    return 1;
  }
  if (HOUSES.has(kind) || area < 150) {
    return 2;
  }
  return 3;
}

export function overpassQuery(box: GeoBox): string {
  const selectors = ["way[highway]", "way[railway]", "way[building]", "way[\"building:part\"]", "node[natural~\"^(tree|shrub)$\"]", "way[natural=tree_row]", "node[highway=street_lamp]",
    "node[highway~\"^(crossing|traffic_signals)$\"]", "node[barrier=gate]", "way[barrier~\"^(fence|wall|retaining_wall|hedge)$\"]", "way[man_made=bridge]", `way[man_made~"^(${[...STRUCTURES].join("|")})$"]`];
  const relations = ["relation[building][type=multipolygon]", "relation[\"building:part\"][type=multipolygon]", "relation[man_made=bridge][type=multipolygon]"];
  const byKey = new Map<string, string[]>();
  for (const [key, values] of AREA_RULES) {
    byKey.set(key, [...(byKey.get(key) ?? []), ...Object.keys(values)]);
  }
  for (const [key, values] of byKey) {
    const filter = values.includes("*") ? `["${key}"]` : `["${key}"~"^(${values.join("|")})$"]`;
    selectors.push(`way${filter}`);
    relations.push(`relation${filter}[type=multipolygon]`);
  }
  const bbox = [box.south, box.west, box.north, box.east].join(",");
  return `[out:json][timeout:180][bbox:${bbox}];\n(\n${[...selectors, ...relations].map((s) => `  ${s};`).join("\n")}\n);\nout geom;`;
}

export interface OverpassResponse {
  osm3s?: { timestamp_osm_base?: string };
  remark?: string;
  elements: OsmElement[];
}

interface LatLon {
  lat: number;
  lon: number;
}

type Tags = Record<string, string>;

type OsmElement =
  | { type: "node"; id: number; tags?: Tags; lat?: number; lon?: number }
  | { type: "way"; id: number; tags?: Tags; geometry?: LatLon[]; center?: LatLon }
  | { type: "relation"; id: number; tags?: Tags; members?: { type: string; role: string; geometry?: LatLon[] }[]; center?: LatLon };

export interface FetchOptions extends CacheOptions {
  url: string;
}

/** Reads an Overpass JSON response; elements it cannot use are left out. */
export function parseOverpassResponse(value: unknown): OverpassResponse {
  const elements: OsmElement[] = [];
  for (const item of items(field(value, "elements"))) {
    const type = field(item, "type");
    const id = optionalNumber(field(item, "id"));
    if (id === undefined) {
      continue;
    }
    const tags = parseTags(field(item, "tags"));
    // "out center" gives ways and relations their centre instead of their geometry
    const center = parseLatLon(field(item, "center"));
    if (type === "node") {
      elements.push({ type, id, tags, lat: optionalNumber(field(item, "lat")), lon: optionalNumber(field(item, "lon")) });
    } else if (type === "way") {
      elements.push({ type, id, tags, geometry: parseGeometry(field(item, "geometry")), ...(center && { center }) });
    } else if (type === "relation") {
      const members = items(field(item, "members")).map((member) => ({
        type: String(field(member, "type")),
        role: String(field(member, "role") ?? ""),
        geometry: parseGeometry(field(member, "geometry")),
      }));
      elements.push({ type, id, tags, members, ...(center && { center }) });
    }
  }
  return {
    osm3s: { timestamp_osm_base: optionalString(field(value, "osm3s", "timestamp_osm_base")) },
    remark: optionalString(field(value, "remark")),
    elements,
  };
}

function parseTags(value: unknown): Tags | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const tags: Tags = {};
  for (const [key, tag] of Object.entries(value)) {
    if (typeof tag === "string") {
      tags[key] = tag;
    }
  }
  return tags;
}

function parseGeometry(value: unknown): LatLon[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return items(value).flatMap((point) => parseLatLon(point) ?? []);
}

function parseLatLon(value: unknown): LatLon | undefined {
  const lat = optionalNumber(field(value, "lat"));
  const lon = optionalNumber(field(value, "lon"));
  return lat !== undefined && lon !== undefined ? { lat, lon } : undefined;
}

/** Runs an Overpass query, caching the response by query text. */
export async function fetchOverpass(query: string, options: FetchOptions): Promise<{ response: OverpassResponse; cached: boolean }> {
  const hash = createHash("sha256").update(options.url).update("\n").update(query).digest("hex").slice(0, 16);
  const cacheKey = `overpass-${hash}.json`;
  const cachedText = options.refresh ? undefined : await options.cache.get(cacheKey);
  if (cachedText !== undefined) {
    return { response: parseOverpassResponse(JSON.parse(cachedText)), cached: true };
  }
  const res = await fetch(options.url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "osm-fi-map-features" },
    body: new URLSearchParams({ data: query }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Overpass answered ${res.status}: ${text.slice(0, 500)}`);
  }
  const response = parseOverpassResponse(JSON.parse(text));
  // Overpass reports timeouts and memory errors in "remark" with a 200 status and partial data
  if (response.remark && /error/i.test(response.remark)) {
    throw new Error(`Overpass query failed: ${response.remark}`);
  }
  await options.cache.put(cacheKey, text);
  return { response, cached: false };
}

export interface ParseResult {
  features: MapFeatures;
  /** Crossings, traffic signals and gates, still to be put on their ways (streets.ts) */
  streetNodes: StreetNode[];
  /** Bridges' outlines, still to get the heights of their ways' decks (decks.ts) */
  bridgeOutlines: BridgeOutline[];
  /** Problems worth reporting, such as multipolygons with rings that do not close */
  warnings: string[];
  /** The storeys (level=*) of the roads and rails that OSM tells them for, to tell where tunnels come out */
  levels: Map<Road | Rail, number[]>;
  /** Covered ways (covered=yes) that are no passages through buildings: they may come in at a door (see openDoorways) */
  covered: Road[];
}

/** Turns Overpass elements into features in meters east / north of origin. */
export function parseOsm(elements: OsmElement[], origin: GeoPoint): ParseResult {
  const warnings: string[] = [];
  const projection = new LocalProjection(origin);
  const toPoint = (p: LatLon): Point => projection.toMeters({ latitude: p.lat, longitude: p.lon });
  const features: MapFeatures = { roads: [], rails: [], buildings: [], areas: [], trees: [], lamps: [], crossings: [], signals: [], gates: [], barriers: [], bridgeDecks: [] };
  const streetNodes: StreetNode[] = [];
  const bridgeOutlines: BridgeOutline[] = [];
  const passages: Passage[] = [];
  // tunnels and covered ways that may be passages through buildings tagged otherwise
  const maybePassages: { road: Road; passage: Passage }[] = [];
  const covered: Road[] = [];
  const levels = new Map<Road | Rail, number[]>();
  // ways indoors, kept where they come out of a tunnel's end (the stairs up out of an underpass)
  const indoors: Road[] = [];

  for (const element of elements) {
    const tags = element.tags ?? {};
    if (element.type === "node") {
      if ((tags.natural === "tree" || tags.natural === "shrub") && element.lat !== undefined && element.lon !== undefined) {
        features.trees.push(tree(tags, toPoint({ lat: element.lat, lon: element.lon })));
      }
      if (tags.highway === "street_lamp" && element.lat !== undefined && element.lon !== undefined) {
        features.lamps.push(lamp(tags, toPoint({ lat: element.lat, lon: element.lon })));
      }
      const street = element.lat !== undefined && element.lon !== undefined ? streetNode(tags, toPoint({ lat: element.lat, lon: element.lon })) : undefined;
      if (street) {
        streetNodes.push(street);
      }
    } else if (element.type === "way") {
      const osm = `w${element.id}`;
      const points = dedupe((element.geometry ?? []).map(toPoint));
      if (points.length < 2) {
        continue;
      }
      const closed = isClosed(element.geometry ?? []);
      const polygon = () => normalize({ outer: points, holes: [] });
      // a road under construction is drawn as the road it will be: it is mostly there, and in use between works
      const road = tags.highway === "construction" && tags.construction ? { ...tags, highway: tags.construction } : tags;
      if (road.highway && closed && road.area === "yes") {
        // a square or a plaza drawn as an area, not a line
        addArea(features, osm, "paved", polygon());
      } else if (road.highway && ROAD_WIDTHS[road.highway] !== undefined) {
        const width = roadWidth(road);
        const walkway = NOT_FOR_VEHICLES.has(road.highway);
        const way: Road = {
          osm,
          kind: road.highway,
          width,
          ...layering(road),
          ...optionalName(road),
          ...oneway(road),
          ...(walkway ? (road.footway ? { footway: road.footway } : {}) : { ...sidewalks(road), ...motorAccess(road) }),
          ...access(road),
          line: points,
        };
        const storeys = storeysOf(road);
        if (storeys) {
          levels.set(way, storeys);
        }
        if (road.indoor === "yes") {
          indoors.push(way);
        } else {
          features.roads.push(way);
          const passage = { line: points, width, height: meters(road.maxheight) ?? (walkway ? WALKWAY_PASSAGE_HEIGHT_M : PASSAGE_HEIGHT_M) };
          if (road.tunnel === "building_passage") {
            passages.push(passage);
          } else if ((way.tunnel || road.covered === "yes") && way.layer >= -1) {
            maybePassages.push({ road: way, passage });
            if (road.covered === "yes" && !way.tunnel) {
              covered.push(way);
            }
          }
        }
      }
      if (tags.railway && RAIL_KINDS.has(tags.railway)) {
        const rail: Rail = { osm, kind: tags.railway, ...layering(tags), line: points };
        const storeys = storeysOf(tags);
        if (storeys) {
          levels.set(rail, storeys);
        }
        features.rails.push(rail);
      }
      if (tags.natural === "tree_row") {
        features.trees.push(...alongLine(points, TREE_ROW_SPACING_M).map((point) => tree(tags, point)));
      }
      const kind = BARRIER_KINDS.get(tags.barrier ?? "");
      if (kind) {
        features.barriers.push(barrier(osm, kind, tags, points));
      }
      if (closed && points.length >= 3) {
        addPolygonFeature(features, bridgeOutlines, osm, tags, polygon());
      }
    } else if (element.type === "relation" && tags.type === "multipolygon") {
      const osm = `r${element.id}`;
      const ways = (element.members ?? []).flatMap((m) =>
        m.type === "way" && m.geometry && m.geometry.length >= 2 ? [{ role: m.role, geometry: m.geometry }] : [],
      );
      const stitch = (role: string) =>
        stitchRings(ways.filter((m) => (role === "inner") === (m.role === "inner")).map((m) => m.geometry), sameLatLon);
      const outer = stitch("outer");
      const inner = stitch("inner");
      if (outer.unclosed + inner.unclosed > 0) {
        warnings.push(`${osm} (${tags.name ?? "unnamed"}): ${outer.unclosed + inner.unclosed} unclosed ring(s) dropped`);
      }
      const outers = outer.rings.map((ring) => dedupe(ring.map(toPoint))).filter((ring) => ring.length >= 3);
      const holes = inner.rings.map((ring) => dedupe(ring.map(toPoint))).filter((ring) => ring.length >= 3);
      for (const ring of outers) {
        const polygon = normalize({ outer: ring, holes: holes.filter((hole) => pointInRing(hole[0], ring)) });
        addPolygonFeature(features, bridgeOutlines, osm, tags, polygon);
      }
    }
  }

  // the ways indoors are left out (they are inside buildings), but not the ones that lead on from a
  // tunnel's end, up to INDOOR_REACH_M on: stairs up out of an underpass into a stair house over it, and
  // on to its door, are how the tunnel comes out there. They are passages through the buildings they are
  // in, so the walls are open where they go out, and their rooms open into one another. A way out of the
  // tunnel comes into the building from under the ground: its passage starts OUT_OF_TUNNEL_M on, so the
  // wall stays whole there.
  const reached = new Map<string, number>();
  for (const r of features.roads.filter((r) => r.tunnel)) {
    for (const p of [r.line[0], r.line[r.line.length - 1]]) {
      reached.set(pointKey(p), 0);
    }
  }
  const kept = new Set<Road>();
  for (let grown = true; grown; ) {
    grown = false;
    for (const r of indoors) {
      const ends = [r.line[0], r.line[r.line.length - 1]].map(pointKey);
      const from = Math.min(...ends.map((k) => reached.get(k) ?? Infinity));
      if (kept.has(r) || from >= INDOOR_REACH_M) {
        continue;
      }
      kept.add(r);
      grown = true;
      const to = from + r.line.slice(1).reduce((sum, q, i) => sum + Math.hypot(q[0] - r.line[i][0], q[1] - r.line[i][1]), 0);
      for (const k of ends) {
        reached.set(k, Math.min(reached.get(k) ?? Infinity, to));
      }
      features.roads.push(r);
      const height = NOT_FOR_VEHICLES.has(r.kind) ? WALKWAY_PASSAGE_HEIGHT_M : PASSAGE_HEIGHT_M;
      const outward = reached.get(ends[1]) === 0 && reached.get(ends[0]) !== 0 ? [...r.line].reverse() : r.line;
      const line = from === 0 ? withoutStart(outward, OUT_OF_TUNNEL_M) : outward;
      if (line.length >= 2) {
        passages.push({ line, width: r.width, height });
      }
    }
  }

  markBuildingsWithParts(features.buildings);
  const through = new Set<Road>();
  for (const { road, passage } of maybePassages) {
    if (runsThroughBuildings(passage.line, features.buildings)) {
      road.tunnel = false;
      passages.push(passage);
      through.add(road);
    }
  }
  features.buildings.push(...fillUnderFloatingParts(features));
  openPassages(features.buildings, passages);
  raiseRoofsOverRoads(features);
  return { features, streetNodes, bridgeOutlines, warnings, levels, covered: covered.filter((r) => !through.has(r)) };
}

function addPolygonFeature(features: MapFeatures, bridgeOutlines: BridgeOutline[], osm: string, tags: Tags, polygon: Polygon): void {
  if (tags.man_made === "bridge") {
    bridgeOutlines.push({ osm, ...optionalName(tags), polygon });
    return;
  }
  const buildingKind = tags.building && tags.building !== "no" ? tags.building : undefined;
  const partKind = tags["building:part"] && tags["building:part"] !== "no" ? tags["building:part"] : undefined;
  // many chimneys, tanks and towers are mapped as man_made=* alone
  const buildingOrPart = partKind ?? buildingKind ?? (tags.man_made !== undefined && STRUCTURES.has(tags.man_made) ? tags.man_made : undefined);
  if (buildingOrPart) {
    features.buildings.push(building(osm, tags, buildingOrPart, partKind !== undefined, polygon));
    return;
  }
  const kind = areaKind(tags);
  if (kind) {
    addArea(features, osm, kind, polygon, areaCover(tags));
  }
}

function addArea(features: MapFeatures, osm: string, kind: AreaKind, polygon: Polygon, cover?: Area["cover"]): void {
  features.areas.push({ osm, kind, ...(cover && { cover }), polygon });
}

/** What grows in an area: trees in woods, shrubs in scrub */
function areaCover(tags: Tags): Area["cover"] {
  if (tags.natural === "wood" || tags.landuse === "forest") {
    return "trees";
  }
  return tags.natural === "scrub" ? "shrubs" : undefined;
}

/** A natural=tree or natural=shrub node, or a tree of a natural=tree_row */
function tree(tags: Tags, point: Point): Tree {
  const kind: TreeKind = tags.natural === "shrub" ? "shrub" : tags.leaf_type === "needleleaved" ? "conifer" : "broadleaved";
  const genus = (tags.genus ?? tags.species)?.split(/\s+/)[0]?.toLowerCase();
  const height = meters(tags.height);
  const trunk = meters(tags.circumference);
  return {
    point,
    kind,
    height: height !== undefined && height > 0 ? height : DEFAULT_TREE_HEIGHTS[kind],
    ...(genus && { genus }),
    ...(kind !== "shrub" && trunk !== undefined && trunk > 0 && { trunk }),
  };
}

/** lamp_mount=* and support=* values and the mount they are */
const LAMP_MOUNTS = new Map<string, LampMount>([
  ["straight_mast", "straight"],
  ["cast_steel_mast", "straight"],
  ["angled_mast", "angled"],
  ["bent_mast", "angled"],
  ["high_mast", "high"],
  ["wall", "wall"],
  ["wall_mounted", "wall"],
  ["suspended", "wire"],
  ["wire", "wire"],
  ["catenary", "catenary"],
]);
/** Heights of street lamps whose height OSM does not have, until lamps.ts looks at the street */
export const DEFAULT_LAMP_HEIGHTS: Record<LampMount | "unknown", number> = {
  straight: 5,
  angled: 8,
  high: 20,
  catenary: 8,
  wall: 4,
  wire: 7,
  unknown: 5,
};

/** A highway=street_lamp node */
function lamp(tags: Tags, point: Point): StreetLamp {
  const mount = tags.power === "catenary_mast" ? "catenary" : (LAMP_MOUNTS.get(tags.lamp_mount ?? "") ?? LAMP_MOUNTS.get(tags.support ?? ""));
  const height = meters(tags.height);
  const direction = compassDegrees(tags.direction);
  const lampType = tags.lamp_type?.trim().toLowerCase();
  return {
    point,
    ...(height !== undefined && height > 0 ? { height } : { height: DEFAULT_LAMP_HEIGHTS[mount ?? "unknown"], heightEstimated: true }),
    ...(mount && { mount }),
    // direction is clockwise from north
    ...(direction !== undefined && { toward: (((90 - direction) % 360) + 360) % 360 }),
    ...(lampType && { lampType }),
  };
}

/** A crossing, traffic signal or gate node as OSM has it, before streets.ts puts it on its way */
export type StreetNode =
  | { kind: "crossing"; point: Point }
  | { kind: "signal"; point: Point; direction?: TrafficSignal["direction"] }
  | { kind: "gate"; point: Point; width?: number };

/**
 * The street nodes that are drawn: crossings with markings (not crossing=unmarked, crossing:markings=no or
 * markings other than stripes), traffic signals and gates
 */
function streetNode(tags: Tags, point: Point): StreetNode | undefined {
  if (tags.highway === "crossing") {
    const markings = tags["crossing:markings"];
    const striped = markings === undefined ? !UNMARKED_CROSSINGS.has(tags.crossing ?? "") : STRIPED_MARKINGS.has(markings);
    return striped ? { kind: "crossing", point } : undefined;
  }
  if (tags.highway === "traffic_signals") {
    const direction = tags["traffic_signals:direction"];
    return { kind: "signal", point, ...((direction === "forward" || direction === "backward") && { direction }) };
  }
  if (tags.barrier === "gate") {
    const width = meters(tags.width);
    return { kind: "gate", point, ...(width !== undefined && width > 0 && { width }) };
  }
  return undefined;
}
/** crossing=* values without markings, when crossing:markings does not tell */
const UNMARKED_CROSSINGS = new Set(["unmarked", "no", "informal"]);
/** crossing:markings values drawn as stripes */
const STRIPED_MARKINGS = new Set(["yes", "zebra", "zebra:double", "zebra:paired", "zebra:bicolour", "lines", "ladder"]);

/** barrier=* values drawn as fences and walls, and their kinds */
const BARRIER_KINDS = new Map<string, BarrierKind>([
  ["fence", "fence"],
  ["wall", "wall"],
  ["retaining_wall", "retaining_wall"],
  ["hedge", "hedge"],
]);
/** Heights (m) of fences and walls whose height OSM does not have; a noise barrier is a tall wall */
export const DEFAULT_BARRIER_HEIGHTS: Record<BarrierKind, number> = { fence: 1.2, wall: 1.5, retaining_wall: 1, hedge: 1.2 };
const NOISE_BARRIER_HEIGHT_M = 3;

/** A barrier=fence, wall, retaining_wall or hedge way */
function barrier(osm: string, kind: BarrierKind, tags: Tags, line: Point[]): Barrier {
  const material = (tags.fence_type ?? tags.material ?? tags.wall)?.trim().toLowerCase();
  const height = meters(tags.height);
  const guess = material === "noise_barrier" ? NOISE_BARRIER_HEIGHT_M : DEFAULT_BARRIER_HEIGHTS[kind];
  return {
    osm,
    kind,
    ...(height !== undefined && height > 0 ? { height } : { height: guess, heightEstimated: true }),
    ...(material && { material }),
    line,
  };
}

/** Points along a line every `spacing` meters or a little less, the ends included */
export function alongLine(line: Point[], spacing: number): Point[] {
  const lengths = line.slice(1).map((p, i) => Math.hypot(p[0] - line[i][0], p[1] - line[i][1]));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const count = Math.max(1, Math.ceil(total / spacing));
  const points: Point[] = [];
  let segment = 0;
  let start = 0;
  for (let k = 0; k <= count; k++) {
    const at = (total * k) / count;
    while (segment < lengths.length - 1 && start + lengths[segment] < at) {
      start += lengths[segment];
      segment++;
    }
    const t = lengths[segment] > 0 ? Math.min(1, (at - start) / lengths[segment]) : 0;
    const a = line[segment];
    const b = line[segment + 1];
    points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return points;
}

export function areaKind(tags: Tags): AreaKind | undefined {
  for (const [key, values] of AREA_RULES) {
    const value = tags[key];
    if (value !== undefined) {
      const kind = values[value] ?? values["*"];
      if (kind) {
        return kind;
      }
    }
  }
  return undefined;
}

function building(osm: string, tags: Tags, kind: string, part: boolean, polygon: Polygon): Building {
  const taggedRoofHeight = meters(tags["roof:height"]);
  const roofLevels = number(tags["roof:levels"]);
  const levelCount = number(tags["building:levels"]);
  const taggedHeight = meters(tags.height) ?? meters(tags["building:height"]);
  let height = taggedHeight;
  const shelter = tags.amenity === "shelter" ? (tags.shelter_type ?? "shelter") : kind === "roof" ? "roof" : undefined;
  if (height === undefined && levelCount === undefined && shelter === "public_transport") {
    height = STOP_SHELTER_HEIGHT_M;
  }
  // levels say little about how tall an open roof is
  const heightEstimated = height === undefined && (levelCount === undefined || shelter !== undefined);
  const heightFromLevels = height === undefined && !heightEstimated;
  const chimney = tags.man_made === "chimney" || kind === "chimney";
  const structure = tags.man_made !== undefined && STRUCTURES.has(tags.man_made);
  // a church's parts are its tower, nave, ... (a chimney part is a chimney)
  const byType = heightEstimated && (!part || chimney) ? HEIGHTS_BY_TYPE.get(structure ? (tags.man_made ?? kind) : kind) : undefined;
  if (byType) {
    height = Math.max(LEVEL_HEIGHT_M, Math.min(byType.max, byType.perWidth * orientedBox(polygon.outer).length));
  }
  const area = Math.abs(ringArea(polygon.outer));
  // no guessed roof on a tower or a tank
  const roof = pitchedRoof(tags, kind, part || shelter !== undefined || structure || chimney, polygon, area, levelCount, taggedHeight);
  // roof:levels=0 is a roof without a storey in it, not a flat one
  let roofHeight = taggedRoofHeight ?? (roof && roofLevels ? roofLevels * LEVEL_HEIGHT_M : undefined);
  if (height === undefined) {
    const levelsTall = (levelCount ?? estimatedLevels(kind, area)) * LEVEL_HEIGHT_M;
    // a guessed roof goes on top of the storeys
    roofHeight ??= roof?.guessedHeight;
    height = levelsTall + (roofHeight ?? (roofLevels ?? 0) * LEVEL_HEIGHT_M);
  }
  const minLevel = number(tags["building:min_level"]);
  const year = startYear(tags.start_date);
  const minHeight = meters(tags.min_height) ?? (minLevel !== undefined ? minLevel * LEVEL_HEIGHT_M : 0);
  if (height <= minHeight) {
    height = minHeight + LEVEL_HEIGHT_M;
  }
  // building:levels counts from the ground, also in a part that starts higher up
  const wallLevels = levelCount !== undefined ? levelCount - (minLevel ?? 0) : undefined;
  if (roof) {
    // a tagged height includes the roof: a guessed roof takes at most half of it
    roofHeight = Math.min(roofHeight ?? Math.min(roof.guessedHeight, (height - minHeight) / 2), height - minHeight);
  }
  return {
    osm,
    kind,
    part,
    hasParts: false,
    height,
    ...(heightEstimated && { heightEstimated }),
    ...(byType && { heightByType: true }),
    ...(heightFromLevels && { heightFromLevels }),
    minHeight,
    ...(wallLevels !== undefined && wallLevels >= 1 && { levels: Math.round(wallLevels) }),
    ...(roof && { roofShape: roof.shape, roofAngle: roof.angle }),
    ...(roofHeight !== undefined && { roofHeight }),
    ...(tags["building:colour"] && { colour: tags["building:colour"] }),
    ...(tags["roof:colour"] && { roofColour: tags["roof:colour"] }),
    ...wallMaterial(tags, chimney),
    ...(year !== undefined && { year }),
    ...(shelter && { shelter }),
    ...(isSpecial(tags) && { special: true }),
    ...optionalName(tags),
    polygon,
  };
}

/**
 * A building's wall material: building:material, or material (common on chimneys). A chimney with neither
 * gets brick as a guess: Tampere's old factory chimneys are brick.
 */
function wallMaterial(tags: Tags, chimney: boolean): { material?: string; materialEstimated?: boolean } {
  const tagged = tags["building:material"] ?? tags.material;
  if (tagged) {
    return { material: tagged };
  }
  if (chimney) {
    return { material: "brick", materialEstimated: true };
  }
  return {};
}

/**
 * Whether tags say a building is no ordinary one, whatever its building=* value: a structure (man_made=*:
 * towers, chimneys, silos, ...), a place of worship, a historic site or monument (historic=* other than
 * building) or a sight (tourism=attraction or museum).
 */
export function isSpecial(tags: Tags): boolean {
  return (
    (tags.man_made !== undefined && tags.man_made !== "no") ||
    tags.amenity === "place_of_worship" ||
    (tags.historic !== undefined && tags.historic !== "no" && tags.historic !== "building") ||
    tags.tourism === "attraction" ||
    tags.tourism === "museum"
  );
}

/**
 * A building's pitched roof: its shape from roof:shape, or a guessed gabled roof for houses and small
 * buildings with a nearly rectangular outline (not for parts and open roofs). The ridge runs along the
 * long side unless roof:orientation=across; a skillion roof slopes down to roof:direction, or across the
 * long side. guessedHeight is the rise at ROOF_PITCH (SKILLION_PITCH), used when no height is tagged.
 */
function pitchedRoof(
  tags: Tags,
  kind: string,
  partOrOpen: boolean,
  polygon: Polygon,
  area: number,
  levelCount: number | undefined,
  taggedHeight: number | undefined,
): { shape: RoofShape; angle: number; guessedHeight: number } | undefined {
  const box = orientedBox(polygon.outer);
  let shape: RoofShape | undefined;
  if (tags["roof:shape"] !== undefined) {
    shape = ROOF_SHAPES[tags["roof:shape"]];
  } else if (!partOrOpen && polygon.holes.length === 0 && area >= GUESS_MIN_FILL * box.length * box.width) {
    const small = (kind === "yes" || kind === "residential") && area <= SMALL_GABLED_AREA_M2 && (levelCount ?? 1) <= 2;
    const low = taggedHeight === undefined || taggedHeight <= 2 * LEVEL_HEIGHT_M + MAX_GUESSED_ROOF_M;
    shape = (GABLED_BUILDINGS.has(kind) || small) && low ? "gabled" : undefined;
  }
  if (shape === undefined || box.width < 1) {
    return undefined;
  }
  let angle = tags["roof:orientation"] === "across" ? box.angle + Math.PI / 2 : box.angle;
  let rise: number;
  if (shape === "skillion") {
    const bearing = compassDegrees(tags["roof:direction"]);
    angle = bearing !== undefined ? ((90 - bearing) * Math.PI) / 180 : box.angle - Math.PI / 2;
    rise = extent(polygon.outer, angle) * Math.tan(SKILLION_PITCH);
  } else {
    const across = extent(polygon.outer, angle + Math.PI / 2);
    const halfSpan = shape === "pyramidal" ? Math.min(across, extent(polygon.outer, angle)) / 2 : across / 2;
    rise = halfSpan * Math.tan(ROOF_PITCH);
  }
  const degrees = (((angle * 180) / Math.PI) % 360 + 360) % 360;
  return { shape, angle: Math.round(degrees * 10) / 10, guessedHeight: Math.min(rise, MAX_GUESSED_ROOF_M) };
}

/** Parses roof:direction, degrees clockwise from north ("135") or a compass point ("SE"). */
export function compassDegrees(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const point = COMPASS.indexOf(value.trim().toUpperCase());
  if (point >= 0) {
    return point * 22.5;
  }
  const degrees = number(value);
  return degrees !== undefined ? ((degrees % 360) + 360) % 360 : undefined;
}

/** A way through a building (tunnel=building_passage), `height` meters tall */
export interface Passage {
  line: Point[];
  width: number;
  height: number;
}

/**
 * Opens the walls of the buildings (and parts reaching the ground) where passages cross them: as wide
 * as the way along the wall, wider where it crosses at a slant. A passage taller than 0 also gets a
 * room through the building (see PassageRoom), unless rooms is false.
 */
export function openPassages(buildings: Building[], passages: Passage[], rooms = true): void {
  const roomed = new Set<Building>();
  for (const passage of passages) {
    const reach = bounds(passage.line);
    for (const b of buildings) {
      if (b.hasParts || b.shelter !== undefined || b.minHeight > passage.height) {
        continue;
      }
      const box = bounds(b.polygon.outer);
      if (box.maxX < reach.minX || box.minX > reach.maxX || box.maxY < reach.minY || box.minY > reach.maxY) {
        continue;
      }
      for (const ring of [b.polygon.outer, ...b.polygon.holes]) {
        for (let i = 0; i < ring.length; i++) {
          for (let k = 0; k + 1 < passage.line.length; k++) {
            const hit = crossing(ring[i], ring[(i + 1) % ring.length], passage.line[k], passage.line[k + 1], passage.width);
            if (hit) {
              for (const opening of openAlong(ring, i, hit.at, hit.half)) {
                if (!b.passages?.some((o) => samePoint(o.from, opening.from) && samePoint(o.to, opening.to))) {
                  (b.passages ??= []).push({ ...opening, height: passage.height });
                }
              }
            }
          }
        }
      }
      if (passage.height > 0 && rooms) {
        const through = roomsThrough(b.polygon, passage);
        if (through.length > 0) {
          (b.passageRooms ??= []).push(...through);
          roomed.add(b);
        }
      }
    }
  }
  for (const b of roomed) {
    setRoomWalls(b.passageRooms ?? []);
  }
}

/**
 * Opens the walls of stair halls (buildings with doors up a slope, see bases.ts) where a covered way (a
 * stair up the slope under their roof) comes in at one of their doors in OSM: as openPassages, from the
 * ground there, without a room (the hall is the room; the way inside rises under its roof). heightAt
 * gives the ground at map meters. Returns how many openings there are.
 */
export function openDoorways(buildings: Building[], ways: Road[], heightAt: (e: number, n: number) => number | undefined): number {
  let count = 0;
  for (const way of ways) {
    const reach = bounds(way.line);
    for (const b of buildings) {
      const box = bounds(b.polygon.outer);
      if (box.maxX < reach.minX - DOOR_ON_WAY_M || box.minX > reach.maxX + DOOR_ON_WAY_M || box.maxY < reach.minY - DOOR_ON_WAY_M || box.minY > reach.maxY + DOOR_ON_WAY_M) {
        continue;
      }
      const atDoor = (b.entrances ?? []).some((e) => !e.guessed && way.line.some((p) => Math.hypot(p[0] - e.at[0], p[1] - e.at[1]) < DOOR_ON_WAY_M));
      if (!atDoor) {
        continue;
      }
      const before = b.passages?.length ?? 0;
      openPassages([b], [{ line: way.line, width: way.width, height: NOT_FOR_VEHICLES.has(way.kind) ? WALKWAY_PASSAGE_HEIGHT_M : PASSAGE_HEIGHT_M }], false);
      for (const opening of (b.passages ?? []).slice(before)) {
        const ground = heightAt((opening.from[0] + opening.to[0]) / 2, (opening.from[1] + opening.to[1]) / 2);
        if (ground !== undefined) {
          opening.ground = ground;
        }
        count++;
      }
    }
  }
  return count;
}

/** A room's side turning at a corner of its way reaches at most this many half-widths from the way */
const MAX_MITRE = 3;
/** Places this close along a way (meters) are one (a way's node on a building's outline) */
const SAME_PLACE_M = 0.01;

/**
 * The rooms of a passage through a building's polygon: one for each stretch of it inside, from where it
 * comes in (as wide as its opening in the wall) or starts inside, through its corners, to where it goes
 * out or ends. Their walls are set by setRoomWalls.
 */
function roomsThrough(polygon: Polygon, passage: Passage): PassageRoom[] {
  const line = dedupe(passage.line);
  const half = passage.width / 2;
  // meters along the line to each point, and each segment's unit normal to its left
  const run = [0];
  const normals: Point[] = [];
  for (let k = 0; k + 1 < line.length; k++) {
    const length = Math.hypot(line[k + 1][0] - line[k][0], line[k + 1][1] - line[k][1]);
    run.push(run[k] + length);
    normals.push([-(line[k + 1][1] - line[k][1]) / length, (line[k + 1][0] - line[k][0]) / length]);
  }
  if (normals.length === 0) {
    return [];
  }
  const pointAt = (along: number): Point => {
    let k = 0;
    while (k + 2 < line.length && run[k + 1] < along) {
      k++;
    }
    const s = (along - run[k]) / (run[k + 1] - run[k]);
    return [line[k][0] + (line[k + 1][0] - line[k][0]) * s, line[k][1] + (line[k + 1][1] - line[k][1]) * s];
  };

  // where sections go across the way: its points (mitred at a corner) and where it crosses the outline
  const sections: { along: number; section: [Point, Point]; crossing: boolean }[] = [];
  for (let i = 0; i < line.length; i++) {
    const [before, after] = [normals[Math.max(0, i - 1)], normals[Math.min(normals.length - 1, i)]];
    const sum = Math.hypot(before[0] + after[0], before[1] + after[1]);
    const mitre: Point = sum < 1e-9 ? after : [(before[0] + after[0]) / sum, (before[1] + after[1]) / sum];
    const reach = Math.min(half / Math.max(1e-9, mitre[0] * after[0] + mitre[1] * after[1]), half * MAX_MITRE);
    const p = line[i];
    sections.push({
      along: run[i],
      section: [
        [p[0] + mitre[0] * reach, p[1] + mitre[1] * reach],
        [p[0] - mitre[0] * reach, p[1] - mitre[1] * reach],
      ],
      crossing: false,
    });
  }
  for (const ring of [polygon.outer, ...polygon.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const [a, c] = [ring[i], ring[(i + 1) % ring.length]];
      const wall = Math.hypot(c[0] - a[0], c[1] - a[1]);
      for (let k = 0; k + 1 < line.length; k++) {
        const hit = crossing(a, c, line[k], line[k + 1], passage.width);
        if (hit && wall > 1e-9) {
          // across the opening along the wall, its ends on the way's left and right
          const x: Point = [a[0] + (c[0] - a[0]) * hit.at, a[1] + (c[1] - a[1]) * hit.at];
          const [ue, un] = [((c[0] - a[0]) / wall) * hit.half, ((c[1] - a[1]) / wall) * hit.half];
          const leftward = ue * normals[k][0] + un * normals[k][1] > 0;
          const [ahead, back]: Point[] = [
            [x[0] + ue, x[1] + un],
            [x[0] - ue, x[1] - un],
          ];
          const along = run[k] + Math.hypot(x[0] - line[k][0], x[1] - line[k][1]);
          sections.push({ along, section: leftward ? [ahead, back] : [back, ahead], crossing: true });
        }
      }
    }
  }
  // one section at a place, a crossing rather than a point of the way on the outline
  sections.sort((s, t) => s.along - t.along || Number(t.crossing) - Number(s.crossing));
  const places = sections.filter((s, i) => i === 0 || s.along - sections[i - 1].along > SAME_PLACE_M);

  const rooms: PassageRoom[] = [];
  let room: PassageRoom | undefined;
  for (let j = 0; j + 1 < places.length; j++) {
    if (pointInPolygon(pointAt((places[j].along + places[j + 1].along) / 2), polygon)) {
      room ??= { sections: [places[j].section], height: passage.height, closed: [!places[j].crossing, false], walls: [] };
      room.sections.push(places[j + 1].section);
      room.closed[1] = !places[j + 1].crossing;
    } else if (room) {
      rooms.push(room);
      room = undefined;
    }
  }
  if (room) {
    rooms.push(room);
  }
  return rooms;
}

/**
 * Sets the walls of a building's passage rooms: along both sides of each, and across its closed ends,
 * less where they are in another room (a way beside it or across it: one space).
 */
function setRoomWalls(rooms: PassageRoom[]): void {
  const quads = rooms.map((room) =>
    room.sections.slice(1).map(([left, right], i): Point[] => [room.sections[i][0], room.sections[i][1], right, left]),
  );
  rooms.forEach((room, r) => {
    const { sections, closed } = room;
    const last = sections.length - 1;
    const walls: [Point, Point][] = [];
    if (closed[0]) {
      walls.push([sections[0][1], sections[0][0]]);
    }
    for (let i = 0; i < last; i++) {
      walls.push([sections[i][0], sections[i + 1][0]]);
    }
    if (closed[1]) {
      walls.push([sections[last][0], sections[last][1]]);
    }
    for (let i = last; i > 0; i--) {
      walls.push([sections[i][1], sections[i - 1][1]]);
    }
    const others = quads.filter((_, o) => o !== r).flat();
    room.walls = walls.flatMap(([a, b]) => {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const spans = others.map((quad) => spanInside(a, b, quad)).filter((span) => span !== undefined);
      return spansLeft(spans)
        .filter(([t0, t1]) => (t1 - t0) * length > SAME_PLACE_M)
        .map(([t0, t1]): [Point, Point] => [
          [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0],
          [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1],
        ]);
    });
  });
}

/**
 * The span (0 .. 1) of the segment a -> b in a convex polygon or on its edges (within SAME_PLACE_M), or
 * undefined.
 */
function spanInside(a: Point, b: Point, polygon: Point[]): [number, number] | undefined {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [p, q] = [polygon[i], polygon[(i + 1) % polygon.length]];
    area += p[0] * q[1] - q[0] * p[1];
  }
  if (Math.abs(area) < 1e-9) {
    return undefined;
  }
  let [t0, t1] = [0, 1];
  for (let i = 0; i < polygon.length; i++) {
    const [p, q] = [polygon[i], polygon[(i + 1) % polygon.length]];
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (length < 1e-9) {
      continue;
    }
    // how far inside the edge's line a point is (meters), and a little more
    const inside = (x: Point) => (Math.sign(area) * ((q[0] - p[0]) * (x[1] - p[1]) - (q[1] - p[1]) * (x[0] - p[0]))) / length + SAME_PLACE_M;
    const [fa, fb] = [inside(a), inside(b)];
    if (fa < 0 && fb < 0) {
      return undefined;
    }
    if (fa < 0) {
      t0 = Math.max(t0, fa / (fa - fb));
    } else if (fb < 0) {
      t1 = Math.min(t1, fa / (fa - fb));
    }
  }
  return t0 < t1 ? [t0, t1] : undefined;
}

/** What is left of 0 .. 1 without the spans */
function spansLeft(spans: [number, number][]): [number, number][] {
  const left: [number, number][] = [];
  let at = 0;
  for (const [t0, t1] of spans.sort((s, t) => s[0] - t[0])) {
    if (t0 > at) {
      left.push([at, t0]);
    }
    at = Math.max(at, t1);
  }
  if (at < 1) {
    left.push([at, 1]);
  }
  return left;
}

/**
 * Whether a tunnel or covered way is really a passage through buildings (mappers often tag those
 * tunnel=yes): short, neither end well inside a building standing on the ground, and at least half of it
 * inside one. A real tunnel is long or deep (the caller leaves out layers under -1) and runs under
 * other things, and a ramp into a garage ends inside.
 */
function runsThroughBuildings(line: Point[], buildings: Building[]): boolean {
  let length = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    length += Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
  }
  if (length > MAX_GUESSED_PASSAGE_M) {
    return false;
  }
  const reach = bounds(line);
  const grounded = buildings.filter((b) => {
    if (b.hasParts || b.shelter !== undefined || b.minHeight >= 1) {
      return false;
    }
    const box = bounds(b.polygon.outer);
    return box.maxX >= reach.minX && box.minX <= reach.maxX && box.maxY >= reach.minY && box.minY <= reach.maxY;
  });
  const deepInside = (p: Point) => grounded.some((b) => pointInPolygon(p, b.polygon) && distanceToRing(p, b.polygon.outer) > THROUGH_END_SLACK_M);
  if (grounded.length === 0 || deepInside(line[0]) || deepInside(line[line.length - 1])) {
    return false;
  }
  let inside = 0;
  let total = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const [p, q] = [line[i], line[i + 1]];
    const steps = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1])));
    for (let k = 0; k < steps; k++) {
      const point: Point = [p[0] + ((q[0] - p[0]) * (k + 0.5)) / steps, p[1] + ((q[1] - p[1]) * (k + 0.5)) / steps];
      total++;
      if (grounded.some((b) => pointInPolygon(point, b.polygon))) {
        inside++;
      }
    }
  }
  return inside >= total / 2;
}

/** A way's end this close to a building's edge is not inside it (meters) */
const THROUGH_END_SLACK_M = 1;
/** A tunnel or covered way longer than this is not taken for a passage through buildings (meters) */
const MAX_GUESSED_PASSAGE_M = 60;

/** Walls meeting at a corner that turns less than this (radians) are one wall for a passage */
const STRAIGHT_ON = (30 * Math.PI) / 180;

/**
 * The stretches, one per edge, `half` meters either way along the ring from `at` (0 .. 1) on edge i: on
 * into the next edges where the wall goes on nearly straight.
 */
function openAlong(ring: Ring, i: number, at: number, half: number): { from: Point; to: Point }[] {
  const count = ring.length;
  const edge = (j: number) => {
    const a = ring[((j % count) + count) % count];
    const c = ring[(((j + 1) % count) + count) % count];
    return { a, c, length: Math.hypot(c[0] - a[0], c[1] - a[1]) };
  };
  const along = (j: number, k: number): Point => {
    const { a, c } = edge(j);
    return [a[0] + (c[0] - a[0]) * k, a[1] + (c[1] - a[1]) * k];
  };
  const turn = (j: number) => {
    // the turn at the start of edge j
    const before = edge(j - 1);
    const after = edge(j);
    const angle = Math.atan2(after.c[1] - after.a[1], after.c[0] - after.a[0]) - Math.atan2(before.c[1] - before.a[1], before.c[0] - before.a[0]);
    return Math.abs(((angle + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
  };
  const first = edge(i);
  const back = Math.min(at, half / first.length);
  const ahead = Math.min(1 - at, half / first.length);
  const stretches = [{ from: along(i, at - back), to: along(i, at + ahead) }];
  // backwards through the edges before
  let left = half - back * first.length;
  for (let j = i; left > 1e-6 && j > i - count + 1 && turn(j) < STRAIGHT_ON; j--) {
    const previous = edge(j - 1);
    const k = Math.min(1, left / previous.length);
    stretches.push({ from: along(j - 1, 1 - k), to: along(j - 1, 1) });
    left -= k * previous.length;
  }
  // and forwards through the edges after
  left = half - ahead * first.length;
  for (let j = i + 1; left > 1e-6 && j < i + count && turn(j) < STRAIGHT_ON; j++) {
    const next = edge(j);
    const k = Math.min(1, left / next.length);
    stretches.push({ from: along(j, 0), to: along(j, k) });
    left -= k * next.length;
  }
  return stretches.filter((s) => !samePoint(s.from, s.to));
}

/**
 * Where the way p -> q crosses the wall a -> c: at (0 .. 1 along the wall) and the half-width in meters
 * of the stretch of wall it needs, or undefined.
 */
export function crossing(a: Point, c: Point, p: Point, q: Point, width: number): { at: number; half: number } | undefined {
  const [ux, uy] = [c[0] - a[0], c[1] - a[1]];
  const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
  const cross = ux * dy - uy * dx;
  const wall = Math.hypot(ux, uy);
  const way = Math.hypot(dx, dy);
  if (Math.abs(cross) < 1e-9 * wall * way) {
    return undefined;
  }
  // a + ux * t = p + dx * s
  const t = ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / cross;
  const s = ((p[0] - a[0]) * uy - (p[1] - a[1]) * ux) / cross;
  if (t < 0 || t > 1 || s < 0 || s > 1) {
    return undefined;
  }
  const sine = Math.abs(cross) / (wall * way);
  return { at: t, half: Math.min(width / 2 / sine, (width / 2) * MAX_PASSAGE_SLANT) };
}

function samePoint(a: Point, b: Point | undefined): boolean {
  return b !== undefined && Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
}

/** Lifts open roofs without a tagged height that a road runs under to ROOF_OVER_ROAD_M. */
function raiseRoofsOverRoads(features: MapFeatures): void {
  const roofs = features.buildings.filter((b) => b.shelter !== undefined && b.heightEstimated && b.height < ROOF_OVER_ROAD_M);
  const roads = features.roads.filter((r) => !NOT_FOR_VEHICLES.has(r.kind) && !r.tunnel);
  for (const roof of roofs) {
    const box = bounds(roof.polygon.outer);
    const under = roads.some((road) =>
      road.line.some((p, i) => {
        // the road's points, and points every meter between them
        const next = road.line[i + 1] ?? p;
        const steps = Math.max(1, Math.ceil(Math.hypot(next[0] - p[0], next[1] - p[1])));
        for (let k = 0; k < steps; k++) {
          const q: Point = [p[0] + ((next[0] - p[0]) * k) / steps, p[1] + ((next[1] - p[1]) * k) / steps];
          const inBox = q[0] >= box.minX && q[0] <= box.maxX && q[1] >= box.minY && q[1] <= box.maxY;
          if (inBox && pointInPolygon(q, roof.polygon)) {
            return true;
          }
        }
        return false;
      }),
    );
    if (under) {
      roof.height = ROOF_OVER_ROAD_M;
      delete roof.heightEstimated;
    }
  }
}

/**
 * Marks outlines that contain parts: in OSM 3D buildings the parts replace the outline. But mappers often
 * give parts to only some of a building (the low wings of Emmauksen talo, not its 8-storey body), so an
 * outline whose parts cover less than this share of it is drawn as well.
 */
const MIN_PARTS_COVER = 0.5;

function markBuildingsWithParts(buildings: Building[]): void {
  const parts = buildings.filter((b) => b.part).map((b) => ({ b, centroid: ringCentroid(b.polygon.outer), box: bounds(b.polygon.outer) }));
  if (parts.length === 0) {
    return;
  }
  for (const b of buildings) {
    if (!b.part) {
      const box = bounds(b.polygon.outer);
      const inside = parts.filter(
        ({ centroid: p }) => p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minY && p[1] <= box.maxY && pointInPolygon(p, b.polygon),
      );
      b.hasParts = inside.length > 0 && partsCover(b.polygon, inside) >= MIN_PARTS_COVER;
    }
  }
}

/** The share of an outline under its parts (overlapping ones counted once), from a grid of about 400 points. */
function partsCover(outline: Polygon, parts: { b: Building; box: ReturnType<typeof bounds> }[]): number {
  const box = bounds(outline.outer);
  const step = Math.max(0.5, Math.sqrt(((box.maxX - box.minX) * (box.maxY - box.minY)) / 400));
  let points = 0;
  let covered = 0;
  for (let x = box.minX + step / 2; x < box.maxX; x += step) {
    for (let y = box.minY + step / 2; y < box.maxY; y += step) {
      const p: Point = [x, y];
      if (!pointInPolygon(p, outline)) {
        continue;
      }
      points++;
      if (parts.some(({ b, box: pb }) => x >= pb.minX && x <= pb.maxX && y >= pb.minY && y <= pb.maxY && pointInPolygon(p, b.polygon))) {
        covered++;
      }
    }
  }
  return points === 0 ? 1 : covered / points;
}

/**
 * Parts to fill the building under parts that start above its bottom with nothing under them. The outline
 * says the building is there, but mappers often give parts only to what stands out: the planetarium on
 * the second floor of Särkänniemi's building, whose lower floors have no part. A filler is the part's
 * shape, as the outline, from the outline's bottom up to the part. Balconies, roofs and the like float,
 * and so does a part with a way under it (an arcade or a passage).
 */
function fillUnderFloatingParts(features: MapFeatures): Building[] {
  const buildings = features.buildings;
  const outlines = buildings.filter((b) => b.hasParts).map((b) => ({ b, box: bounds(b.polygon.outer) }));
  const parts = buildings.filter((b) => b.part);
  const ways = [...features.roads, ...features.rails].filter((w) => !w.tunnel).map((w) => ({ line: w.line, box: bounds(w.line) }));
  const fillers: Building[] = [];
  for (const part of parts) {
    if (part.minHeight <= 0 || OVERHANGING_PARTS.has(part.kind)) {
      continue;
    }
    const partBox = bounds(part.polygon.outer);
    const nearby = ways.filter(({ box }) => box.maxX >= partBox.minX && box.minX <= partBox.maxX && box.maxY >= partBox.minY && box.minY <= partBox.maxY);
    if (nearby.some(({ line }) => lineEntersPolygon(line, part.polygon))) {
      continue;
    }
    const p = ringCentroid(part.polygon.outer);
    const outline = outlines.find(
      ({ b, box }) =>
        b.minHeight < part.minHeight && p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minY && p[1] <= box.maxY && pointInPolygon(p, b.polygon),
    )?.b;
    const below = parts.some((other) => other !== part && other.minHeight < part.minHeight && pointInPolygon(p, other.polygon));
    if (outline && !below) {
      fillers.push({
        osm: outline.osm,
        kind: outline.kind,
        part: true,
        hasParts: false,
        height: part.minHeight,
        minHeight: outline.minHeight,
        ...(outline.colour && { colour: outline.colour }),
        ...(outline.roofColour && { roofColour: outline.roofColour }),
        ...(outline.material && { material: outline.material }),
        ...(outline.special && { special: true }),
        polygon: part.polygon,
      });
    }
  }
  return fillers;
}

/** building:part=* values that stick out of a building with nothing under them */
const OVERHANGING_PARTS = new Set(["balcony", "roof", "canopy", "antenna", "bridge", "corridor", "porch"]);

/** Whether a line has a point, or a point every meter along it, inside a polygon */
function lineEntersPolygon(line: Point[], polygon: Polygon): boolean {
  for (let i = 0; i < line.length; i++) {
    const [p, next] = [line[i], line[i + 1] ?? line[i]];
    const steps = Math.max(1, Math.ceil(Math.hypot(next[0] - p[0], next[1] - p[1])));
    for (let k = 0; k < steps; k++) {
      if (pointInPolygon([p[0] + ((next[0] - p[0]) * k) / steps, p[1] + ((next[1] - p[1]) * k) / steps], polygon)) {
        return true;
      }
    }
  }
  return false;
}

export function bounds(points: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function roadWidth(tags: Tags): number {
  const width = meters(tags.width) ?? meters(tags["est_width"]);
  if (width !== undefined && width > 0) {
    return width;
  }
  const lanes = number(tags.lanes);
  const fallback = ROAD_WIDTHS[tags.highway];
  return lanes !== undefined && lanes > 0 && fallback >= 6 ? Math.max(fallback, lanes * LANE_WIDTH_M) : fallback;
}

/** The line from `length` meters on (fewer than 2 points when it is no longer) */
function withoutStart(line: Point[], length: number): Point[] {
  let left = length;
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]];
    const step = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (step > left) {
      const t = left / step;
      return [[a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], ...line.slice(i)];
    }
    left -= step;
  }
  return [];
}

/** The storeys a way is on (level=*, such as "0" or "0.5;1"), when OSM tells */
function storeysOf(tags: Tags): number[] | undefined {
  const storeys = (tags.level ?? "").split(";").map((s) => Number.parseFloat(s)).filter(Number.isFinite);
  return storeys.length > 0 ? storeys : undefined;
}

function layering(tags: Tags): { layer: number; bridge: boolean; tunnel: boolean } {
  const layer = Number.parseInt(tags.layer ?? "0", 10);
  return {
    layer: Number.isFinite(layer) ? layer : 0,
    bridge: tags.bridge !== undefined && tags.bridge !== "no",
    // a passage through a building is on the ground
    tunnel: tags.tunnel !== undefined && tags.tunnel !== "no" && tags.tunnel !== "building_passage",
  };
}

function optionalName(tags: Tags): { name?: string } {
  return tags.name ? { name: tags.name } : {};
}

/** Which way traffic goes on a one-way road; motorways and roundabouts are one-way unless tagged otherwise */
function oneway(tags: Tags): { oneway?: 1 | -1 } {
  const value = tags.oneway;
  if (value === "yes" || value === "1" || value === "true") {
    return { oneway: 1 };
  }
  if (value === "-1" || value === "reverse") {
    return { oneway: -1 };
  }
  if (value === undefined && (tags.highway === "motorway" || tags.junction === "roundabout" || tags.junction === "circular")) {
    return { oneway: 1 };
  }
  return {};
}

/** Who may walk and cycle on a way: foot=*, bicycle=* and segregated=* */
export function access(tags: Tags): { foot?: string; bicycle?: string; segregated?: boolean } {
  return {
    ...(tags.foot && { foot: tags.foot }),
    ...(tags.bicycle && { bicycle: tags.bicycle }),
    ...(tags.segregated === "yes" ? { segregated: true } : tags.segregated === "no" ? { segregated: false } : {}),
  };
}

/**
 * Who may drive on a road (the most specific of motor_vehicle=*, motorcar=*, vehicle=*, access=*), whether buses may
 * (bus=*, else psv=*) and its service=*
 */
export function motorAccess(tags: Tags): { motorVehicle?: string; service?: string; bus?: string } {
  const value = tags.motorcar ?? tags.motor_vehicle ?? tags.vehicle ?? tags.access;
  const bus = tags.bus ?? tags.psv;
  return {
    ...(value && { motorVehicle: value }),
    ...(bus && { bus }),
    ...(tags.highway === "service" && tags.service && { service: tags.service }),
  };
}

/** A road's sidewalks from sidewalk=*, sidewalk:both=* or sidewalk:left=* and sidewalk:right=* */
export function sidewalks(tags: Tags): { sidewalks?: Sidewalks } {
  const side = (value: string | undefined) => (value === "yes" ? "yes" : value === "no" || value === "none" ? "no" : value === "separate" ? "separate" : undefined);
  const both = tags.sidewalk ?? tags["sidewalk:both"];
  if (both === "both" || both === "yes") {
    return { sidewalks: "both" };
  }
  if (both === "left" || both === "right" || both === "separate") {
    return { sidewalks: both };
  }
  if (both === "no" || both === "none") {
    return { sidewalks: "none" };
  }
  const left = side(tags["sidewalk:left"]);
  const right = side(tags["sidewalk:right"]);
  if (left === "yes" || right === "yes") {
    return { sidewalks: left === "yes" && right === "yes" ? "both" : left === "yes" ? "left" : "right" };
  }
  if (left === "separate" || right === "separate") {
    return { sidewalks: "separate" };
  }
  return left === "no" && right === "no" ? { sidewalks: "none" } : {};
}

/** Parses an OSM length such as "12", "12.5 m" or "40'" into meters. */
export function meters(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*(m|ft|')?\s*$/.exec(value);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1].replace(",", "."));
  return match[2] === "ft" || match[2] === "'" ? amount * 0.3048 : amount;
}

/** The year of a start_date such as "1965", "1965-05-01" or "1960s"; undefined for "C19", "~1900", ... */
function startYear(value: string | undefined): number | undefined {
  const match = value?.match(/^(\d{4})(?:$|-|s$)/);
  return match ? Number(match[1]) : undefined;
}

/** Parses a plain number such as "3" or "2.5"; lists like "3;4" use the first value. */
function number(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value.split(";")[0].trim().replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

function isClosed(geometry: LatLon[]): boolean {
  return geometry.length >= 4 && sameLatLon(geometry[0], geometry[geometry.length - 1]);
}

function sameLatLon(a: LatLon, b: LatLon): boolean {
  return a.lat === b.lat && a.lon === b.lon;
}

/** Outer rings counter-clockwise, holes clockwise (seen with east right and north up). */
function normalize(polygon: Polygon): Polygon {
  const orient = (ring: Ring, ccw: boolean) => (ringArea(ring) > 0 === ccw ? ring : [...ring].reverse());
  return { outer: orient(polygon.outer, true), holes: polygon.holes.map((hole) => orient(hole, false)) };
}
