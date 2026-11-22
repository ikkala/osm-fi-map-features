// Fetches OpenStreetMap data from Overpass and turns it into map features in meters east / north of the origin.
import type { BicycleParking } from "./bicycleParking.ts";
import { FINNISH_DEFAULTS_MEASURED_IN_TAMPERE } from "./measuredDefaults.ts";
import { createHash } from "node:crypto";
import type { CacheOptions } from "./cache.ts";
import type { Dam, Landmark, Pier, Piste, PowerLine } from "./landmarks.ts";
import type { Pitch, PitchOutline } from "./pitches.ts";
import { inTunnel, type AsBuilt, type ProfileKind } from "./profile.ts";
import type { Ride } from "./rides.ts";
import type { Seamark } from "./seamarks.ts";
import { field, isObject, items, optionalNumber, optionalString } from "./json.ts";
import { LocalProjection, type GeoPoint } from "./projection.ts";
import { exactYear } from "./startDates.ts";
import type { RoofFaces } from "./roofRidges.ts";
import { WALKWAYS } from "./ways.ts";
import {
  dedupe,
  distanceToRing,
  extent,
  indexBoxes,
  nearestOnLine,
  orientedBox,
  pointInPolygon,
  pointInRing,
  pointKey,
  ringArea,
  ringCentroid,
  stitchRings,
  type Point,
  type Polygon,
  type Rect,
  type Ring,
} from "./geometry.ts";

/** The main use classes of the Finnish building register; work includes the unclassified */
export type BuildingUse = "house" | "holiday" | "apartments" | "public" | "work" | "ancillary" | "sauna";

export interface GeoBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** A way as OSM tags it: its `bridge` and `tunnel` are OSM's, where the stages built it otherwise its AsBuilt's facts */
export interface Road extends AsBuilt {
  /** OSM element, e.g. "w123" for way 123 */
  osm: string;
  /** highway=* value */
  kind: string;
  /** Meters */
  width: number;
  /** The width is OSM's (width=* or est_width=*), not its kind's */
  widthTagged?: true;
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
  /** A bridge's stretch over a tunnel's lid, which carries it */
  onLid?: boolean;
  /** Other tunnels and ramps to their portals: the floor (m above sea level) at every point of line, when known */
  floor?: number[];
  /** In a map's tiles: what the way's surface lies on (profile.ts), its heights the field the kind names */
  profile?: ProfileKind;
  /** People walking along the way per average day, both directions, at every point of line (see footfall.ts) */
  footfall?: number[];
  /** People cycling along the way on an average day of the year, as footfall (see footfall.ts) */
  cycling?: number[];
  /** Roads for vehicles: who may drive on it, from motor_vehicle=*, motorcar=*, vehicle=* or access=*, when OSM tells */
  motorVehicle?: string;
  /** service=* value of a service road, e.g. parking_aisle or driveway */
  service?: string;
  /** Roads for vehicles: the height a vehicle may have (maxheight=*, m), when OSM tells */
  maxHeight?: number;
  /** Roads for vehicles: how many lanes it has (lanes=*), when OSM tells */
  lanes?: number;
  /** Tunnels: the room over the floor (m) where lower than its kind's, from maxheight=* (see tunnels.ts) */
  room?: number;
  /** Roads for vehicles: whether buses may drive on it, from bus=* or psv=*, when OSM tells (e.g. designated on a bus lane closed to others) */
  bus?: string;
  /** Roads for vehicles: on which side of line, going along it, a bus bay lies beside the road (bus_bay=*), when OSM tells */
  busBay?: "left" | "right" | "both";
  /** Steps: how many (step_count=*), and whether they climb along line or go down it (incline=*), when OSM tells */
  stepCount?: number;
  incline?: "up" | "down";
  /** surface=* (asphalt, paving_stones, fine_gravel, ...), when OSM tells; steps without one take their material=* */
  surface?: string;
  /** Bridges: bridge:structure=* (beam, truss, arch, suspension, ...) and colour=*, when OSM tells */
  bridgeStructure?: string;
  bridgeColour?: string;
  /** A boardwalk (bridge=boardwalk): planks laid on the ground, which its deck follows (see bridges.ts) */
  boardwalk?: boolean;
  /** The room over the way where it passes under a structure (maxheight:physical=*, else maxheight=*, m), when OSM tells */
  clearance?: number;
  /** Bridges: the room under the deck (min_height=*, m), when OSM tells */
  roomUnder?: number;
}

export type Sidewalks = "both" | "left" | "right" | "none" | "separate";

