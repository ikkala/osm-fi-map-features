// The stages that build the map's world from OpenStreetMap's features and the other sources, in the order MapBuilder
// runs them. Each takes what it builds on as its arguments and returns what later stages need (`after`, where a stage
// only has to follow another), so a stage cannot run before those it depends on: the ground stepped at walls before
// the tunnels' lids, the lids before the bridges' decks (the ways over them are bridges), the decks before the tunnels'
// floors under them, the portals' raised ground before the outlines' decks, the decks before the track beds, the lamps
// and the barriers on them, the building register before the buildings' looks and the doors guessed from their
// windows, the buildings' bases before their measured heights.
import { applyAges } from "./ages.ts";
import { applyRegister, BUILDING_REGISTER_ATTRIBUTION, fetchBuildingRegister } from "./buildingRegister.ts";
import { leaveOutOnDecks, openBarriers } from "./barriers.ts";
import { MAX_PLINTH_M, setBuildingBases } from "./bases.ts";
import { bareUnderBridges } from "./bareGround.ts";
import { DeckIndex } from "./deckIndex.ts";
import { inheritFromOutlines } from "./buildingParts.ts";
import { buildingSteps } from "./buildingSteps.ts";
import { setBridgeDecks } from "./bridges.ts";
import { setOutlineDecks, standOnDecks } from "./decks.ts";
import { bicycleParkingQuery, parseBicycleParking } from "./bicycleParking.ts";
import type { Logger } from "./builder.ts";
import { businessQuery, parseBusinesses, placeBusinesses } from "./businesses.ts";
import type { SourceCache } from "./cache.ts";
import { coverCutTunnels, fitLidsToDecks } from "./cuts.ts";
import { toTm35fin } from "./elevation.ts";
import { assignEntrances, entranceQuery, guessEntrances, parseEntrances } from "./entrances.ts";
import { flightSteps, stepAtFlights, type FlightStep } from "./flights.ts";
import { estimateCycling, estimateFootfall } from "./footfall.ts";
import { mergeTrees, moveTreesOffWays, plantForests } from "./forests.ts";
import type { Ground, HeightAt } from "./ground.ts";
import { taggedGambrels } from "./gambrelRoofs.ts";
import { pointKey, simplifyLine, type Point, type Polygon, type Rect } from "./geometry.ts";
import { placeLamps } from "./lamps.ts";
import { landmarkQuery, moveLandmarksOffWays, parseLandmarks } from "./landmarks.ts";
import { applyLaserShapes, type LaserRoofShape } from "./laserRoofShapes.ts";
import { fetchLaserRoofs, LASER_ATTRIBUTION } from "./laserScanning.ts";
import { splitByMeasuredParts } from "./measuredParts.ts";
import { fetchRoofColours, ORTHO_ATTRIBUTION } from "./ortho.ts";
import { LEVEL_HEIGHT_M, parseOsm, type Building, type GeoBox, type OsmElement, type OverpassResponse } from "./osm.ts";
import { openBuildings, openDoorways, openRailHalls, type ThroughBuildings } from "./passages.ts";
import { pitchBoxes, setLevelTops } from "./pitches.ts";
import { setPlatformTops } from "./platforms.ts";
import { parsePlayEquipment, placePlayEquipment, playgroundQuery } from "./playgrounds.ts";
import { inTunnel, isBridge } from "./profile.ts";
import type { GeoPoint } from "./projection.ts";
import { passagesUpSlopes, raisePassages } from "./raisedPassages.ts";
import { groundSteps, stepAtWalls, type GroundStep } from "./retainingWalls.ts";
import { withoutCourseWater } from "./rides.ts";
import { applyRoofTops, fetchRoofTops, measurable, type RoofTopSource } from "./roofTops.ts";
import { dropStepsInParts, setStaircaseDecks } from "./stairs.ts";
import { placeStreetNodes } from "./streets.ts";
import { setTrackBeds } from "./trackbeds.ts";
import { fetchTreeRegister, type RegisterTree, type TreeRegisterSource } from "./treeRegister.ts";
import { solveFloors, type KnownFloor } from "./floors.ts";
import type { SolveLp } from "./lp.ts";
import { fitRoomsUnderDecks, openPortals, portalWallsAt, raiseToWalls, rampsOut, setTunnelRooms, tunnelNetwork, uncoverAtGrade } from "./tunnels.ts";
import { leastDecks, lowerUnderBridges, tramBedCeiling } from "./underbridges.ts";
import { parseWaterways, setWaterLevels, waterwayQuery, type WaterLevels } from "./waterways.ts";
import { GRADE, isRoad, userOf, type Way } from "./ways.ts";
import { assignWindows } from "./windows.ts";
import { messageOf } from "./json.ts";

