// Builds the map's tiles from OpenStreetMap and the open data sources, laid out in meters around the origin.
// The first tile asked for builds the whole area: bridges, tunnels and multipolygons reach over tile edges.
import type { SourceCache } from "./cache.ts";
import { applyAges } from "./ages.ts";
import { applyRegister, BUILDING_REGISTER_ATTRIBUTION, fetchBuildingRegister } from "./buildingRegister.ts";
import { leaveOutOnDecks, openBarriers } from "./barriers.ts";
import { MAX_PLINTH_M, setBuildingBases } from "./bases.ts";
import { buildingSteps, cutBuildingSteps } from "./buildingSteps.ts";
import { setBridgeDecks } from "./bridges.ts";
import { setOutlineDecks, standOnDecks } from "./decks.ts";
import { bicycleParkingQuery, parseBicycleParking } from "./bicycleParking.ts";
import { businessQuery, parseBusinesses, placeBusinesses } from "./businesses.ts";
import { coverCutTunnels, fitLidsToDecks } from "./cuts.ts";
import { ELEVATION_ATTRIBUTION, fetchElevation, sampleElevation, toTm35fin, type ElevationGrid } from "./elevation.ts";
import { assignEntrances, entranceQuery, guessEntrances, parseEntrances } from "./entrances.ts";
import { estimateCycling, estimateFootfall } from "./footfall.ts";
import { mergeTrees, moveTreesOffWays, plantForests } from "./forests.ts";
import { pointKey, simplifyLine, type Point } from "./geometry.ts";
import { placeLamps } from "./lamps.ts";
import { landmarkQuery, moveLandmarksOffWays, parseLandmarks } from "./landmarks.ts";
import { withoutCourseWater } from "./rides.ts";
import { parsePlayEquipment, placePlayEquipment, playgroundQuery } from "./playgrounds.ts";
import { fetchRoofColours, ORTHO_ATTRIBUTION } from "./ortho.ts";
import { bounds, elementsWithin, fetchOverpass, inheritFromOutlines, LEVEL_HEIGHT_M, NOT_FOR_VEHICLES, openDoorways, openRailHalls, overpassQuery, parseOsm, type Building, type GeoBox, type OsmElement } from "./osm.ts";
import { inGeoBox, LocalProjection, type GeoPoint } from "./projection.ts";
import { flightSteps, stepAtFlights, type FlightStep } from "./flights.ts";
import { groundSteps, stepAtWalls, type GroundStep } from "./retainingWalls.ts";
import { dropStepsInParts, setStaircaseDecks } from "./stairs.ts";
import { placeStreetNodes } from "./streets.ts";
import { cutIntoTiles, latticeProjection, tileHeights, tileName, tilesCovering, type Tile, type TileKey } from "./tiles.ts";
import { setPlatformTops } from "./platforms.ts";
import { applyRoofTops, fetchRoofTops, ROOF_TOP_SOURCES, type RoofTopSource } from "./roofTops.ts";
import { setTrackBeds } from "./trackbeds.ts";
import { decksOver, lowerUnderBridges, tramBedCeiling, underBridges } from "./underbridges.ts";
import { passagesUpSlopes, raisePassages } from "./raisedPassages.ts";
import { fitRoomsUnderDecks, openPortals, portalWallsAt, raiseToWalls, setTunnelFloors, setTunnelRooms, uncoverAtGrade } from "./tunnels.ts";
import { fetchTreeRegister, overlaps, TREE_REGISTERS, type RegisterTree, type TreeRegisterSource } from "./treeRegister.ts";
import { assignWindows } from "./windows.ts";
import { applyOsmEdits, type OsmEdit } from "./edits.ts";
import { cutWaterways, parseWaterways, setWaterLevels, waterwayQuery, type WaterLevels } from "./waterways.ts";

export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
export const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";

/** Fetch this much around the tiles, so a long road segment crossing a tile corner is not missed. */
const FETCH_MARGIN_M = 50;
/** Roads and rails are simplified to this many meters */
const LINE_TOLERANCE_M = 0.3;
/** Ground height grid spacing; the elevation model has 2 m cells */
const HEIGHT_STEP_M = 2;
/** Elevation model coordinates are projected on a lattice this far apart (m) and interpolated: nearly linear over a tile */
const TM_LATTICE_M = 10;

export interface Logger {
  log(message: string): void;
  warn(message: string): void;
}