export interface Rail extends AsBuilt {
  osm: string;
  /** railway=* value */
  kind: string;
  layer: number;
  bridge: boolean;
  tunnel: boolean;
  line: Point[];
  /** The way trains usually go on one track of a double track (railway:preferred_direction=*): 1 along line, -1 against it */
  preferredDirection?: 1 | -1;
  /** Bridges: deck height (meters above sea level) at every point of line, when heights are known */
  deck?: number[];
  /** A tunnel in a cut in the elevation model: its lid's top (m above sea level) at every point of line */
  lid?: number[];
  /** A bridge's stretch over a tunnel's lid, which carries it */
  onLid?: boolean;
  /** Other tunnels and ramps to their portals: the floor (m above sea level) at every point of line, when known */
  floor?: number[];
  /** Other railways: the track bed (m above sea level) at every point of line, the ground smoothed along it */
  bed?: number[];
  /** The room over the way where it passes under a structure (maxheight:physical=*, else maxheight=*, m), when OSM tells */
  clearance?: number;
  /** Bridges: the room under the deck (min_height=*, m), when OSM tells */
  roomUnder?: number;
  /** In a map's tiles: what the way's surface lies on (profile.ts), its heights the field the kind names */
  profile?: ProfileKind;
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
  /** The estimated height comes from the building's type (HEIGHTS_BY_TYPE), which storeys would tell worse */
  heightByType?: boolean;
  /** The height is storeys times LEVEL_HEIGHT_M, which an old building's taller storeys may replace (ages.ts) */
  heightFromLevels?: boolean;
  /** Meters above the ground to the bottom (e.g. a part over a passage) */
  minHeight: number;
  /** Meters above sea level that height and minHeight count from (see setBuildingBases); unset without elevations */
  base?: number;
  /** Meters above sea level of the lowest ground along its outline and holes, which its walls reach down to */
  low?: number;
  /** Storeys in the walls, from minHeight to the eaves, when OSM or a building register has them */
  levels?: number;
  /** Storeys in the roof (roof:levels), when OSM has any: an attic's, whose low knee walls may be in the walls */
  roofLevels?: number;
  /** Its main use in the building register */
  use?: BuildingUse;
  /** The year it was built, when known: start_date naming a year, or a building register's completion year that it allows */
  year?: number;
  /** start_date as tagged (see startDates.ts), also when it names no single year ("C20", "1890s") */
  startDate?: string;
  /** How the walls' windows are drawn (see WindowStyle); no windows when unset */
  windows?: WindowStyle;
  /** Tagged as no ordinary building (see isSpecial): a tower, a chimney, a church, a monument, ... */
  special?: boolean;
  /** amenity=place_of_worship, which makes it special: a parish's block of flats may be one too (windows.ts) */
  worship?: boolean;
  /** A pitched roof (see RoofShape); no shape is a flat roof */
  roofShape?: RoofShape;
  /** OSM has no roof:shape: the shape is a guess, or flat by default */
  roofShapeEstimated?: boolean;
  /** roof:shape=gambrel: gabled until its height is known, then drawn by its faces (taggedGambrels, gambrelRoofs.ts) */
  roofGambrel?: boolean;
  /** Meters from the eaves to the top of the roof (included in height) */
  roofHeight?: number;
  /** A pitched roof's height is a guess (no roof:height or roof:levels) */
  roofHeightEstimated?: boolean;
  /**
   * Degrees counter-clockwise from east: the ridge's direction, or for a skillion roof the direction
   * it slopes down to
   */
  roofAngle?: number;
  /** A roof drawn from its ridge lines (roof:ridge=yes ways, see roofRidges.ts), instead of roofShape */
  roofFaces?: RoofFaces;
  /** Steps (building:part=steps): how many (step_count=*), when OSM tells; they climb against a skillion roof's slope */
  stepCount?: number;
  /** Wall colour: building:colour or colour */
  colour?: string;
  roofColour?: string;
  /** roof:material (roof_tiles, metal, copper, glass, grass, ...), when OSM tells */
  roofMaterial?: string;
  /** Wall material: building:material or material, or the building register's facade */
  material?: string;
  /** The material is a guess (brick for an untagged chimney), which a building register's facade replaces */
  materialEstimated?: boolean;
  /** The load-bearing frame's material in the building register (wood | brick | concrete | steel) */
  frameMaterial?: string;
  /**
   * An open structure, a roof on posts: "public_transport" for a bus or tram stop shelter, another
   * shelter_type (gazebo, ...) or "shelter" for other shelters, "roof" for building=roof (canopies), "carport" for building=carport
   */
  shelter?: string;
  /** A framework of bars, not a closed body (tower:construction=lattice or guyed_lattice) */
  lattice?: boolean;
  /** Walls without windows (window=no or windows=no) */
  windowless?: boolean;
  name?: string;
  /** Its street address (addr:street, else addr:place, and addr:housenumber as tagged: "4", "4 B", "4-6", "4;6") */
  address?: Address;
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

/** A street address: the street (or the place) and the house number */
export interface Address {
  street: string;
  number: string;
}

/** A door at a point on a building's outline */
export interface Entrance {
  at: Point;
  /** entrance=* value (main, staircase, shop, service, yes, ...) */
  kind: string;
  /** Its staircase's letter or number (ref=*), as on a plaque over the door */
  ref?: string;
  /** Its own house number (addr:housenumber), where it has one */
  housenumber?: string;
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
   * Where the opening does not start at the building's base (a door up a slope into a stair hall, a passage up a
   * slope, a way on a deck): the ground there (m above sea level), which its height counts from
   */
  ground?: number;
}

/**
 * The room of a way through a building, so its wall openings do not show the hollow inside: walls along
 * the way's sides and a ceiling at height meters over the quadrilaterals between consecutive sections.
 */
export interface PassageRoom {
  /** Across the way, in order along it: where it comes in, its corners, where it goes out; [left, right] */
  sections: [Point, Point][];
  height: number;
  /** Whether the way ends inside the building at its first or last section, so a wall closes the room there */
  closed: [boolean, boolean];
  /** The room's walls, each with the room on its right (solid side left), less where in another room */
  walls: [Point, Point][];
  /**
   * Where the way runs on a deck through the building, or up a slope over its base: the deck's or the ground's
   * highest along the room (m above sea level), which height counts from
   */
  ground?: number;
  /** Where that slopes along the room: each section's (m above sea level), the ceiling height over each */
  grounds?: number[];
}

export type AreaKind = "water" | "grass" | "forest" | "field" | "sand" | "rock" | "pitch" | "paved" | "platform";

export interface Area {
  osm: string;
  kind: AreaKind;
  /** What grows there: woods get trees and scrub shrubs (see forests.ts) */
  cover?: "trees" | "shrubs";
  /** Woods of conifers or of broadleaved trees alone (leaf_type); unset in mixed woods and where not known */
  leafType?: "needleleaved" | "broadleaved";
  /** A platform's top, or a level pitch's or paved area's ground, meters above sea level (see platforms.ts, pitches.ts) */
  top?: number;
  /** A tram stop's platform rising with the tramway beside it: its top (m above sea level) at the two ends of its long
   * side's middle line, and along that line between them, level across; top is the lower one (see platforms.ts) */
  slope?: { ends: [Point, Point]; tops: [number, number] };
  /** surface=* (artificial_turf, sand, asphalt, paving_stones, ...), when OSM tells */
  surface?: string;
  /** Water that flows: a river, canal or stream mapped as an area, not a lake or pond */
  flowing?: boolean;
  /** A car park in the open: amenity=parking on the ground, not under it, in a parking garage or on a roof */
  parking?: boolean;
  /** A road for vehicles drawn as an area: highway=* with area=yes, or area:highway=*, of a kind not for people alone */
  carriageway?: boolean;
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
  /** Meters across the crown (diameter_crown), when known */
  crown?: number;
  /** A tree on a bridge: the deck's height (m above sea level) it stands on */
  base?: number;
}