/** Roads and rails are simplified to this many meters */
const LINE_TOLERANCE_M = 0.3;

/** How the stages that fetch reach the sources: in the map's pieces, cached */
export interface Sources {
  cache: SourceCache;
  refresh: boolean;
  /** Maanmittauslaitos open interfaces' key, without which the stages that need it leave their work out */
  mmlApiKey: string | undefined;
  origin: GeoPoint;
  /** An Overpass query's response over the area, with the local edits of the OSM data applied */
  overpass(what: string, query: (box: GeoBox) => string, addNew?: boolean, report?: boolean): Promise<{ cached: boolean; response: OverpassResponse }>;
  /** A source's responses for the pieces of the area it covers */
  inPieces<T>(what: string, fetchPiece: (box: GeoBox) => Promise<{ cached: boolean } & T>, covers?: GeoBox): Promise<{ cached: boolean; pieces: T[] }>;
  /** The points within the part of the map being built */
  near<T extends GeoPoint>(points: T[]): T[];
  toMeters(latitude: number, longitude: number): Point;
  toGeo(point: Point): GeoPoint;
  /** The register entries of the pieces as from one request */
  uniques<T>(pieces: T[][]): T[];
}

/** The features parsed, the buildings opened for the ways through them, and the ways simplified */
export type OsmWorld = ReturnType<typeof parseOsm> & ThroughBuildings;

export function osmWorld(elements: OsmElement[], origin: GeoPoint, logger: Logger): OsmWorld {
  const parsed = parseOsm(elements, origin);
  const world = { ...parsed, ...openBuildings(parsed) };
  for (const warning of world.warnings) {
    logger.warn(`warning: ${warning}`);
  }
  const { features } = world;
  logger.log(`${dropStepsInParts(features.roads, features.buildings)} ways of steps inside steps mapped as building parts left out`);
  // simplify lines but keep the points other ways join at (tunnel networks are found by shared points)
  const ways = [...features.roads, ...features.rails];
  const uses = new Map<string, number>();
  for (const way of ways) {
    for (const k of new Set(way.line.map(pointKey))) {
      uses.set(k, (uses.get(k) ?? 0) + 1);
    }
  }
  const joined = (p: Point) => (uses.get(pointKey(p)) ?? 0) > 1;
  for (const way of ways) {
    way.line = simplifyLine(way.line, LINE_TOLERANCE_M, joined);
  }
  for (const barrier of features.barriers) {
    barrier.line = simplifyLine(barrier.line, LINE_TOLERANCE_M);
  }
  return world;
}

/** The bare ground under the bridges, where the elevation model has none (the ground's bare layer) */
export function bareStage(world: OsmWorld, ground: Ground, logger: Logger): void {
  const ways = [...world.features.roads, ...world.features.rails];
  ground.lay("bare", (below) => bareUnderBridges(ways, world.bridgeOutlines, below));
  logger.log(`${ways.filter(isBridge).length} bridge ways with the ground spanned across under them`);
}

/** The ground stepped at the retaining walls and at the edges flights of steps climb (its walls and flights layers) */
export interface SteppedGround {
  steps: GroundStep[];
  flights: FlightStep[];
  ground: Ground;
}

/** The model smooths retaining walls into slopes, and the edges flights of steps climb: the ground steps at them again */
export function steppedGround(world: OsmWorld, ground: Ground, logger: Logger): SteppedGround {
  const { features } = world;
  let steps: GroundStep[] = [];
  ground.lay("walls", (below) => {
    steps = groundSteps(features.barriers, below);
    return stepAtWalls(below, steps);
  });
  const stepping = steps.filter((s) => s.footOut > 0 || s.topIn > 0);
  logger.log(`${new Set(stepping.map((s) => s.wall)).size} retaining walls step the ground, in ${stepping.length} stretches`);
  let flights: FlightStep[] = [];
  ground.lay("flights", (below) => {
    flights = flightSteps(features.roads, below);
    return stepAtFlights(below, flights);
  });
  logger.log(`${flights.length} flights of steps step the ground the model smooths`);
  return { steps, flights, ground };
}

/** The tunnels with their floors, and the ground raised over their ends to their portals' walls (its portals layer) */
export interface Tunnelled {
  ground: Ground;
}

/**
 * The tunnels' rooms and floors, those in cuts under lids first (the ways over them become bridges), and their
 * portals into basements; the floors deep enough under the bridges' decks as those will be set
 */
/** The tunnels' rooms, those in cuts with lids (the ways over them bridges), and those at the ground under buildings */
export interface Covered {
  ground: Ground;
}

