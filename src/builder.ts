// Builds the map's tiles from OpenStreetMap and the open data sources, laid out in meters around the origin.
// The first tile asked for builds the whole area: bridges, tunnels and multipolygons reach over tile edges.
import type { SourceCache } from "./cache.ts";
import { applyAges } from "./ages.ts";
import { applyRegister, BUILDING_REGISTER_ATTRIBUTION, fetchBuildingRegister } from "./buildingRegister.ts";
import { openBarriers } from "./barriers.ts";
import { MAX_PLINTH_M, setBuildingBases } from "./bases.ts";
import { setBridgeDecks } from "./bridges.ts";
import { setOutlineDecks, standOnDecks } from "./decks.ts";
import { businessQuery, parseBusinesses, placeBusinesses } from "./businesses.ts";
import { coverCutTunnels } from "./cuts.ts";
import { ELEVATION_ATTRIBUTION, fetchElevation, sampleElevation, toTm35fin, type ElevationGrid } from "./elevation.ts";
import { assignEntrances, entranceQuery, guessEntrances, parseEntrances } from "./entrances.ts";
import { estimateCycling, estimateFootfall } from "./footfall.ts";
import { mergeTrees, plantForests } from "./forests.ts";
import { pointKey, simplifyLine, type Point } from "./geometry.ts";
import { placeLamps } from "./lamps.ts";
import { fetchRoofColours, ORTHO_ATTRIBUTION } from "./ortho.ts";
import { bounds, fetchOverpass, LEVEL_HEIGHT_M, openDoorways, overpassQuery, parseOsm, type Building, type GeoBox } from "./osm.ts";
import { LocalProjection, type GeoPoint } from "./projection.ts";
import { placeStreetNodes } from "./streets.ts";
import { cutIntoTiles, latticeProjection, tileHeights, tileName, tilesCovering, type Tile, type TileKey } from "./tiles.ts";
import { setTrackBeds } from "./trackbeds.ts";
import { setTunnelFloors, uncoverAtGrade } from "./tunnels.ts";
import { fetchTreeRegister, overlaps, TREE_REGISTERS, type RegisterTree, type TreeRegisterSource } from "./treeRegister.ts";
import { assignWindows } from "./windows.ts";

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
  /** The elevation model and where a point (m) is in its coordinates, for the tiles' heights */
  ground: { grid: ElevationGrid; toTm: (e: number, n: number) => [number, number] } | undefined;
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
    const { grid, toTm } = built.ground;
    const at = latticeProjection(tile, this.#options.tileSizeM, TM_LATTICE_M, toTm);
    const { heights, missing } = tileHeights(tile, this.#options.tileSizeM, HEIGHT_STEP_M, (e, n) => sampleElevation(grid, ...at(e, n)));
    if (missing > 0) {
      this.#logger.warn(`warning: tile ${tileName(tile)}: ${missing} height points outside the elevation model got the tile's average`);
    }
    tile.heights = heights;
    return tile;
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
    const fetchBox: GeoBox = {
      south: Math.min(...corners.map((c) => c.latitude)),
      west: Math.min(...corners.map((c) => c.longitude)),
      north: Math.max(...corners.map((c) => c.latitude)),
      east: Math.max(...corners.map((c) => c.longitude)),
    };

    logger.log(`${keys.length} tiles of ${size} m: x ${Math.min(...xs)} .. ${Math.max(...xs)}, y ${Math.min(...ys)} .. ${Math.max(...ys)}`);
    const { response, cached } = await fetchOverpass(overpassQuery(fetchBox), { url: overpassUrl, cache, refresh });
    const osmTimestamp = response.osm3s?.timestamp_osm_base;
    logger.log(`${response.elements.length} OSM elements (${cached ? "cached, refresh to fetch again" : "fetched"}), data from ${osmTimestamp ?? "?"}`);

    const { features, streetNodes, bridgeOutlines, warnings, levels, covered } = parseOsm(response.elements, origin);
    for (const warning of warnings) {
      logger.warn(`warning: ${warning}`);
    }
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
      heightAt = (e: number, n: number) => sampleElevation(grid, ...toTm(e, n));
      ground = { grid, toTm };
      // tunnels in cuts first: the ways over them become bridges
      const covered = coverCutTunnels(features, heightAt);
      logger.log(`${covered.tunnels} tunnels in cuts get lids, ${covered.crossings} ways over them become bridges`);
      logger.log(`${uncoverAtGrade(features, heightAt)} tunnels run at the ground under buildings`);
      const tunnels = setTunnelFloors(features, heightAt, levels);
      logger.log(`${tunnels.floors} tunnel ways under hills and lakes get floors, ${tunnels.ramps} ways out of their portals ramps`);
      // before cutting into tiles, so a bridge's deck goes from end to end
      const ramps = (lines: { bridge: boolean; deck?: number[] }[]) => lines.filter((l) => l.deck && !l.bridge).length;
      setBridgeDecks(features.roads, heightAt);
      setBridgeDecks(features.rails, heightAt);
      logger.log(`${ramps(features.roads) + ramps(features.rails)} bridge approaches raised out of the hollows under bridges`);
      const outlined = setOutlineDecks(bridgeOutlines, [...features.roads, ...features.rails]);
      features.bridgeDecks = outlined.decks;
      logger.log(`${bridgeOutlines.length} bridge outlines, ${new Set(outlined.decks.map((d) => d.osm)).size} with decks for the ${outlined.ways} ways on them`);
      // after the decks: the railways end at their bridges' and approaches' heights
      logger.log(`${setTrackBeds(features.rails, heightAt)} railway lines get smoothed track beds`);
    } else {
      logger.log("no MML API key: the tiles get no ground heights");
    }

    const otherAttributions: string[] = [];
    try {
      const { buildings: register, cached: registerCached } = await fetchBuildingRegister(fetchBox, { cache, refresh });
      const match = applyRegister(features.buildings, register, (r) => toMeters(r.latitude, r.longitude));
      logger.log(
        `building register: ${register.length} buildings (${registerCached ? "cached" : "fetched"}), ` +
          `${match.heights} heights and ${match.materials} wall materials set, ${match.unmatched} inside no OSM building`,
      );
      if (match.matched > 0) {
        otherAttributions.push(BUILDING_REGISTER_ATTRIBUTION);
      }
    } catch (err) {
      logger.warn(`warning: no building register data: ${err instanceof Error ? err.message : String(err)}`);
    }
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
    const dated = features.buildings.filter((b) => b.year !== undefined && !b.hasParts).length;
    logger.log(`${dated} buildings have a year, ${aged} old ones with storeys taller than ${LEVEL_HEIGHT_M} m`);
    const estimated = features.buildings.filter((b) => b.heightEstimated && !b.hasParts).length;
    logger.log(`${estimated} buildings have a height estimated from their type and floor area`);
    // after the register, which tells the use of a building=yes
    const windowed = assignWindows(features.buildings);
    logger.log(`${windowed} of ${features.buildings.filter((b) => !b.hasParts).length} buildings get windows`);
    // OSM entrances, and guessed doors for buildings with windows but none
    try {
      const { response: entranceResponse, cached: entrancesCached } = await fetchOverpass(entranceQuery(fetchBox), { url: overpassUrl, cache, refresh });
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
      const { response: businessResponse, cached: businessesCached } = await fetchOverpass(businessQuery(fetchBox), { url: overpassUrl, cache, refresh });
      const businesses = parseBusinesses(businessResponse.elements, origin);
      const placed = placeBusinesses(features.buildings, businesses, features.roads);
      logger.log(
        `${businesses.length} OSM businesses (${businessesCached ? "cached" : "fetched"}), ${placed.placed} in a building, ` +
          `${placed.fronts} of them showing on a wall (${placed.atDoors} at their door)`,
      );
    } catch (err) {
      logger.warn(`warning: no businesses: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (heightAt) {
      const lids = [...features.roads, ...features.rails].flatMap((w) => (w.lid ? [{ line: w.line, lid: w.lid }] : []));
      const raised: Building[] = [];
      const based = setBuildingBases(features.buildings, heightAt, lids, raised);
      logger.log(`${based} buildings stand at their OSM entrance or highest ground (at most ${MAX_PLINTH_M} m above their lowest)`);
      // buildings raised to a door up a slope are stair halls: open them where covered ways come in
      const openings = openDoorways(raised, covered, heightAt);
      logger.log(`${raised.length} buildings raised over a door up a slope, ${openings} openings where covered ways come in at their doors`);
    }
    // TODO: buildings with entrances on several levels, or steps at the door, stand at the wrong one.

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
        registerTrees.push(...trees);
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
    // after the decks, which lamps on bridges stand on
    const lamps = placeLamps(features.lamps, features.roads);
    logger.log(
      `${features.lamps.length} street lamps: ${lamps.heights} with heights and ${lamps.facing} facing guessed from the street ` +
        `next to them, ${lamps.onDecks} on bridges`,
    );
    // after the decks too; the gates before the barriers, which open for them
    const { dropped } = placeStreetNodes(streetNodes, features);
    const openings = openBarriers(features);
    logger.log(
      `${features.crossings.length} crossings, ${features.signals.length} traffic signals and ${features.gates.length} gates on their ways ` +
        `(${dropped} on none left out); ${openings} openings cut into fences and walls, in ${features.barriers.length} pieces`,
    );
    const tilesRect = { minX: Math.min(...xs) * size, minY: Math.min(...ys) * size, maxX: (Math.max(...xs) + 1) * size, maxY: (Math.max(...ys) + 1) * size };
    const planted = plantForests(features, tilesRect);
    logger.log(`${planted} trees and shrubs planted in woods and scrub`);
    const onDecks = standOnDecks(features.bridgeDecks, features.trees, features.lamps);
    logger.log(`${onDecks.trees} trees and ${onDecks.lamps} more street lamps on bridge decks`);

    const tiles = new Map(cutIntoTiles(features, keys, size).map((tile) => [tileName(tile), tile]));
    const attributions = [OSM_ATTRIBUTION, ...(heightAt ? [ELEVATION_ATTRIBUTION] : []), ...otherAttributions];
    return { info: { origin, tileSize: size, tiles: keys, osmTimestamp, attributions }, tiles, heightAt, ground };
  }
}