/** A bridge's outline (man_made=bridge): the whole deck, of which OSM's ways on the bridge are lines */
export interface BridgeOutline {
  osm: string;
  name?: string;
  /** bridge:structure=* and colour=*, when OSM tells */
  structure?: string;
  colour?: string;
  polygon: Polygon;
}

/**
 * A piece of a bridge's deck: its outline cut across the bridge into short pieces (see decks.ts), as
 * triangles with the height of the deck's top at their corners
 */
export interface BridgeDeck {
  osm: string;
  name?: string;
  /** Its bridge's bridge:structure=* and colour=*, when OSM tells */
  structure?: string;
  colour?: string;
  /** Meters east and north of the origin */
  vertices: Point[];
  /** Three vertex numbers (from 0) each */
  triangles: number[];
  /** The deck's top (m above sea level) at each vertex */
  heights: number[];
}

/**
 * How a street lamp is held up: on a straight pole (the light on top), on a pole with an arm reaching
 * out, on a pole bent over at its top (a swan neck, the light hanging from it), on a high mast (squares,
 * junctions), on a tram or railway catenary mast (with an arm), on a wall, or hung from a wire
 */
export type LampMount = "straight" | "angled" | "bent" | "high" | "catenary" | "wall" | "wire";

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
  /** light:shape=* in lower case (spherical, cylindrical, directed), when known */
  shape?: string;
  /** Its mast's structure=* in lower case (lattice, tubular, ...), when known */
  structure?: string;
  /** colour=* as OSM has it (a name or #rrggbb), when known */
  colour?: string;
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
  /** Usually locked (locked=yes): closed */
  locked?: true;
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
  /** material=* in lower case when fence_type stands in `material` (a railing of cast_iron or steel) */
  madeOf?: string;
  /** colour=* as tagged (#rrggbb or a name) */
  colour?: string;
  /** wall=parapet: a wall along a bridge's edge, standing on its deck */
  parapet?: boolean;
  /** layer=* when over 0: on a bridge, over the ways under it */
  layer?: number;
  /** design=* in lower case: a railing's pattern (rosette, ...), when known */
  design?: string;
  /** A railing's stretch on a bridge's deck (see barriers.ts): not on the ground, the look of the bridge's railing */
  onDeck?: boolean;
  /** Cut open where ways cross it and at its gates (see barriers.ts) */
  line: Point[];
}

/** A piece of playground equipment (playground=*): a swing, a slide, a sandpit, a climbing frame, ... */
export interface PlayEquipment {
  osm: string;
  /** playground=* value in lower case: swing, basketswing, slide, sandpit, climbingframe, springy, structure, ... */
  kind: string;
  /** Meters east and north of the origin: the node, the middle of the way's line or of its outline's box */
  point: Point;
  /**
   * Degrees counter-clockwise from east: the way it runs (a swing's beam, a slide's run), from its way's line or
   * outline, a row of its kind or the edge of the playground it is in (see playgrounds.ts); unset when nothing tells
   */
  along?: number;
  /** A way's meters along `along` and across it */
  length?: number;
  width?: number;
  /** A closed way's outline, counter-clockwise */
  outline?: Ring;
  /** Seats (capacity=*), when OSM tells */
  capacity?: number;
  /** A swing with a seat for babies (baby=yes), or without (baby=no), when OSM tells */
  baby?: boolean;
  /** material=* in lower case (wood, metal, rope, plastic, ...), when known */
  material?: string;
  /** Meters, when OSM tells */
  height?: number;
  /** playground:theme=* in lower case (ship, train, whale, ...), when known */
  theme?: string;
  /** On a bridge: the deck's height there, meters above sea level */
  base?: number;
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
  playEquipment: PlayEquipment[];
  bridgeDecks: BridgeDeck[];
  /** The landmarks of a query of their own (landmarks.ts), when it was had */
  seamarks?: Seamark[];
  landmarks?: Landmark[];
  piers?: Pier[];
  dams?: Dam[];
  rides?: Ride[];
  powerLines?: PowerLine[];
  pistes?: Piste[];
  /** Bicycle parking, of a query of its own (bicycleParking.ts), when it was had */
  bicycleParkings?: BicycleParking[];
  /** Pitches outdoors mapped as rectangles (pitches.ts) */
  pitches?: Pitch[];
}

/**
 * Area tags and the kind they map to, most important first: an element matching several rules gets
 * the first one. "*" matches any value.
 */
const AREA_RULES: [key: string, values: Record<string, AreaKind>][] = [
  ["railway", { platform: "platform" }],
  ["natural", { water: "water" }],
  ["waterway", { riverbank: "water" }],
  ["landuse", { reservoir: "water", basin: "water" }],
  ["amenity", { parking: "paved" }],
  ["place", { square: "paved" }],
  ["area:highway", { "*": "paved" }],
  ["leisure", { pitch: "pitch", playground: "sand", park: "grass", garden: "grass", golf_course: "grass" }],
  ["natural", { sand: "sand", beach: "sand", shingle: "rock", bare_rock: "rock", scree: "rock" }],
  ["natural", { wood: "forest", scrub: "forest", grassland: "grass", heath: "grass", wetland: "grass" }],
  ["landuse", { forest: "forest" }],
  ["landuse", { grass: "grass", meadow: "grass", village_green: "grass", flowerbed: "grass", allotments: "grass", cemetery: "grass", orchard: "grass" }],
  ["landuse", { farmland: "field" }],
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
  // indoors wherever it is tagged
  corridor: 3,
};

export const LANE_WIDTH_M = 3.25;

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
/** tower:construction values for a framework of bars */
const LATTICES = new Set(["lattice", "guyed_lattice"]);
/**
 * Guessed height of an untagged structure (man_made=*, else building=*) or church: perWidth times its base's
 * longest side, at most max meters. Fitted to tagged heights in OSM, a chimney's measured in Tampere.
 */