export function coverStage(world: OsmWorld, stepped: SteppedGround, logger: Logger): Covered {
  const { features } = world;
  const { ground } = stepped;
  const heightAt = ground.at("flights");
  logger.log(`${setTunnelRooms(features.roads)} tunnels get a lower room by their maxheight`);
  const covered = coverCutTunnels(features, heightAt);
  logger.log(`${covered.tunnels} tunnels in cuts get lids, ${covered.crossings} ways over them become bridges`);
  logger.log(`${uncoverAtGrade(features, heightAt)} tunnels run at the ground under buildings`);
  return { ground };
}

/** The bridges with their decks set */
export interface Spanned {
  ground: Ground;
}

/**
 * The bridges' decks, from end to end before the ways are cut into tiles, and the approaches raised to them: after
 * the lids (the ways over them are bridges) and before the tunnels' floors, which go under the decks, on the ground
 * before the portals' walls raise it, as the bare ground under the bridges has no hump to lift a tunnel's end into a
 * deck
 */
export function spanStage(world: OsmWorld, covered: Covered, logger: Logger): Spanned {
  const { features, indoors, throughBuildings } = world;
  const { ground } = covered;
  const heightAt = ground.at("flights");
  const ramps = (lines: Way[]) => lines.filter((l) => l.deck && !isBridge(l)).length;
  // the room OSM tells under the decks: they rise for it at their ways' grade
  const least = leastDecks([...features.roads, ...features.rails], heightAt);
  const raised = new Set<Way>();
  const users = new Map<string, Set<string>>();
  for (const way of [...features.roads, ...features.rails]) {
    for (const p of way.line) {
      users.set(pointKey(p), (users.get(pointKey(p)) ?? new Set<string>()).add(userOf(way)));
    }
  }
  const crosses = (l: Way, p: Point) => [...(users.get(pointKey(p)) ?? [])].some((user) => user !== userOf(l));
  const room = { least: (l: Way) => least.get(l) ?? [], grade: (l: Way) => GRADE[userOf(l)], crosses, raised: (l: Way) => raised.add(l) };
  const stepped = setBridgeDecks(features.roads, heightAt, indoors, throughBuildings, room) + setBridgeDecks(features.rails, heightAt, indoors, undefined, room);
  logger.log(`${ramps(features.roads) + ramps(features.rails)} bridge approaches raised out of the hollows under bridges, ${stepped} decks' heights told by steps, ${raised.size} bridge ways raised for the room OSM tells under them: ${[...new Set([...raised].map((w) => w.osm))].join(", ")}`);
  return { ground };
}

export function tunnelStage(world: OsmWorld, spanned: Spanned, knownFloors: KnownFloor[], lp: SolveLp, logger: Logger): Tunnelled {
  const { features, bridgeOutlines, levels } = world;
  const { ground } = spanned;
  const heightAt = ground.at("flights");
  const decks = new DeckIndex([...features.roads, ...features.rails], bridgeOutlines);
  const network = tunnelNetwork(features, heightAt, levels);
  const solved = solveFloors(features, network, lp, (p) => decks.under(p), knownFloors, (p, layer) => decks.over(p, layer));
  for (const { way, bound, at, by } of solved.conflicts) {
    logger.warn(`tunnel floor misses its ${bound} at (${at[0].toFixed(1)}, ${at[1].toFixed(1)}): ${way} by up to ${by.toFixed(1)} m`);
  }
  const ramps = rampsOut(features.roads, network) + rampsOut(features.rails, network);
  logger.log(`${solved.floors} tunnel ways under hills and lakes get floors, ${ramps} ways out of their portals ramps, ${network.walls.length} stretches of ground raised over portals`);
  if (knownFloors.length > 0) {
    logger.log(`${solved.known} of ${knownFloors.length} known tunnel floors on a tunnel`);
  }
  const opened = openPortals(features.buildings, solved.basements, features.roads, heightAt);
  logger.log(`${solved.basements.length} tunnel ways go down into basements from portals in buildings, opening ${opened} walls`);
  // from here on, and in the tiles' heights, the ground over the tunnels' ends is raised to their portals' walls
  const wallsAt = portalWallsAt(network.walls);
  ground.lay("portals", (below) => raiseToWalls(below, wallsAt));
  return { ground };
}

/** The bridges with their decks set */
export interface Decked {
  bridges: Way[];
}

/**
 * Over the bridges' decks (spanStage): the outlines' decks and the ramps to them, the lids fitted to the decks over them, the ways carried through buildings on spans, the staircases' decks, and the
 * ways under decks too low over them lowered into cuts
 */