export interface MapOptions {
  /** Map coordinates are meters east and north of this point */
  origin: GeoPoint;
  /** Every tile that touches this box is part of the map */
  area: GeoBox;
  tileSizeM: number;
  /** Where the sources' responses are kept */
  cache: SourceCache;
  /** Fetch the sources again instead of using the cache */
  refresh?: boolean;
  overpassUrl?: string;
  /** Maanmittauslaitos open interfaces: ground heights, bridge decks and roof colours when set */
  mmlApiKey?: string;
  /** The tree registers to take street and park trees from, of those that cover the area; TREE_REGISTERS by default */
  treeRegisters?: TreeRegisterSource[];
  /** The 3D building parts to take measured roof tops from, of those that cover the area; ROOF_TOP_SOURCES by default */
  roofTops?: RoofTopSource[];
  /** Local edits of the OSM data, not uploaded (yet): applied to what is fetched, new elements to the map's features only */
  edits?: OsmEdit[];
  /** Corrects the elevation model's height (m) at a point (m), where the ground has changed since it was scanned */
  groundCorrection?: (point: Point, height: number) => number;
  /**
   * Builds only these of the map's tiles: from the whole area's sources (the same requests, so the cached responses
   * serve), keeping only the features that reach within marginM of the tiles, and the tunnels (elementsWithin). Quick
   * for a few tiles, and they come out as in the whole map unless something they depend on reaches farther.
   */
  part?: { tiles: TileKey[]; marginM: number };
  /** Progress and warnings; console by default */
  logger?: Logger;
}

export interface MapInfo {
  origin: GeoPoint;
  tileSize: number;
  /** The tiles of the map, west to east within south to north */
  tiles: TileKey[];
  /** OpenStreetMap data timestamp from Overpass */
  osmTimestamp: string | undefined;
  /** The attributions of the data used, which a published map must show */
  attributions: string[];
}

interface Built {
  info: MapInfo;
  tiles: Map<string, Tile>;
  heightAt: ((e: number, n: number) => number | undefined) | undefined;
  /** The elevation model, where a point (m) is in its coordinates, stepped at the retaining walls and raised to the portals' walls, for the tiles' heights */
  ground:
    | {
        grid: ElevationGrid;
        toTm: (e: number, n: number) => [number, number];
        steps: GroundStep[];
        flights: FlightStep[];
        buildingSteps: GroundStep[];
        wallsAt?: (e: number, n: number) => number | undefined;
      }
    | undefined;
  /** The water's surface where it is levelled, over the elevation model's */
  water: WaterLevels | undefined;
}

export class MapBuilder {
  readonly tiles: TileKey[];
  readonly #options: MapOptions;
  readonly #projection: LocalProjection;
  readonly #logger: Logger;
  #built: Promise<Built> | undefined;

  constructor(options: MapOptions) {
    if (!(options.tileSizeM > 0)) {
      throw new Error(`invalid tile size: ${options.tileSizeM}`);
    }
    this.#options = options;
    this.#projection = new LocalProjection(options.origin);
    this.#logger = options.logger ?? console;
    const { area } = options;
    const toMeters = (latitude: number, longitude: number) => this.#projection.toMeters({ latitude, longitude });
    this.tiles = tilesCovering(
      bounds([toMeters(area.south, area.west), toMeters(area.south, area.east), toMeters(area.north, area.west), toMeters(area.north, area.east)]),
      options.tileSizeM,
    );
  }