const HEIGHTS_BY_TYPE = new Map<string, { perWidth: number; max: number }>([
  ["chimney", FINNISH_DEFAULTS_MEASURED_IN_TAMPERE.chimneyHeight],
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

/** How tall a passage through a building is when its way has no maxheight: for vehicles, and for people */
export const PASSAGE_HEIGHT_M = 4;
export const WALKWAY_PASSAGE_HEIGHT_M = 3;
/** Ways indoors are kept this far on from a tunnel's end (m) */
const INDOOR_REACH_M = 30;
/** The passage of a way indoors out of a tunnel starts this far on from the tunnel's end (m) */
const OUT_OF_TUNNEL_M = 1;
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
export const GUESS_MIN_FILL = 0.85;
/** Slope of a pitched roof whose height is not tagged */
const ROOF_PITCH = (27 * Math.PI) / 180;
const SKILLION_PITCH = (10 * Math.PI) / 180;
const MAX_GUESSED_ROOF_M = 6;
/** roof:direction compass points */
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

/** Storeys of a building without height or levels, guessed from its type and floor area (m²) */
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
  const selectors = ["way[highway]", "way[railway]", "way[building]", "way[\"building:part\"]", "way[amenity=shelter][shelter_type=public_transport]", "node[natural~\"^(tree|shrub)$\"]", "way[natural=tree_row]", "node[highway=street_lamp]",
    "node[highway~\"^(crossing|traffic_signals)$\"]", "node[barrier=gate]", "way[barrier~\"^(fence|wall|retaining_wall|hedge)$\"]", "way[man_made=bridge]", `way[man_made~"^(${[...STRUCTURES].join("|")})$"]`, "way[\"roof:ridge\"=yes]"];
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

export type OsmElement =
  | { type: "node"; id: number; tags?: Tags; lat?: number; lon?: number }
  | { type: "way"; id: number; tags?: Tags; geometry?: LatLon[]; center?: LatLon }
  | { type: "relation"; id: number; tags?: Tags; members?: { type: string; role: string; geometry?: LatLon[]; lat?: number; lon?: number }[]; center?: LatLon };

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
      const members = items(field(item, "members")).map((member) => {
        // a node member's point, with "out geom"
        const point = parseLatLon(member);
        return {
          type: String(field(member, "type")),
          role: String(field(member, "role") ?? ""),
          geometry: parseGeometry(field(member, "geometry")),
          ...(point && { lat: point.lat, lon: point.lon }),
        };
      });
      elements.push({ type, id, tags, members, ...(center && { center }) });
    }
  }
  return {
    osm3s: { timestamp_osm_base: optionalString(field(value, "osm3s", "timestamp_osm_base")) },
    remark: optionalString(field(value, "remark")),
    elements,
  };
}

/**
 * The elements reaching into the box, whole: a node in it, a way or relation whose points' box meets it (or whose
 * centre is in it, without geometry); one without a place is kept, and the tunnels' ways wherever they are, whose
 * networks' floors are worked out from end to end.
 */
export function elementsWithin(elements: OsmElement[], box: GeoBox): OsmElement[] {
  return elements.filter((element) => {
    if (element.type === "way" && layering(element.tags ?? {}).tunnel) {
      return true;
    }
    const points: LatLon[] =
      element.type === "node"
        ? element.lat === undefined || element.lon === undefined ? [] : [{ lat: element.lat, lon: element.lon }]
        : element.type === "way"
          ? element.geometry ?? []
          : (element.members ?? []).flatMap((m) => m.geometry ?? (m.lat === undefined || m.lon === undefined ? [] : [{ lat: m.lat, lon: m.lon }]));
    const placed = points.length > 0 ? points : element.type !== "node" && element.center ? [element.center] : [];
    if (placed.length === 0) {
      return true;
    }
    let [south, west, north, east] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const { lat, lon } of placed) {
      [south, west, north, east] = [Math.min(south, lat), Math.min(west, lon), Math.max(north, lat), Math.max(east, lon)];
    }
    return north >= box.south && south <= box.north && east >= box.west && west <= box.east;
  });
}

const TYPE_ORDER = { node: 0, way: 1, relation: 2 };

/**
 * The responses to a query asked of pieces of an area as one response to it over the whole: each element once, in
 * Overpass' order (nodes, ways, relations, each by id), and the oldest piece's timestamp.
 */
export function mergeOverpass(responses: OverpassResponse[]): OverpassResponse {
  if (responses.length === 1) {
    return responses[0];
  }
  const elements = new Map<string, OsmElement>();
  for (const response of responses) {
    for (const element of response.elements) {
      const key = `${element.type}/${element.id}`;
      if (!elements.has(key)) {
        elements.set(key, element);
      }
    }
  }
  const timestamps = responses.flatMap((r) => (r.osm3s?.timestamp_osm_base === undefined ? [] : [r.osm3s.timestamp_osm_base])).sort();
  return {
    ...(timestamps.length > 0 && { osm3s: { timestamp_osm_base: timestamps[0] } }),
    elements: [...elements.values()].sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.id - b.id),
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
  /** Playgrounds' outlines (leisure=playground), which their equipment lines up with (playgrounds.ts) */
  playgrounds: Polygon[];
  /** Pitches' outlines (leisure=pitch), still to get their boxes (pitches.ts) */
  pitches: PitchOutline[];
  /** Problems worth reporting, such as multipolygons with rings that do not close */
  warnings: string[];
  /** The storeys (level=*) of the roads and rails that OSM tells them for, to tell where tunnels come out */
  levels: Map<Road | Rail, number[]>;
  /** Whether a point is an end of a way indoors left out: a bridge ending there goes into a building (see setBridgeDecks) */
  indoors: (p: Point) => boolean;
  /** The roof lines along roofs' ridges (roof:ridge=yes), still to shape their roofs (roofRidges.ts) */
  ridges: Point[][];
  /** The passages still to open in the buildings (passages.ts): the building passages tagged so, and the ways indoors kept out of tunnels */
  passages: Passage[];
  /** The building passages tagged so, for those that stop short of their building's wall */
  tagged: { road: Road; passage: Passage }[];
  /** Tunnels and covered ways (arcades too) that may be passages through buildings tagged otherwise */
  maybePassages: { road: Road; passage: Passage; arcade: boolean }[];
  /** The ends of ways indoors under the ground that go on in a tunnel down into a basement (pointKey) */
  basements: ReadonlySet<string>;
  /** Covered ways (covered=yes) on the ground, of which those that are no passages may come in at a door */
  covered: Road[];
  /** The building passages tagged so */
  through: Set<Road>;
}

/** A way's surface=*; steps tagged only with what they are made of (material=*) are of that */
function surfaceOf(tags: Record<string, string>): { surface?: string } {
  const surface = tags.surface ?? (tags.highway === "steps" ? tags.material : undefined);
  return surface ? { surface } : {};
}