export function deckStage(world: OsmWorld, tunnelled: Tunnelled, logger: Logger): Decked {
  const { features, bridgeOutlines, throughBuildings } = world;
  const heightAt = tunnelled.ground.at("portals");
  // the ways leading on from a bridge's outline ramp to its deck at their users' grade
  const decked = [...features.roads, ...features.rails];
  const outlined = setOutlineDecks(bridgeOutlines, decked, heightAt, (w) => GRADE[userOf(w)]);
  for (const piece of decked.slice(features.roads.length + features.rails.length)) {
    if (isRoad(piece)) {
      features.roads.push(piece);
    } else {
      features.rails.push(piece);
    }
  }
  features.bridgeDecks = outlined.decks;
  logger.log(`${bridgeOutlines.length} bridge outlines, ${new Set(outlined.decks.map((d) => d.osm)).size} with decks for the ${outlined.ways} ways on them`);
  logger.log(`${fitLidsToDecks([...features.roads, ...features.rails], heightAt)} lids fitted to the decks over them`);
  // ways carried through buildings on a span open their walls from the deck up
  const carried = features.roads.filter((r) => r.deck && !isBridge(r) && throughBuildings(r));
  raisePassages(features.buildings, carried);
  logger.log(`${carried.length} ways through buildings carried on bridges' spans`);
  // a staircase may end on a deck
  logger.log(`${setStaircaseDecks(features.roads, heightAt)} staircases with landings out of line with the ground get decks, one riser all the way`);
  // the decks stay straight: a way under one with too little room goes down into a cut
  const bridges = [...features.roads, ...features.rails].filter((w) => isBridge(w) && w.deck);
  const over = new Set<string>();
  const cuts =
    lowerUnderBridges(features.roads, bridges, bridgeOutlines, heightAt, over, features.rails, features.bridgeDecks) +
    lowerUnderBridges(features.rails, bridges, bridgeOutlines, heightAt, over, features.roads, features.bridgeDecks);
  logger.log(`${cuts} ways lowered into cuts under ${over.size} bridges too low over them (their ends may be too low): ${[...over].join(", ")}`);
  const built = new DeckIndex(bridges, bridgeOutlines, features.bridgeDecks);
  logger.log(`${fitRoomsUnderDecks(features.roads, (p, layer) => built.over(p, layer))} tunnels under bridges' decks get a lower room`);
  return { bridges };
}

/**
 * The railways' beds, ending at their bridges' and approaches' heights, tramways' staying under the decks over them
 * by a tram's room; the platforms' tops on them, and the level pitches and paved areas
 */
export function bedStage(world: OsmWorld, tunnelled: Tunnelled, decked: Decked, logger: Logger): void {
  const { features, bridgeOutlines } = world;
  const heightAt = tunnelled.ground.at("portals");
  const beds = setTrackBeds(
    features.rails,
    heightAt,
    tramBedCeiling(decked.bridges, bridgeOutlines, heightAt),
    features.roads.map((r) => r.line),
  );
  logger.log(`${beds} railway lines get smoothed track beds`);
  logger.log(`${setPlatformTops(features.areas, heightAt, features.rails)} railway platforms get their top`);
  logger.log(`${setLevelTops(features.areas, heightAt)} pitches and paved areas are level and get their top`);
}

export function pitchStage(world: OsmWorld, logger: Logger): void {
  const { features, pitches } = world;
  features.pitches = pitchBoxes(pitches, features.areas, features.buildings);
  logger.log(`${features.pitches.length} of ${pitches.length} pitches outdoors mapped as rectangles`);
}

/** The buildings with the register's heights, materials and years, and the parts with their outlines' */
export interface Registered {
  attributions: string[];
}

export async function registerStage(world: OsmWorld, sources: Sources, logger: Logger): Promise<Registered> {
  const { features } = world;
  const attributions: string[] = [];
  try {
    const asked = await sources.inPieces("building register", (box) => fetchBuildingRegister(box, sources));
    const register = sources.uniques(asked.pieces.map((p) => p.buildings));
    const match = applyRegister(features.buildings, sources.near(register), (r) => sources.toMeters(r.latitude, r.longitude));
    logger.log(
      `building register: ${register.length} buildings (${asked.cached ? "cached" : "fetched"}), ` +
        `${match.heights} heights, ${match.materials} wall materials and ${match.frames} frame materials set, ${match.unmatched} inside no OSM building, ` +
        `${match.elsewhere} mostly elsewhere (their storeys not taken), storeys left out of the count in ${match.attics} roofs and ` +
        `${match.uncounted} buildings, another wing's materials not taken in ${match.wings}`,
    );
    if (match.matched > 0) {
      attributions.push(BUILDING_REGISTER_ATTRIBUTION);
    }
  } catch (err) {
    logger.warn(`warning: no building register data: ${messageOf(err)}`);
  }
  // the register gives the halls their heights, and the outlines their facades and years
  logger.log(`${openRailHalls(features.buildings, features.rails)} halls opened where railways run in`);
  logger.log(`${inheritFromOutlines(features.buildings)} building parts take a material, colour, frame, roof material or year from their outline`);
  return { attributions };
}