  async info(): Promise<MapInfo> {
    return (await this.#build()).info;
  }

  /** A tile of the map, or undefined when it is not one of the map's tiles. */
  async tile(key: TileKey): Promise<Tile | undefined> {
    const built = await this.#build();
    const tile = built.tiles.get(tileName(key));
    if (!tile || !built.ground || tile.heights) {
      return tile;
    }
    const { grid, toTm, steps, flights, buildingSteps: walls, wallsAt } = built.ground;
    const at = latticeProjection(tile, this.#options.tileSizeM, TM_LATTICE_M, toTm);
    const water = built.water;
    const model = stepAtWalls(
      stepAtFlights(
        stepAtWalls((e: number, n: number) => this.#corrected(e, n, sampleElevation(grid, ...at(e, n))), steps),
        flights,
      ),
      walls,
    );
    const ground = wallsAt ? raiseToWalls(model, wallsAt) : model;
    const { heights, missing } = tileHeights(tile, this.#options.tileSizeM, HEIGHT_STEP_M, (e, n) => water?.levelAt([e, n]) ?? ground(e, n));
    if (missing > 0) {
      this.#logger.warn(`warning: tile ${tileName(tile)}: ${missing} height points outside the elevation model got the tile's average`);
    }
    tile.heights = heights;
    return tile;
  }

  #corrected(e: number, n: number, height: number | undefined): number | undefined {
    const correction = this.#options.groundCorrection;
    return height === undefined || !correction ? height : correction([e, n], height);
  }

  #build(): Promise<Built> {
    this.#built ??= this.#buildArea();
    return this.#built;
  }

  async #buildArea(): Promise<Built> {
    const { origin, tileSizeM: size, cache, mmlApiKey } = this.#options;
    const refresh = this.#options.refresh ?? false;
    const overpassUrl = this.#options.overpassUrl ?? DEFAULT_OVERPASS_URL;
    const logger = this.#logger;
    const projection = this.#projection;
    const toMeters = (latitude: number, longitude: number): Point => projection.toMeters({ latitude, longitude });
    const toGeo = (point: Point) => projection.toGeo(point);

    const keys = this.tiles;
    const xs = keys.map((key) => key.x);
    const ys = keys.map((key) => key.y);
    const minX = Math.min(...xs) * size - FETCH_MARGIN_M;
    const maxX = (Math.max(...xs) + 1) * size + FETCH_MARGIN_M;
    const minY = Math.min(...ys) * size - FETCH_MARGIN_M;
    const maxY = (Math.max(...ys) + 1) * size + FETCH_MARGIN_M;
    const corners = [toGeo([minX, minY]), toGeo([minX, maxY]), toGeo([maxX, minY]), toGeo([maxX, maxY])];
    const fetchBox = geoBoxOf(corners);

    logger.log(`${keys.length} tiles of ${size} m: x ${Math.min(...xs)} .. ${Math.max(...xs)}, y ${Math.min(...ys)} .. ${Math.max(...ys)}`);
    const part = this.#options.part;
    const built = part ? keys.filter((key) => part.tiles.some((tile) => tile.x === key.x && tile.y === key.y)) : keys;
    if (built.length === 0) {
      throw new Error("none of the tiles to build is in the map");
    }
    const builtRect = {
      minX: Math.min(...built.map((key) => key.x)) * size,
      minY: Math.min(...built.map((key) => key.y)) * size,
      maxX: (Math.max(...built.map((key) => key.x)) + 1) * size,
      maxY: (Math.max(...built.map((key) => key.y)) + 1) * size,
    };
    // the features reaching near the part's tiles, from the whole area's responses
    let within: GeoBox | undefined;
    if (part) {
      const [w, s, e, n] = [builtRect.minX - part.marginM, builtRect.minY - part.marginM, builtRect.maxX + part.marginM, builtRect.maxY + part.marginM];
      within = geoBoxOf([toGeo([w, s]), toGeo([w, n]), toGeo([e, s]), toGeo([e, n])]);
      logger.log(`building ${built.length} of the tiles, with the features within ${part.marginM} m of them`);
    }
    const near = <T extends GeoPoint>(points: T[]) => (within ? inGeoBox(points, within) : points);
    const edits = this.#options.edits ?? [];
    const overpass = async (query: string, addNew = false, report = addNew) => {
      const fetched = await fetchOverpass(query, { url: overpassUrl, cache, refresh });
      const kept = (elements: OsmElement[]) => ({ ...fetched, response: { ...fetched.response, elements: within ? elementsWithin(elements, within) : elements } });
      if (edits.length === 0) {
        return within ? kept(fetched.response.elements) : fetched;
      }
      const applied = applyOsmEdits(fetched.response.elements, edits, addNew);
      if (report) {
        const created = edits.filter((edit) => edit.action === "create").length;
        const deleted = edits.filter((edit) => edit.action === "delete").length;
        logger.log(
          `${edits.length} local edits of the OSM data: ${edits.length - created - deleted} modified, ${created} new, ${deleted} deleted` +
            (applied.missing > 0 ? `; ${applied.missing} of the modified or deleted not in the fetched data` : ""),
        );
      }
      return kept(applied.elements);
    };
    const { response, cached } = await overpass(overpassQuery(fetchBox), true);
    const osmTimestamp = response.osm3s?.timestamp_osm_base;
    logger.log(`${response.elements.length} OSM elements (${cached ? "cached, refresh to fetch again" : "fetched"}), data from ${osmTimestamp ?? "?"}`);

    const { features, streetNodes, bridgeOutlines, playgrounds, warnings, levels, covered, indoors, throughBuildings } = parseOsm(response.elements, origin);
    for (const warning of warnings) {
      logger.warn(`warning: ${warning}`);
    }
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
    let heightAt: ((e: number, n: number) => number | undefined) | undefined;
    // the ground stepped at the retaining walls only, which the buildings' walls step after the tunnels and bridges
    let wallStepped: ((e: number, n: number) => number | undefined) | undefined;
    let ground: Built["ground"];
    if (mmlApiKey) {
      // the corners' TM35FIN box covers the tiles, turned or not
      const tm = corners.map(toTm35fin);
      const { grid, cached: elevationCached } = await fetchElevation(
        {
          minE: Math.min(...tm.map(([e]) => e)),
          minN: Math.min(...tm.map(([, n]) => n)),
          maxE: Math.max(...tm.map(([e]) => e)),
          maxN: Math.max(...tm.map(([, n]) => n)),
        },
        { apiKey: mmlApiKey, cache, refresh },
      );
      logger.log(`elevation model ${grid.cols} x ${grid.rows} cells of ${grid.cellSize} m (${elevationCached ? "cached" : "fetched"})`);
      const toTm = (e: number, n: number) => toTm35fin(toGeo([e, n]));
      const modelAt = (e: number, n: number) => this.#corrected(e, n, sampleElevation(grid, ...toTm(e, n)));
      // the model smooths retaining walls into slopes: the ground steps at them again
      const steps = groundSteps(features.barriers, modelAt);
      const stepping = steps.filter((s) => s.footOut > 0 || s.topIn > 0);
      logger.log(`${new Set(stepping.map((s) => s.wall)).size} retaining walls step the ground, in ${stepping.length} stretches`);
      // and the edges flights of steps climb, a slab's or a terrace's, into slopes too
      const flights = flightSteps(features.roads, stepAtWalls(modelAt, steps));
      logger.log(`${flights.length} flights of steps step the ground the model smooths`);
      heightAt = stepAtFlights(stepAtWalls(modelAt, steps), flights);
      wallStepped = heightAt;
      ground = { grid, toTm, steps, flights, buildingSteps: [] };
      logger.log(`${setTunnelRooms(features.roads)} tunnels get a lower room by their maxheight`);
      // tunnels in cuts first: the ways over them become bridges
      const covered = coverCutTunnels(features, heightAt);
      logger.log(`${covered.tunnels} tunnels in cuts get lids, ${covered.crossings} ways over them become bridges`);
      logger.log(`${uncoverAtGrade(features, heightAt)} tunnels run at the ground under buildings`);
      const tunnels = setTunnelFloors(features, heightAt, levels, underBridges([...features.roads, ...features.rails], bridgeOutlines));
      logger.log(`${tunnels.floors} tunnel ways under hills and lakes get floors, ${tunnels.ramps} ways out of their portals ramps, ${tunnels.walls.length} stretches of ground raised over portals`);
      const opened = openPortals(features.buildings, tunnels.basements, features.roads, heightAt);
      logger.log(`${tunnels.basements.length} tunnel ways go down into basements from portals in buildings, opening ${opened} walls`);
      // from here on, and in the tiles' heights, the ground over the tunnels' ends is raised to their portals' walls
      const wallsAt = portalWallsAt(tunnels.walls);
      heightAt = raiseToWalls(heightAt, wallsAt);
      ground = { grid, toTm, steps, flights, buildingSteps: [], wallsAt };
      // before cutting into tiles, so a bridge's deck goes from end to end
      const ramps = (lines: { bridge: boolean; deck?: number[] }[]) => lines.filter((l) => l.deck && !l.bridge).length;
      const stepped = setBridgeDecks(features.roads, heightAt, indoors, throughBuildings) + setBridgeDecks(features.rails, heightAt, indoors);
      logger.log(`${ramps(features.roads) + ramps(features.rails)} bridge approaches raised out of the hollows under bridges, ${stepped} decks' heights told by steps`);
      // the ways leading on from a bridge's outline ramp to its deck: 8 % for people, 6 % for vehicles, 3 % for trains
      const decked = [...features.roads, ...features.rails];
      const outlined = setOutlineDecks(bridgeOutlines, decked, heightAt, (w) => ("width" in w ? (NOT_FOR_VEHICLES.has(w.kind) ? 0.08 : 0.06) : 0.03));
      for (const piece of decked.slice(features.roads.length + features.rails.length)) {
        if ("width" in piece) {
          features.roads.push(piece);
        } else {
          features.rails.push(piece);
        }
      }
      features.bridgeDecks = outlined.decks;
      logger.log(`${bridgeOutlines.length} bridge outlines, ${new Set(outlined.decks.map((d) => d.osm)).size} with decks for the ${outlined.ways} ways on them`);
      logger.log(`${fitLidsToDecks([...features.roads, ...features.rails], heightAt)} lids fitted to the decks over them`);
      // ways carried through buildings on a span open their walls from the deck up
      const carried = features.roads.filter((r) => r.deck && !r.bridge && throughBuildings(r));
      raisePassages(features.buildings, carried);
      logger.log(`${carried.length} ways through buildings carried on bridges' spans`);
      // after the decks, which a staircase may end on
      logger.log(`${setStaircaseDecks(features.roads, heightAt)} staircases with landings out of line with the ground get decks, one riser all the way`);
      // the decks stay straight: a way under one with too little room goes down into a cut
      const bridges = [...features.roads, ...features.rails].filter((w) => w.bridge && w.deck);
      const over = new Set<string>();
      const cuts = lowerUnderBridges(features.roads, bridges, bridgeOutlines, heightAt, over, features.rails) + lowerUnderBridges(features.rails, bridges, bridgeOutlines, heightAt, over, features.roads);
      logger.log(`${cuts} ways lowered into cuts under ${over.size} bridges too low over them (their ends may be too low): ${[...over].join(", ")}`);
      logger.log(`${fitRoomsUnderDecks(features.roads, decksOver(bridges, bridgeOutlines))} tunnels under bridges' decks get a lower room`);
      // after the decks: the railways end at their bridges' and approaches' heights, and tramways stay under the decks
      // over them by a tram's room
      const beds = setTrackBeds(
        features.rails,
        heightAt,
        tramBedCeiling(bridges, bridgeOutlines, heightAt),
        features.roads.map((r) => r.line),
      );
      logger.log(`${beds} railway lines get smoothed track beds`);
      logger.log(`${setPlatformTops(features.areas, heightAt, features.rails)} railway platforms get their top`);
    } else {
      logger.log("no MML API key: the tiles get no ground heights");
    }

    const otherAttributions: string[] = [];
    try {
      const { buildings: register, cached: registerCached } = await fetchBuildingRegister(fetchBox, { cache, refresh });
      const match = applyRegister(features.buildings, near(register), (r) => toMeters(r.latitude, r.longitude));
      logger.log(
        `building register: ${register.length} buildings (${registerCached ? "cached" : "fetched"}), ` +
          `${match.heights} heights, ${match.materials} wall materials and ${match.frames} frame materials set, ${match.unmatched} inside no OSM building, ` +
          `${match.elsewhere} mostly elsewhere (their storeys not taken), storeys left out of the count in ${match.attics} roofs and ` +
          `${match.uncounted} buildings`,
      );
      if (match.matched > 0) {
        otherAttributions.push(BUILDING_REGISTER_ATTRIBUTION);
      }
    } catch (err) {
      logger.warn(`warning: no building register data: ${err instanceof Error ? err.message : String(err)}`);
    }
    // after the register, which gives the halls their heights
    logger.log(`${openRailHalls(features.buildings, features.rails)} halls opened where railways run in`);
    // after the register, which gives the outlines their facades and years
    logger.log(`${inheritFromOutlines(features.buildings)} building parts take a material, colour, frame, roof material or year from their outline`);
    // roof colours from the orthophoto where OSM has none
    if (mmlApiKey) {
      const roofs = features.buildings.filter((b) => !b.hasParts && !b.roofColour);
      const toTm = (ring: Point[]) => ring.map((p) => toTm35fin(toGeo(p)));
      try {
        const { colours, cached: coloursCached, fetched } = await fetchRoofColours(
          roofs.map((b) => ({ outer: toTm(b.polygon.outer), holes: b.polygon.holes.map(toTm) })),
          { apiKey: mmlApiKey, cache, refresh, log: (message) => logger.log(message) },
        );
        for (const [index, colour] of colours) {
          roofs[index].roofColour = colour;
        }
        logger.log(`orthophoto: ${colours.size} of ${roofs.length} roofs without roof:colour coloured (${coloursCached} cached, ${fetched} squares fetched)`);
        if (colours.size > 0) {
          otherAttributions.push(ORTHO_ATTRIBUTION);
        }
      } catch (err) {
        logger.warn(`warning: no roof colours from the orthophoto: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // TODO: measure guessed heights and roof shapes from the MML laser scanning point cloud (a high
    // percentile of the points in an outline minus the ground; mind trees and newer buildings).
    // after the register, which has most buildings' years
    const aged = applyAges(features.buildings);
    const dated = features.buildings.filter((b) => (b.year !== undefined || b.startDate !== undefined) && !b.hasParts).length;
    logger.log(`${dated} buildings have a year, ${aged} old ones with storeys taller than ${LEVEL_HEIGHT_M} m`);
    const estimated = features.buildings.filter((b) => b.heightEstimated && !b.hasParts).length;
    logger.log(`${estimated} buildings have a height estimated from their type and floor area`);
    // after the register, which tells the use of a building=yes
    const windowed = assignWindows(features.buildings);
    logger.log(`${windowed} of ${features.buildings.filter((b) => !b.hasParts).length} buildings get windows`);
    // OSM entrances, and guessed doors for buildings with windows but none
    try {
      const { response: entranceResponse, cached: entrancesCached } = await overpass(entranceQuery(fetchBox));
      const entrances = parseEntrances(entranceResponse.elements, origin);
      const placed = assignEntrances(features.buildings, entrances);
      const guessed = guessEntrances(features.buildings, features.roads);
      logger.log(
        `${entrances.length} OSM entrances (${entrancesCached ? "cached" : "fetched"}), ${placed} on a building; ` +
          `doors guessed for ${guessed} buildings`,
      );
    } catch (err) {
      logger.warn(`warning: no entrances: ${err instanceof Error ? err.message : String(err)}`);
    }
    // businesses after the entrances they show at
    try {
      const { response: businessResponse, cached: businessesCached } = await overpass(businessQuery(fetchBox));
      const businesses = parseBusinesses(businessResponse.elements, origin);
      const placed = placeBusinesses(features.buildings, businesses, features.roads);
      logger.log(
        `${businesses.length} OSM businesses (${businessesCached ? "cached" : "fetched"}), ${placed.placed} in a building, ` +
          `${placed.fronts} of them showing on a wall (${placed.atDoors} at their door)`,
      );
    } catch (err) {
      logger.warn(`warning: no businesses: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const { response: playResponse, cached: playCached } = await overpass(playgroundQuery(fetchBox));
      const placed = placePlayEquipment(parsePlayEquipment(playResponse.elements, origin), playgrounds);
      features.playEquipment = placed.equipment;
      logger.log(
        `${placed.equipment.length} pieces of playground equipment (${playCached ? "cached" : "fetched"}) in ${playgrounds.length} playgrounds: ` +
          `${placed.merged} mapped twice merged, ${placed.rows} swings lined up in rows, ${placed.edges} with their playground's nearest edge`,
      );
    } catch (err) {
      logger.warn(`warning: no playground equipment: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const { response: landmarkResponse, cached: landmarksCached } = await overpass(landmarkQuery(fetchBox), true, false);
      const found = parseLandmarks(landmarkResponse.elements, origin);
      Object.assign(features, found);
      const areas = features.areas.length;
      features.areas = withoutCourseWater(features.areas, found.rides);
      const lit = found.seamarks.filter((s) => s.light).length;
      logger.log(
        `landmarks (${landmarksCached ? "cached" : "fetched"}): ${found.seamarks.length} seamarks (${lit} lit), ${found.landmarks.length} masts, ` +
          `flagpoles, stones, fountains, artworks and memorials, ${found.piers.length} piers, ${found.dams.length} dams and weirs, ` +
          `${found.rides.length} rides and tracks (${areas - features.areas.length} water areas along flumes left to them), ` +
          `${found.powerLines.length} power lines, ${found.pistes.length} pistes`,
      );
    } catch (err) {
      logger.warn(`warning: no landmarks: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const { response: parkingResponse, cached: parkingCached } = await overpass(bicycleParkingQuery(fetchBox));
      features.bicycleParkings = parseBicycleParking(parkingResponse.elements, origin);
      const capacity = features.bicycleParkings.reduce((sum, p) => sum + (p.capacity ?? 0), 0);
      logger.log(`${features.bicycleParkings.length} bicycle parkings (${parkingCached ? "cached" : "fetched"}), ${capacity} places where OSM tells`);
    } catch (err) {
      logger.warn(`warning: no bicycle parking: ${err instanceof Error ? err.message : String(err)}`);
    }
    // the ground cut or filled at buildings' walls into heaps outside them, under the ground raised over the portals:
    // the buildings stand where they did, their walls reaching down to it, and from them on it is the ground
    let buildingStepped = heightAt;
    if (heightAt && wallStepped && ground) {
      const water = features.areas.filter((a) => a.kind === "water").map((a) => a.polygon);
      const dams = (features.dams ?? []).flatMap((d) => {
        const line = d.outline ?? d.line;
        return line ? [line] : [];
      });
      const walls = buildingSteps(features.buildings, [...features.roads, ...features.rails], heightAt, water, dams);
      logger.log(`${new Set(walls.map((s) => s.wall)).size} buildings step the ground outside their walls, in ${walls.length} stretches`);
      const stepped = stepAtWalls(wallStepped, walls);
      buildingStepped = ground.wallsAt ? raiseToWalls(stepped, ground.wallsAt) : stepped;
      ground = { ...ground, buildingSteps: walls };
    }
    if (heightAt) {
      const lids = [...features.roads, ...features.rails].flatMap((w) => (w.lid ? [{ line: w.line, lid: w.lid }] : []));
      const raised: Building[] = [];
      const platforms = features.areas.filter((a) => a.kind === "platform");
      const ways = [...features.roads, ...features.rails].filter((w) => !w.tunnel && !w.bridge);
      const based = setBuildingBases(features.buildings, heightAt, lids, raised, platforms, ways, buildingStepped);
      logger.log(`${based} buildings stand at their OSM entrance or highest ground (at most ${MAX_PLINTH_M} m above their lowest)`);
      // buildings raised to a door up a slope are stair halls: open them where covered ways come in
      const openings = openDoorways(raised, covered, heightAt);
      logger.log(`${raised.length} buildings raised over a door up a slope, ${openings} openings where covered ways come in at their doors`);
      logger.log(`${passagesUpSlopes(features.buildings, heightAt)} passage openings and rooms count from the ground up a slope`);
      // measured tops are above sea level: the buildings must stand at their base first
      const notRaised = features.buildings.filter((b) => !raised.includes(b));
      for (const source of (this.#options.roofTops ?? ROOF_TOP_SOURCES).filter((s) => overlaps(s.covers, fetchBox))) {
        try {
          const { parts, cached: partsCached } = await fetchRoofTops(source, fetchBox, { cache, refresh });
          const ring = (points: GeoPoint[]) => points.map((p) => toMeters(p.latitude, p.longitude));
          const nearParts = parts.filter((p) => near(p.outer).length > 0);
          const match = applyRoofTops(notRaised, nearParts.map((p) => ({ polygon: { outer: ring(p.outer), holes: p.holes.map(ring) }, top: p.top })));
          logger.log(
            `${source.title}: ${parts.length} parts (${partsCached ? "cached" : "fetched"}), ${match.heights} buildings' heights measured ` +
              `(${match.roofs} given a hipped roof), ` +
              `${match.uncovered} too little covered, ${match.rejected} with tops fitting neither their storeys nor a roof`,
          );
          if (match.heights > 0) {
            otherAttributions.push(source.attribution);
          }
        } catch (err) {
          logger.warn(`warning: no data from the ${source.title}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    // TODO: buildings with entrances on several levels, or steps at the door, stand at the wrong one.
    heightAt = buildingStepped;

    // after the businesses and doors that draw people
    const footfall = estimateFootfall(features.roads, features.buildings);
    logger.log(`footfall on ${footfall.ways} ways (${footfall.separate} streets with their sidewalks drawn apart get none)`);
    const cycling = estimateCycling(features.roads, features.buildings);
    logger.log(`cycling on ${cycling.ways} ways`);

    // register trees replace OSM's where they overlap
    const osmTrees = features.trees.length;
    const registerTrees: RegisterTree[] = [];
    for (const source of (this.#options.treeRegisters ?? TREE_REGISTERS).filter((s) => overlaps(s.covers, fetchBox))) {
      try {
        const { trees, cached: treesCached } = await fetchTreeRegister(source, fetchBox, { cache, refresh });
        logger.log(`${source.title}: ${trees.length} trees and shrubs (${treesCached ? "cached" : "fetched"})`);
        registerTrees.push(...near(trees));
        if (trees.length > 0) {
          otherAttributions.push(source.attribution);
        }
      } catch (err) {
        logger.warn(`warning: no data from the ${source.title}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (registerTrees.length > 0) {
      features.trees = mergeTrees(
        registerTrees.map(({ latitude, longitude, ...tree }) => ({ point: toMeters(latitude, longitude), ...tree })),
        features.trees,
      );
      logger.log(`${osmTrees - (features.trees.length - registerTrees.length)} of ${osmTrees} OSM trees at a register tree`);
    }
    const standing = features.trees.length;
    features.trees = moveTreesOffWays(features.trees, features.roads, features.rails);
    logger.log(`trees on ways moved beside them, ${standing - features.trees.length} with no room there left out`);
    // after the decks, which lamps on bridges stand on
    const lamps = placeLamps(features.lamps, features.roads);
    logger.log(
      `${features.lamps.length} street lamps: ${lamps.heights} with heights and ${lamps.facing} facing guessed from the street ` +
        `next to them, ${lamps.onDecks} on bridges`,
    );
    // after the decks too; the gates before the barriers, which open for them
    const { dropped } = placeStreetNodes(streetNodes, features);
    const openings = openBarriers(features);
    // a railing along a bridge stands on its deck, not on the ground under it
    const offDecks = heightAt ? leaveOutOnDecks(features, heightAt) : 0;
    logger.log(
      `${features.crossings.length} crossings, ${features.signals.length} traffic signals and ${features.gates.length} gates on their ways ` +
        `(${dropped} on none left out); ${openings} openings cut into fences and walls, ${offDecks} stretches on bridges and lids left out, ` +
        `in ${features.barriers.length} pieces`,
    );
    const planted = plantForests(features, builtRect);
    logger.log(`${planted} trees and shrubs planted in woods and scrub`);
    const onDecks = standOnDecks(features.bridgeDecks, features.trees, features.lamps, features.playEquipment, features.landmarks, features.roads, features.rails);
    logger.log(
      `${onDecks.trees} trees, ${onDecks.lamps} more street lamps, ${onDecks.play} pieces of playground equipment and ` +
        `${onDecks.landmarks} landmarks on bridge decks, ${onDecks.aside} landmarks with no room there clear of their ways left out`,
    );
    const offWays = moveLandmarksOffWays(features.landmarks ?? [], features.roads, features.rails);
    logger.log(`${offWays.moved} landmarks on roads for vehicles and railways moved off them, ${offWays.aside} with no room beside them left out`);

    // the water's surface level where the elevation model has it uneven, and the waterways through it
    let water: WaterLevels | undefined;
    if (heightAt) {
      try {
        const { response: waterResponse, cached: waterCached } = await overpass(waterwayQuery(fetchBox));
        const lines = parseWaterways(waterResponse.elements, origin);
        water = setWaterLevels(features.areas, lines, heightAt);
        logger.log(
          `${lines.length} OSM waterways (${waterCached ? "cached" : "fetched"}), ${water.waterways.length} stretches of them in the water; ` +
            `${water.still} still waters level, ${water.flowing} flowing ones falling along their waterways, ${water.uneven} left uneven`,
        );
      } catch (err) {
        logger.warn(`warning: no waterways: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const tiles = new Map(cutIntoTiles(features, built, size).map((tile) => [tileName(tile), tile]));
    if (water) {
      cutWaterways(tiles, water.waterways, size);
    }
    if (ground) {
      cutBuildingSteps(tiles, ground.buildingSteps, size);
    }
    const attributions = [OSM_ATTRIBUTION, ...(heightAt ? [ELEVATION_ATTRIBUTION] : []), ...otherAttributions];
    return { info: { origin, tileSize: size, tiles: keys, osmTimestamp, attributions }, tiles, heightAt, ground, water };
  }
}

/** The box around the points */
function geoBoxOf(points: GeoPoint[]): GeoBox {
  return {
    south: Math.min(...points.map((p) => p.latitude)),
    west: Math.min(...points.map((p) => p.longitude)),
    north: Math.max(...points.map((p) => p.latitude)),
    east: Math.max(...points.map((p) => p.longitude)),
  };
}