/** Steps' count (step_count=*, a whole number) and which way they climb (incline=up / down, or a slope's sign) */
function stepping(tags: Record<string, string>): { stepCount?: number; incline?: "up" | "down" } {
  const count = /^[0-9]+$/.test(tags.step_count ?? "") ? Number(tags.step_count) : undefined;
  const slope = Number.parseFloat(tags.incline ?? "");
  const incline = tags.incline === "up" || slope > 0 ? "up" : tags.incline === "down" || slope < 0 ? "down" : undefined;
  return { ...(count !== undefined && count > 0 && { stepCount: count }), ...(incline && { incline }) };
}

/** Turns Overpass elements into features in meters east / north of origin. */
export function parseOsm(elements: OsmElement[], origin: GeoPoint): ParseResult {
  const warnings: string[] = [];
  const projection = new LocalProjection(origin);
  const toPoint = (p: LatLon): Point => projection.toMeters({ latitude: p.lat, longitude: p.lon });
  const features: MapFeatures = { roads: [], rails: [], buildings: [], areas: [], trees: [], lamps: [], crossings: [], signals: [], gates: [], barriers: [], playEquipment: [], bridgeDecks: [] };
  const streetNodes: StreetNode[] = [];
  const bridgeOutlines: BridgeOutline[] = [];
  const playgrounds: Polygon[] = [];
  const pitches: PitchOutline[] = [];
  const passages: Passage[] = [];
  // tunnels and covered ways (arcades too) that may be passages through buildings tagged otherwise
  const maybePassages: { road: Road; passage: Passage; arcade: boolean }[] = [];
  // the building passages tagged so, for those that stop short of their building's wall (passagesOnToWalls)
  const tagged: { road: Road; passage: Passage }[] = [];
  const covered: Road[] = [];
  const levels = new Map<Road | Rail, number[]>();
  // the roads through buildings: building passages, and tunnels and covered ways found to be
  const through = new Set<Road>();
  // ways indoors, kept where they come out of a tunnel's end (the stairs up out of an underpass)
  const indoors: Road[] = [];
  // roof lines along roofs' ridges (roofRidges.ts)
  const ridges: Point[][] = [];

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
      // a closed way as a line goes back to its start: the outline's points leave the closing one out
      const line = closed && points.length >= 3 ? [...points, points[0]] : points;
      // a road under construction is drawn as the road it will be: it is mostly there, and in use between works
      const road = tags.highway === "construction" && tags.construction ? { ...tags, highway: tags.construction } : tags;
      if (road.highway && closed && road.area === "yes") {
        // a square or a plaza drawn as an area, not a line
        addArea(features, osm, "paved", polygon(), { surface: road.surface, carriageway: forVehicles(road.highway) });
      } else if (road.highway && ROAD_WIDTHS[road.highway] !== undefined) {
        const width = roadWidth(road);
        const walkway = WALKWAYS.has(road.highway);
        const osmWidth = (meters(road.width) ?? meters(road["est_width"]) ?? 0) > 0;
        const way: Road = {
          osm,
          kind: road.highway,
          width,
          ...(osmWidth && { widthTagged: true as const }),
          ...layering(road),
          ...optionalName(road),
          ...oneway(road),
          ...(walkway ? (road.footway ? { footway: road.footway } : {}) : { ...sidewalks(road), ...motorAccess(road), ...maxHeight(road), ...lanesOf(road) }),
          ...access(road),
          ...(road.highway === "steps" ? stepping(road) : {}),
          ...surfaceOf(road),
          ...bridgeLooks(road),
          ...clearances(road),
          line,
        };
        const storeys = storeysOf(road);
        if (storeys) {
          levels.set(way, storeys);
        }
        if (road.indoor === "yes" || road.highway === "corridor") {
          indoors.push(way);
        } else {
          features.roads.push(way);
          const passage = { line, width, height: meters(road.maxheight) ?? (walkway ? WALKWAY_PASSAGE_HEIGHT_M : PASSAGE_HEIGHT_M) };
          if (road.tunnel === "building_passage") {
            passages.push(passage);
            tagged.push({ road: way, passage });
            through.add(way);
          } else if ((inTunnel(way) || road.covered === "yes" || road.covered === "arcade") && way.layer >= -1) {
            maybePassages.push({ road: way, passage, arcade: road.covered === "arcade" });
            if (road.covered === "yes" && !inTunnel(way)) {
              covered.push(way);
            }
          }
        }
      }
      if (tags.railway && RAIL_KINDS.has(tags.railway)) {
        const rail: Rail = { osm, kind: tags.railway, ...layering(tags), line, ...preferredDirection(tags), ...clearances(tags) };
        const storeys = storeysOf(tags);
        if (storeys) {
          levels.set(rail, storeys);
        }
        features.rails.push(rail);
      }
      if (tags.natural === "tree_row") {
        // a closed row's last tree would stand on its first
        const row = alongLine(line, TREE_ROW_SPACING_M);
        features.trees.push(...(line === points ? row : row.slice(1)).map((point) => tree(tags, point)));
      }
      if (tags["roof:ridge"] === "yes") {
        ridges.push(line);
      }
      const kind = BARRIER_KINDS.get(tags.barrier ?? "");
      if (kind) {
        features.barriers.push(barrier(osm, kind, tags, line));
      }
      if (closed && points.length >= 3) {
        addPolygonFeature(features, bridgeOutlines, playgrounds, pitches, osm, tags, polygon());
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
        addPolygonFeature(features, bridgeOutlines, playgrounds, pitches, osm, tags, polygon);
      }
    }
  }

  // ways indoors are left out, except up to INDOOR_REACH_M on from a tunnel's end (how an underpass comes
  // out through a building): they become passages, starting OUT_OF_TUNNEL_M on so the wall stays whole
  // where they come up from under the ground. Those on storeys under the ground out of a tunnel on no storey (a
  // ramp down into a basement) go on in the tunnel, and so do the ways on from them; out of a tunnel on a storey
  // they go on at its level into a building and up in it. Out of a basement, a way only on storeys over it goes on
  // from a lift, which OSM does not have: it is left out too.
  const belowGround = (r: Road) => (levels.get(r) ?? [0]).every((storey) => storey < 0);
  const overGround = (r: Road) => (levels.get(r) ?? [0]).every((storey) => storey >= 0);
  const reached = new Map<string, number>();
  // the points from which ways indoors under the ground go on under it, and the ends of those that do
  const under = new Set<string>();
  const basements = new Set<string>();
  for (const r of features.roads.filter(inTunnel)) {
    for (const p of [r.line[0], r.line[r.line.length - 1]]) {
      reached.set(pointKey(p), 0);
      if (!levels.has(r)) {
        under.add(pointKey(p));
      }
    }
  }
  const kept = new Set<Road>();
  for (let grown = true; grown; ) {
    grown = false;
    for (const r of indoors) {
      const ends = [r.line[0], r.line[r.line.length - 1]].map(pointKey);
      const from = Math.min(...ends.map((k) => reached.get(k) ?? Infinity));
      if (kept.has(r) || from >= INDOOR_REACH_M || (overGround(r) && ends.some((k) => basements.has(k)))) {
        continue;
      }
      kept.add(r);
      grown = true;
      const to = from + r.line.slice(1).reduce((sum, q, i) => sum + Math.hypot(q[0] - r.line[i][0], q[1] - r.line[i][1]), 0);
      for (const k of ends) {
        reached.set(k, Math.min(reached.get(k) ?? Infinity, to));
      }
      features.roads.push(r);
      if (belowGround(r) && ends.some((k) => under.has(k))) {
        r.tunnel = true;
        for (const k of ends) {
          under.add(k);
          basements.add(k);
        }
        continue;
      }
      const height = WALKWAYS.has(r.kind) ? WALKWAY_PASSAGE_HEIGHT_M : PASSAGE_HEIGHT_M;
      const outward = reached.get(ends[1]) === 0 && reached.get(ends[0]) !== 0 ? [...r.line].reverse() : r.line;
      const line = from === 0 ? withoutStart(outward, OUT_OF_TUNNEL_M) : outward;
      if (line.length >= 2) {
        passages.push({ line, width: r.width, height });
      }
    }
  }

  const indoorEnds = new Set(indoors.filter((r) => !kept.has(r)).flatMap((r) => [pointKey(r.line[0]), pointKey(r.line[r.line.length - 1])]));

  return {
    features,
    streetNodes,
    bridgeOutlines,
    playgrounds,
    pitches,
    warnings,
    levels,
    indoors: (p) => indoorEnds.has(pointKey(p)),
    ridges,
    passages,
    tagged,
    maybePassages,
    basements,
    covered,
    through,
  };
}