/** The buildings' outlines in TM35FIN, and the options, of a request to the National Land Survey's sources */
function mmlRequest(buildings: Building[], apiKey: string, sources: Sources, logger: Logger): [Polygon[], { apiKey: string; cache: SourceCache; refresh: boolean; log: (message: string) => void }] {
  const toTm = (ring: Point[]) => ring.map((p) => toTm35fin(sources.toGeo(p)));
  const outlines = buildings.map((b) => ({ outer: toTm(b.polygon.outer), holes: b.polygon.holes.map(toTm) }));
  return [outlines, { apiKey, cache: sources.cache, refresh: sources.refresh, log: (message) => logger.log(message) }];
}

/** Roof colours from the orthophoto where OSM has none, after the parts take their outlines' (registerStage) */
export async function roofColourStage(world: OsmWorld, sources: Sources, after: Registered, logger: Logger): Promise<string[]> {
  const { mmlApiKey } = sources;
  if (!mmlApiKey) {
    return [];
  }
  const roofs = world.features.buildings.filter((b) => !b.hasParts && !b.roofColour);
  try {
    const { colours, cached, fetched } = await fetchRoofColours(...mmlRequest(roofs, mmlApiKey, sources, logger));
    for (const [index, colour] of colours) {
      roofs[index].roofColour = colour;
    }
    logger.log(`orthophoto: ${colours.size} of ${roofs.length} roofs without roof:colour coloured (${cached} cached, ${fetched} squares fetched)`);
    return colours.size > 0 ? [ORTHO_ATTRIBUTION] : [];
  } catch (err) {
    logger.warn(`warning: no roof colours from the orthophoto: ${messageOf(err)}`);
    return [];
  }
}

/** The buildings' windows */
export interface Windowed {
  windowed: number;
}

/** The buildings' ages and windows, from the register's years and uses */
export function buildingLookStage(world: OsmWorld, after: Registered, logger: Logger): Windowed {
  const { buildings } = world.features;
  // TODO: measure guessed heights and roof shapes from the MML laser scanning point cloud too, not only bring
  // measured tops down to it (laserScanning.ts; mind trees and newer buildings).
  const aged = applyAges(buildings);
  const dated = buildings.filter((b) => (b.year !== undefined || b.startDate !== undefined) && !b.hasParts).length;
  logger.log(`${dated} buildings have a year, ${aged} old ones with storeys taller than ${LEVEL_HEIGHT_M} m`);
  const estimated = buildings.filter((b) => b.heightEstimated && !b.hasParts).length;
  logger.log(`${estimated} buildings have a height estimated from their type and floor area`);
  const windowed = assignWindows(buildings);
  logger.log(`${windowed} of ${buildings.filter((b) => !b.hasParts).length} buildings get windows`);
  return { windowed };
}

/**
 * The details of other Overpass queries: the entrances (and doors guessed for buildings with windows but none), the
 * businesses showing at them, playground equipment, landmarks and bicycle parkings
 */
export async function detailStage(world: OsmWorld, sources: Sources, after: Windowed, logger: Logger): Promise<void> {
  const { features, playgrounds } = world;
  const { origin } = sources;
  try {
    const { response, cached } = await sources.overpass("OSM entrances", entranceQuery, true, false);
    const entrances = parseEntrances(response.elements, origin);
    const placed = assignEntrances(features.buildings, entrances);
    const guessed = guessEntrances(features.buildings, features.roads);
    logger.log(`${entrances.length} OSM entrances (${cached ? "cached" : "fetched"}), ${placed} on a building; doors guessed for ${guessed} buildings`);
  } catch (err) {
    logger.warn(`warning: no entrances: ${messageOf(err)}`);
  }
  // businesses after the entrances they show at
  try {
    const { response, cached } = await sources.overpass("OSM businesses", businessQuery);
    const businesses = parseBusinesses(response.elements, origin);
    const placed = placeBusinesses(features.buildings, businesses, features.roads);
    logger.log(
      `${businesses.length} OSM businesses (${cached ? "cached" : "fetched"}), ${placed.placed} in a building, ` +
        `${placed.fronts} of them showing on a wall (${placed.atDoors} at their door)`,
    );
  } catch (err) {
    logger.warn(`warning: no businesses: ${messageOf(err)}`);
  }
  try {
    const { response, cached } = await sources.overpass("playground equipment", playgroundQuery);
    const placed = placePlayEquipment(parsePlayEquipment(response.elements, origin), playgrounds);
    features.playEquipment = placed.equipment;
    logger.log(
      `${placed.equipment.length} pieces of playground equipment (${cached ? "cached" : "fetched"}) in ${playgrounds.length} playgrounds: ` +
        `${placed.merged} mapped twice merged, ${placed.rows} swings lined up in rows, ${placed.edges} with their playground's nearest edge`,
    );
  } catch (err) {
    logger.warn(`warning: no playground equipment: ${messageOf(err)}`);
  }
  try {
    const { response, cached } = await sources.overpass("landmarks", landmarkQuery, true, false);
    const found = parseLandmarks(response.elements, origin);
    Object.assign(features, found);
    const areas = features.areas.length;
    features.areas = withoutCourseWater(features.areas, found.rides);
    const lit = found.seamarks.filter((s) => s.light).length;
    logger.log(
      `landmarks (${cached ? "cached" : "fetched"}): ${found.seamarks.length} seamarks (${lit} lit), ${found.landmarks.length} masts, ` +
        `flagpoles, stones, fountains, artworks and memorials, ${found.piers.length} piers, ${found.dams.length} dams and weirs, ` +
        `${found.rides.length} rides and tracks (${areas - features.areas.length} water areas along flumes left to them), ` +
        `${found.powerLines.length} power lines, ${found.pistes.length} pistes`,
    );
  } catch (err) {
    logger.warn(`warning: no landmarks: ${messageOf(err)}`);
  }
  try {
    const { response, cached } = await sources.overpass("bicycle parkings", bicycleParkingQuery);
    features.bicycleParkings = parseBicycleParking(response.elements, origin);
    const capacity = features.bicycleParkings.reduce((sum, p) => sum + (p.capacity ?? 0), 0);
    logger.log(`${features.bicycleParkings.length} bicycle parkings (${cached ? "cached" : "fetched"}), ${capacity} places where OSM tells`);
  } catch (err) {
    logger.warn(`warning: no bicycle parking: ${messageOf(err)}`);
  }
}

/** The ground cut at buildings' walls (its buildings layer) */
export interface BuildingGround {
  steps: GroundStep[];
  ground: Ground;
}

/**
 * The ground cut at buildings' walls, out of the heaps against them, over the ground raised over the portals: the
 * buildings stand where they did, their walls reaching down to it, and from them on it is the ground. After the dams,
 * which are landmarks.
 */
export function buildingGroundStage(world: OsmWorld, tunnelled: Tunnelled, logger: Logger): BuildingGround {
  const { features } = world;
  const water = features.areas.filter((a) => a.kind === "water").map((a) => a.polygon);
  const dams = (features.dams ?? []).flatMap((d) => {
    const line = d.outline ?? d.line;
    return line ? [line] : [];
  });
  const { ground } = tunnelled;
  let walls: GroundStep[] = [];
  ground.lay("buildings", (below) => {
    walls = buildingSteps(features.buildings, [...features.roads, ...features.rails], below, water, dams);
    return stepAtWalls(below, walls);
  });
  logger.log(`${new Set(walls.map((s) => s.wall)).size} buildings step the ground outside their walls, in ${walls.length} stretches`);
  return { steps: walls, ground };
}

/**
 * Where each building stands (its bases, on the ground under its walls), the stair halls opened where covered ways
 * come in at their doors, and the measured tops: the laser scanning's roofs and shapes, the 3D parts' tops, which
 * are above sea level, so after the bases. Returns the attributions of the sources used.
 */