/** A pitch's sports (sport=*, a list), surface and whether it is indoors or covered */
function pitchOutline(osm: string, tags: Tags, polygon: Polygon): PitchOutline {
  const sports = (tags.sport ?? "")
    .toLowerCase()
    .split(";")
    .map((sport) => sport.trim())
    .filter((sport) => sport !== "");
  const indoor = (tags.indoor !== undefined && tags.indoor !== "no") || tags.covered === "yes" || tags.location === "indoor" || tags.location === "underground";
  return { osm, sports, ...(tags.surface && { surface: tags.surface }), indoor, polygon };
}

function addPolygonFeature(features: MapFeatures, bridgeOutlines: BridgeOutline[], playgrounds: Polygon[], pitches: PitchOutline[], osm: string, tags: Tags, polygon: Polygon): void {
  if (tags.leisure === "playground") {
    playgrounds.push(polygon);
  }
  if (tags.leisure === "pitch") {
    pitches.push(pitchOutline(osm, tags, polygon));
  }
  if (tags.man_made === "bridge") {
    const { bridgeStructure, bridgeColour } = bridgeLooks({ ...tags, bridge: "yes" });
    bridgeOutlines.push({ osm, ...optionalName(tags), ...(bridgeStructure && { structure: bridgeStructure }), ...(bridgeColour && { colour: bridgeColour }), polygon });
    return;
  }
  // a building under construction is drawn as the building it will be, as a road is
  const buildingTag = tags.building === "construction" && tags.construction ? tags.construction : tags.building;
  const buildingKind = buildingTag && buildingTag !== "no" ? buildingTag : undefined;
  const partKind = tags["building:part"] && tags["building:part"] !== "no" ? tags["building:part"] : undefined;
  // many chimneys, tanks and towers are mapped as man_made=* alone, and stop shelters as amenity=shelter alone: an
  // open roof
  const structure = tags.man_made !== undefined && STRUCTURES.has(tags.man_made) ? tags.man_made : undefined;
  const stopShelter = tags.amenity === "shelter" && tags.shelter_type === "public_transport" && tags.building !== "no" ? "roof" : undefined;
  const buildingOrPart = partKind ?? buildingKind ?? structure ?? stopShelter;
  if (buildingOrPart) {
    if (!underground(tags)) {
      features.buildings.push(building(osm, tags, buildingOrPart, partKind !== undefined, polygon));
    }
    return;
  }
  const tagged = areaKind(tags);
  // a river's bed that is dry most of the time is its stones
  const kind = tagged === "water" && flowingWater(tags) && tags.intermittent === "yes" ? "rock" : tagged;
  if (kind) {
    addArea(features, osm, kind, polygon, {
      cover: areaCover(tags),
      leafType: woodsLeafType(tags),
      surface: tags.surface,
      flowing: kind === "water" && flowingWater(tags),
      parking: kind === "paved" && openParking(tags),
      carriageway: kind === "paved" && forVehicles(tags["area:highway"]),
    });
  }
}

function addArea(features: MapFeatures, osm: string, kind: AreaKind, polygon: Polygon, extra: Pick<Area, "cover" | "leafType" | "surface" | "flowing" | "parking" | "carriageway"> = {}): void {
  const { cover, leafType, surface, flowing, parking, carriageway } = extra;
  features.areas.push({
    osm,
    kind,
    ...(cover && { cover }),
    ...(leafType && { leafType }),
    ...(surface && { surface }),
    ...(flowing && { flowing }),
    ...(parking && { parking }),
    ...(carriageway && { carriageway }),
    polygon,
  });
}

/** Whether highway=* is a road for vehicles, not a way for people alone, a traffic island or a platform */
function forVehicles(highway: string | undefined): boolean {
  return highway !== undefined && ROAD_WIDTHS[highway] !== undefined && !WALKWAYS.has(highway);
}