export async function buildingHeightStage(
  world: OsmWorld,
  sources: Sources,
  tunnelled: Tunnelled,
  buildingGround: BuildingGround,
  roofTopSources: RoofTopSource[],
  logger: Logger,
): Promise<string[]> {
  const { features, covered } = world;
  const heightAt = tunnelled.ground.at("portals");
  const { mmlApiKey } = sources;
  const attributions: string[] = [];
  const lids = [...features.roads, ...features.rails].flatMap((w) => (w.lid ? [{ line: w.line, lid: w.lid }] : []));
  const raised: Building[] = [];
  const platforms = features.areas.filter((a) => a.kind === "platform");
  const ways = [...features.roads, ...features.rails].filter((w) => !inTunnel(w) && !isBridge(w));
  const based = setBuildingBases(features.buildings, heightAt, lids, raised, platforms, ways, buildingGround.ground.at("buildings"));
  logger.log(`${based} buildings stand at their OSM entrance or highest ground (at most ${MAX_PLINTH_M} m above their lowest)`);
  // buildings raised to a door up a slope are stair halls: open them where covered ways come in
  const openings = openDoorways(raised, covered, heightAt);
  logger.log(`${raised.length} buildings raised over a door up a slope, ${openings} openings where covered ways come in at their doors`);
  logger.log(`${passagesUpSlopes(features.buildings, heightAt)} passage openings and rooms count from the ground up a slope`);
  const notRaised = features.buildings.filter((b) => !raised.includes(b));
  // the laser scanning's roofs, which a measured top over a chimney or a lantern comes down to, and their shapes:
  // wherever the National Land Survey's key is, measured tops or not
  let laserRoof: ((b: Building) => number | undefined) | undefined;
  let laserShape: ((b: Building) => LaserRoofShape | undefined) | undefined;
  if (mmlApiKey) {
    // the parts too, for their roofs' shapes
    const measured = notRaised.filter((b) => measurable(b) || (b.part && b.base !== undefined && !b.special && b.shelter === undefined && !b.lattice));
    try {
      const { roofs, shapes, cached, fetched, failed } = await fetchLaserRoofs(...mmlRequest(measured, mmlApiKey, sources, logger));
      const byBuilding = new Map<Building, number | undefined>(measured.map((b, index) => [b, roofs.get(index)]));
      laserRoof = (b) => byBuilding.get(b);
      const shapeByBuilding = new Map<Building, LaserRoofShape | undefined>(measured.map((b, index) => [b, shapes.get(index)]));
      laserShape = (b) => shapeByBuilding.get(b);
      logger.log(`laser scanning: ${roofs.size} of ${measured.length} roofs measured (${cached} cached, ${fetched} sheets fetched${failed > 0 ? `, ${failed} failed` : ""})`);
    } catch (err) {
      logger.warn(`warning: no roofs from the laser scanning: ${messageOf(err)}`);
    }
  }
  let lowered = 0;
  for (const source of roofTopSources) {
    try {
      const asked = await sources.inPieces(source.title, (box) => fetchRoofTops(source, box, sources), source.covers);
      const parts = sources.uniques(asked.pieces.map((p) => p.parts));
      const ring = (points: GeoPoint[]) => points.map((p) => sources.toMeters(p.latitude, p.longitude));
      const nearParts = parts.filter((p) => sources.near(p.outer).length > 0);
      const measuredParts = nearParts.map((p) => ({ polygon: { outer: ring(p.outer), holes: p.holes.map(ring) }, top: p.top }));
      // outlines holding parts of clearly different heights become outlines with those parts first
      const split = splitByMeasuredParts(notRaised, measuredParts, features.roads);
      for (const part of split.parts) {
        features.buildings.push(part);
      }
      const match = applyRoofTops(notRaised, measuredParts, laserRoof);
      lowered += match.lowered;
      logger.log(
        `${source.title}: ${parts.length} parts (${asked.cached ? "cached" : "fetched"}), ${match.heights} buildings' heights measured ` +
          `(${match.roofs} given a hipped roof, ${match.lowered} down to the laser scanning's roof), ` +
          `${match.uncovered} too little covered, ${match.rejected} with tops fitting neither their storeys nor a roof, ` +
          `${split.split} split into ${split.parts.length} parts of their heights (${split.failed} that could not be cut, ` +
          `${split.slivers} whose slivers could not be)`,
      );
      if (match.heights > 0 || split.split > 0) {
        attributions.push(source.attribution);
      }
    } catch (err) {
      logger.warn(`warning: no data from the ${source.title}: ${messageOf(err)}`);
    }
  }
  // the shapes after the heights: a roof's rise at most half of its building's
  const shaped = laserShape ? applyLaserShapes(notRaised, laserShape) : { pitched: 0, flattened: 0, gambrel: 0 };
  if (laserShape) {
    logger.log(`laser scanning: ${shaped.pitched} roofs given the pitched shape their points tell (${shaped.gambrel} gambrel), ${shaped.flattened} guessed ones told flat`);
  }
  if (lowered > 0 || shaped.pitched > 0 || shaped.flattened > 0) {
    attributions.push(LASER_ATTRIBUTION);
  }
  return attributions;
}

/** The roofs tagged gambrel, once the buildings' heights are known */
export function gambrelStage(world: OsmWorld, logger: Logger): void {
  const gambrels = taggedGambrels(world.features.buildings);
  if (gambrels > 0) {
    logger.log(`${gambrels} roofs tagged gambrel drawn so`);
  }
}

/** People walking and cycling along the ways, drawn by the businesses and doors */
export function footfallStage(world: OsmWorld, logger: Logger): void {
  const { features } = world;
  const footfall = estimateFootfall(features.roads, features.buildings);
  logger.log(`footfall on ${footfall.ways} ways (${footfall.separate} streets with their sidewalks drawn apart get none)`);
  const cycling = estimateCycling(features.roads, features.buildings);
  logger.log(`cycling on ${cycling.ways} ways`);
}

/** The register trees, which replace OSM's where they overlap, and the trees on ways moved beside them. Returns the attributions. */
export async function treeStage(world: OsmWorld, sources: Sources, treeSources: TreeRegisterSource[], logger: Logger): Promise<string[]> {
  const { features } = world;
  const attributions: string[] = [];
  const osmTrees = features.trees.length;
  const registerTrees: RegisterTree[] = [];
  for (const source of treeSources) {
    try {
      const asked = await sources.inPieces(source.title, (box) => fetchTreeRegister(source, box, sources), source.covers);
      const trees = sources.uniques(asked.pieces.map((p) => p.trees));
      logger.log(`${source.title}: ${trees.length} trees and shrubs (${asked.cached ? "cached" : "fetched"})`);
      registerTrees.push(...sources.near(trees));
      if (trees.length > 0) {
        attributions.push(source.attribution);
      }
    } catch (err) {
      logger.warn(`warning: no data from the ${source.title}: ${messageOf(err)}`);
    }
  }
  if (registerTrees.length > 0) {
    features.trees = mergeTrees(
      registerTrees.map(({ latitude, longitude, ...tree }) => ({ point: sources.toMeters(latitude, longitude), ...tree })),
      features.trees,
    );
    logger.log(`${osmTrees - (features.trees.length - registerTrees.length)} of ${osmTrees} OSM trees at a register tree`);
  }
  const standing = features.trees.length;
  features.trees = moveTreesOffWays(features.trees, features.roads, features.rails);
  logger.log(`trees on ways moved beside them, ${standing - features.trees.length} with no room there left out`);
  return attributions;
}

/**
 * What stands along the ways, after the decks where there is ground: the street lamps, the crossings, signals
 * and gates on their ways, the barriers opened for the ways and the gates and left out on decks and lids, the woods'
 * trees planted within `within`, what stands on the outlines' decks, and the landmarks off the ways
 */
export function streetStage(world: OsmWorld, heightAt: HeightAt | undefined, after: Decked | undefined, within: Rect, logger: Logger): void {
  const { features, streetNodes } = world;
  const lamps = placeLamps(features.lamps, features.roads);
  logger.log(
    `${features.lamps.length} street lamps: ${lamps.heights} with heights and ${lamps.facing} facing guessed from the street ` +
      `next to them, ${lamps.onDecks} on bridges`,
  );
  // the gates before the barriers, which open for them
  const { dropped } = placeStreetNodes(streetNodes, features);
  const openings = openBarriers(features);
  // a railing along a bridge stands on its deck, not on the ground under it
  const offDecks = heightAt ? leaveOutOnDecks(features, heightAt) : 0;
  logger.log(
    `${features.crossings.length} crossings, ${features.signals.length} traffic signals and ${features.gates.length} gates on their ways ` +
      `(${dropped} on none left out); ${openings} openings cut into fences and walls, ${offDecks} stretches on bridges and lids left out, ` +
      `in ${features.barriers.length} pieces`,
  );
  const planted = plantForests(features, within);
  logger.log(`${planted} trees and shrubs planted in woods and scrub`);
  const onDecks = standOnDecks(features.bridgeDecks, features.trees, features.lamps, features.playEquipment, features.landmarks, features.roads, features.rails);
  logger.log(
    `${onDecks.trees} trees, ${onDecks.lamps} more street lamps, ${onDecks.play} pieces of playground equipment and ` +
      `${onDecks.landmarks} landmarks on bridge decks, ${onDecks.aside} landmarks with no room there clear of their ways left out`,
  );
  const offWays = moveLandmarksOffWays(features.landmarks ?? [], features.roads, features.rails);
  logger.log(`${offWays.moved} landmarks on roads for vehicles and railways moved off them, ${offWays.aside} with no room beside them left out`);
}

/** The water's surface level where the elevation model has it uneven, and the waterways through it */
export async function waterStage(world: OsmWorld, sources: Sources, after: BuildingGround, logger: Logger): Promise<WaterLevels | undefined> {
  try {
    const { response, cached } = await sources.overpass("OSM waterways", waterwayQuery);
    const lines = parseWaterways(response.elements, sources.origin);
    const water = setWaterLevels(world.features.areas, lines, after.ground.at("buildings"));
    after.ground.lay("water", (below) => (e, n) => water.levelAt([e, n]) ?? below(e, n));
    logger.log(
      `${lines.length} OSM waterways (${cached ? "cached" : "fetched"}), ${water.waterways.length} stretches of them in the water; ` +
        `${water.still} still waters level, ${water.flowing} flowing ones falling along their waterways, ${water.uneven} left uneven`,
    );
    return water;
  } catch (err) {
    logger.warn(`warning: no waterways: ${messageOf(err)}`);
    return undefined;
  }
}