const PARKING_OFF_THE_GROUND = new Set(["underground", "multi-storey", "rooftop"]);

/** A car park in the open: amenity=parking not under the ground, in a parking garage or on a roof */
function openParking(tags: Tags): boolean {
  const layer = number(tags.layer);
  return (
    tags.amenity === "parking" &&
    !PARKING_OFF_THE_GROUND.has(tags.parking ?? "") &&
    tags.location !== "underground" &&
    tags.location !== "rooftop" &&
    !(layer !== undefined && layer < 0)
  );
}

const FLOWING_WATERS = new Set(["river", "canal", "stream", "rapids", "ditch", "drain", "fish_pass", "lock"]);

/** A river, canal or stream mapped as an area (water=*, or waterway=* on the area) */
function flowingWater(tags: Tags): boolean {
  return tags.waterway === "riverbank" || FLOWING_WATERS.has(tags.water ?? "") || FLOWING_WATERS.has(tags.waterway ?? "");
}

/** What grows in an area: trees in woods, shrubs in scrub */
function areaCover(tags: Tags): Area["cover"] {
  if (tags.natural === "wood" || tags.landuse === "forest") {
    return "trees";
  }
  return tags.natural === "scrub" ? "shrubs" : undefined;
}

/** Woods of conifers or of broadleaved trees alone; none for mixed or untagged woods, or other areas */
function woodsLeafType(tags: Tags): Area["leafType"] {
  const leafType = tags.leaf_type;
  return areaCover(tags) === "trees" && (leafType === "needleleaved" || leafType === "broadleaved") ? leafType : undefined;
}

/** A natural=tree or natural=shrub node, or a tree of a natural=tree_row */
function tree(tags: Tags, point: Point): Tree {
  const kind: TreeKind = tags.natural === "shrub" ? "shrub" : tags.leaf_type === "needleleaved" ? "conifer" : "broadleaved";
  const genus = (tags.genus ?? tags.species)?.split(/\s+/)[0]?.toLowerCase();
  const height = meters(tags.height);
  const trunk = meters(tags.circumference);
  const crown = meters(tags.diameter_crown);
  return {
    point,
    kind,
    height: height !== undefined && height > 0 ? height : DEFAULT_TREE_HEIGHTS[kind],
    ...(genus && { genus }),
    ...(kind !== "shrub" && trunk !== undefined && trunk > 0 && { trunk }),
    ...(crown !== undefined && crown > 0 && { crown }),
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
  ["bent_mast", "bent"],
]);
/** Heights of street lamps whose height OSM does not have, until lamps.ts looks at the street */
export const DEFAULT_LAMP_HEIGHTS: Record<LampMount | "unknown", number> = {
  straight: 5,
  angled: 8,
  bent: 5,
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
  const shape = tags["light:shape"]?.trim().toLowerCase();
  const structure = tags.structure?.trim().toLowerCase();
  const colour = tags.colour?.trim();
  return {
    point,
    ...(height !== undefined && height > 0 ? { height } : { height: DEFAULT_LAMP_HEIGHTS[mount ?? "unknown"], heightEstimated: true }),
    ...(mount && { mount }),
    // direction is clockwise from north
    ...(direction !== undefined && { toward: (((90 - direction) % 360) + 360) % 360 }),
    ...(lampType && { lampType }),
    ...(shape && { shape }),
    ...(structure && { structure }),
    ...(colour && { colour }),
  };
}

/** A crossing, traffic signal or gate node as OSM has it, before streets.ts puts it on its way */
export type StreetNode =
  | { kind: "crossing"; point: Point }
  | { kind: "signal"; point: Point; direction?: TrafficSignal["direction"] }
  | { kind: "gate"; point: Point; width?: number; locked?: true };

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
    return { kind: "gate", point, ...(width !== undefined && width > 0 && { width }), ...(tags.locked === "yes" && { locked: true as const }) };
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
  const madeOf = tags.fence_type !== undefined ? tags.material?.trim().toLowerCase() : undefined;
  const colour = tags.colour?.trim();
  const design = tags.design?.trim().toLowerCase();
  const layer = Number(tags.layer);
  const height = meters(tags.height);
  const guess = material === "noise_barrier" ? NOISE_BARRIER_HEIGHT_M : DEFAULT_BARRIER_HEIGHTS[kind];
  return {
    osm,
    kind,
    ...(height !== undefined && height > 0 ? { height } : { height: guess, heightEstimated: true }),
    ...(material && { material }),
    ...(madeOf && { madeOf }),
    ...(colour && { colour }),
    ...(tags.wall?.trim().toLowerCase() === "parapet" && { parapet: true }),
    ...(Number.isFinite(layer) && layer > 0 && { layer }),
    ...(design && { design }),
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
  const shelter = tags.amenity === "shelter" ? (tags.shelter_type ?? "shelter") : kind === "roof" || kind === "carport" ? kind : undefined;
  if (height === undefined && levelCount === undefined && shelter === "public_transport") {
    height = STOP_SHELTER_HEIGHT_M;
  }
  // levels say little about how tall an open roof is
  const heightEstimated = height === undefined && (levelCount === undefined || shelter !== undefined);
  const heightFromLevels = height === undefined && !heightEstimated;
  const chimney = tags.man_made === "chimney" || kind === "chimney";
  const structure = tags.man_made !== undefined && STRUCTURES.has(tags.man_made);
  // a building of another kind tagged as a tower is that building with its tower: as tall as its kind
  const ofType = structure && (tags.man_made !== "tower" || kind === "yes") ? (tags.man_made ?? kind) : kind;
  // a church's parts are its tower, nave, ... (a chimney part is a chimney)
  const byType = heightEstimated && (!part || chimney) ? HEIGHTS_BY_TYPE.get(ofType) : undefined;
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
  const startDate = tags.start_date?.trim() || undefined;
  const year = exactYear(startDate);
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
  const roofHeightEstimated = roof !== undefined && taggedRoofHeight === undefined && !roofLevels;
  const stepCount = kind === "steps" ? stepping(tags).stepCount : undefined;
  const colour = tags["building:colour"] ?? tags.colour;
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
    ...(roofLevels !== undefined && roofLevels >= 1 && { roofLevels: Math.round(roofLevels) }),
    ...(roof && { roofShape: roof.shape, roofAngle: roof.angle }),
    ...(roof && tags["roof:shape"] === "gambrel" && { roofGambrel: true }),
    ...(tags["roof:shape"] === undefined && { roofShapeEstimated: true }),
    ...(roofHeight !== undefined && { roofHeight }),
    ...(roofHeightEstimated && { roofHeightEstimated }),
    ...(stepCount !== undefined && { stepCount }),
    ...(colour && { colour }),
    ...(tags["roof:colour"] && { roofColour: tags["roof:colour"] }),
    ...(tags["roof:material"] && { roofMaterial: tags["roof:material"] }),
    ...wallMaterial(tags, chimney),
    ...(year !== undefined && { year }),
    ...(startDate !== undefined && { startDate }),
    ...(shelter && { shelter }),
    ...(LATTICES.has(tags["tower:construction"] ?? "") && { lattice: true }),
    ...((tags.window === "no" || tags.windows === "no") && { windowless: true }),
    ...(isSpecial(tags) && { special: true }),
    ...(tags.amenity === "place_of_worship" && { worship: true }),
    ...optionalName(tags),
    ...optionalAddress(tags),
    polygon,
  };
}

/** The street address tagged, with both a street (or a place) and a number */
function optionalAddress(tags: Tags): { address?: Address } {
  const street = (tags["addr:street"] ?? tags["addr:place"])?.trim();
  const number = tags["addr:housenumber"]?.trim();
  return street && number ? { address: { street, number } } : {};
}

/** A building's wall material: building:material or material, guessed for an untagged chimney */
function wallMaterial(tags: Tags, chimney: boolean): { material?: string; materialEstimated?: boolean } {
  const tagged = tags["building:material"] ?? tags.material;
  if (tagged) {
    return { material: tagged };
  }
  if (chimney) {
    return { material: FINNISH_DEFAULTS_MEASURED_IN_TAMPERE.chimneyMaterial, materialEstimated: true };
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
 * A building's pitched roof from roof:shape, or a guessed gabled roof for nearly rectangular houses and small
 * buildings. The ridge runs along the long side unless roof:orientation=across; a skillion slopes down to
 * roof:direction, else across. guessedHeight is the rise at ROOF_PITCH (SKILLION_PITCH), for when no height is tagged.
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
  // steps are often narrow, and their roof tells which way they climb
  if (shape === undefined || (box.width < 1 && kind !== "steps")) {
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
  return { shape, angle: roofDegrees(angle), guessedHeight: Math.min(rise, MAX_GUESSED_ROOF_M) };
}

/** A roof's angle in radians as Building.roofAngle: degrees, 0 .. 360, to a tenth */
export function roofDegrees(angle: number): number {
  const degrees = (((angle * 180) / Math.PI) % 360 + 360) % 360;
  return Math.round(degrees * 10) / 10;
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

/**
 * Whether a building or part is wholly under the ground: location=underground, or on a layer below 0 with its storeys
 * all below 0 or an underground car park in it (but for an open roof over its ramp)
 */
function underground(tags: Tags): boolean {
  if (tags.location === "underground") {
    return true;
  }
  if (layering(tags).layer >= 0) {
    return false;
  }
  const storeys = storeysOf(tags);
  if (storeys !== undefined) {
    return storeys.every((storey) => storey < 0);
  }
  return tags.parking === "underground" && tags.building !== "roof" && tags.building !== "carport";
}

/** A bridge way's bridge:structure=* and colour=*, when it is a bridge and OSM tells, and whether it is a boardwalk (not one in a tunnel) */
function bridgeLooks(tags: Tags): { bridgeStructure?: string; bridgeColour?: string; boardwalk?: boolean } {
  const { bridge, tunnel } = layering(tags);
  if (!bridge) {
    return {};
  }
  const structure = tags["bridge:structure"];
  return { ...(structure && { bridgeStructure: structure }), ...(tags.colour && { bridgeColour: tags.colour }), ...(tags.bridge === "boardwalk" && !tunnel && { boardwalk: true }) };
}

/** The room OSM tells over a way under a structure (maxheight:physical=*, else maxheight=*) and under a bridge's deck (min_height=*), in meters */
function clearances(tags: Tags): { clearance?: number; roomUnder?: number } {
  const clearance = meters(tags["maxheight:physical"]) ?? meters(tags.maxheight);
  const roomUnder = layering(tags).bridge ? meters(tags.min_height) : undefined;
  return { ...(clearance !== undefined && { clearance }), ...(roomUnder !== undefined && { roomUnder }) };
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

/** The way traffic usually goes on a track (railway:preferred_direction=*); unset when both ways */
function preferredDirection(tags: Tags): { preferredDirection?: 1 | -1 } {
  const value = tags["railway:preferred_direction"];
  return value === "forward" ? { preferredDirection: 1 } : value === "backward" ? { preferredDirection: -1 } : {};
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
 * (bus=*, else psv=*), its service=* and its bus bays (bus_bay=*)
 */
export function motorAccess(tags: Tags): { motorVehicle?: string; service?: string; bus?: string; busBay?: "left" | "right" | "both" } {
  const value = tags.motorcar ?? tags.motor_vehicle ?? tags.vehicle ?? tags.access;
  const bus = tags.bus ?? tags.psv;
  const bay = tags.bus_bay;
  return {
    ...(value && { motorVehicle: value }),
    ...(bus && { bus }),
    ...(tags.highway === "service" && tags.service && { service: tags.service }),
    ...((bay === "left" || bay === "right" || bay === "both") && { busBay: bay }),
  };
}

/** A road's lanes=*, when OSM tells a whole number of them */
function lanesOf(tags: Tags): { lanes?: number } {
  const lanes = number(tags.lanes);
  return lanes !== undefined && Number.isInteger(lanes) && lanes > 0 ? { lanes } : {};
}

/** A road's maxheight=* in meters, when OSM tells one */
function maxHeight(tags: Tags): { maxHeight?: number } {
  const height = meters(tags.maxheight);
  return height === undefined ? {} : { maxHeight: height };
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

/** The year of a start_date such as "1965", "1965-05-01", "1960s" or "1904..1920" (its first); undefined for "C19", "~1900", ... */

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
