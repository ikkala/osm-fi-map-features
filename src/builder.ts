// Builds the map a tile at a time from the sources, which stay apart in the SourceCache.
//
// The OpenStreetMap roads, rails, buildings (with the businesses in them), trees, street lamps and ground areas
// around the area (from an Overpass API server) are laid out in meters around the origin. With an MML API key they get ground heights and
// bridge decks from the Maanmittauslaitos elevation model and roof colours from its orthophoto; in
// Tampere, storeys and wall materials from the city's building register, street and park trees from
// its tree register and pedestrian counts from its counts. The ways get the people walking on them
// (footfall.ts). Every tile touching the area can be built.
//
// For now the first tile asked for builds the whole area and the rest come from memory: bridge spans,
// tunnels in cuts and multipolygons reach over tile edges, so they are worked out over the whole area.
import type { SourceCache } from "./cache.ts";
import { MAX_PLINTH_M, setBuildingBases } from "./bases.ts";
import { setBridgeDecks } from "./bridges.ts";
import { businessQuery, parseBusinesses, placeBusinesses } from "./businesses.ts";
import { coverCutTunnels } from "./cuts.ts";
import { ELEVATION_ATTRIBUTION, fetchElevation, sampleElevation, toTm35fin } from "./elevation.ts";
import { assignEntrances, entranceQuery, guessEntrances, parseEntrances } from "./entrances.ts";
import { estimateFootfall, type FootfallCount } from "./footfall.ts";
import { mergeTrees, plantForests } from "./forests.ts";
import { simplifyLine, type Point } from "./geometry.ts";
import { placeLamps } from "./lamps.ts";
import { fetchRoofColours, ORTHO_ATTRIBUTION } from "./ortho.ts";
import { bounds, fetchOverpass, overpassQuery, parseOsm, type GeoBox } from "./osm.ts";
import { LocalProjection, type GeoPoint } from "./projection.ts";
import {
  applyRegister,
  fetchCounts,
  fetchRegister,
  fetchTreeRegister,
  TAMPERE_ATTRIBUTION,
  TAMPERE_COUNTS_ATTRIBUTION,
  TAMPERE_TREES_ATTRIBUTION,
} from "./tampere.ts";
import { cutIntoTiles, tileHeights, tileName, tilesCovering, type Tile, type TileKey } from "./tiles.ts";
import { setTrackBeds } from "./trackbeds.ts";
import { setTunnelFloors, uncoverAtGrade } from "./tunnels.ts";
import { assignWindows } from "./windows.ts";

export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
export const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";

/** Fetch this much around the tiles, so a long road segment crossing a tile corner is not missed. */
const FETCH_MARGIN_M = 50;
/** Roads and rails are simplified to this many meters */
const LINE_TOLERANCE_M = 0.3;
/** Ground height grid spacing; the elevation model has 2 m cells */
const HEIGHT_STEP_M = 2;

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
    if (!tile || !built.heightAt || tile.heights) {
      return tile;
    }
    const { heights, missing } = tileHeights(tile, this.#options.tileSizeM, HEIGHT_STEP_M, built.heightAt);
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

    const { features, warnings } = parseOsm(response.elements, origin);
    for (const warning of warnings) {
      logger.warn(`warning: ${warning}`);
    }
    // every line point costs something to draw, so drop the ones that barely bend the line
    for (const feature of [...features.roads, ...features.rails]) {
      feature.line = simplifyLine(feature.line, LINE_TOLERANCE_M);
    }
    let heightAt: ((e: number, n: number) => number | undefined) | undefined;
    if (mmlApiKey) {
      // the elevation model over the tiles (the corners' TM35FIN box covers them, turned or not)
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
      heightAt = (e: number, n: number) => sampleElevation(grid, ...toTm35fin(toGeo([e, n])));
      // tunnels in cuts first: the ways over them become bridges
      const covered = coverCutTunnels(features, heightAt);
      logger.log(`${covered.tunnels} tunnels in cuts get lids, ${covered.crossings} ways over them become bridges`);
      logger.log(`${uncoverAtGrade(features, heightAt)} tunnels run at the ground under buildings`);
      const tunnels = setTunnelFloors(features, heightAt);
      logger.log(`${tunnels.floors} tunnel ways under hills and lakes get floors, ${tunnels.ramps} ways out of their portals ramps`);
      // before cutting into tiles, so a bridge's deck goes from end to end
      const ramps = (lines: { bridge: boolean; deck?: number[] }[]) => lines.filter((l) => l.deck && !l.bridge).length;
      setBridgeDecks(features.roads, heightAt);
      setBridgeDecks(features.rails, heightAt);
      logger.log(`${ramps(features.roads) + ramps(features.rails)} bridge approaches raised out of the hollows under bridges`);
      // after the decks: the railways end at their bridges' and approaches' heights
      logger.log(`${setTrackBeds(features.rails, heightAt)} railway lines get smoothed track beds`);
    } else {
      logger.log("no MML API key: the tiles get no ground heights");
    }

    // storeys and wall materials from the City of Tampere's building register (empty outside Tampere)
    const otherAttributions: string[] = [];
    try {
      const { buildings: register, cached: registerCached } = await fetchRegister(fetchBox, { cache, refresh });
      const match = applyRegister(features.buildings, register, (r) => toMeters(r.latitude, r.longitude));
      logger.log(
        `Tampere building register: ${register.length} buildings (${registerCached ? "cached" : "fetched"}), ` +
          `${match.heights} heights and ${match.materials} wall materials set, ${match.unmatched} inside no OSM building`,
      );
      if (match.heights + match.materials > 0) {
        otherAttributions.push(TAMPERE_ATTRIBUTION);
      }
    } catch (err) {
      logger.warn(`warning: no building register data: ${err instanceof Error ? err.message : String(err)}`);
    }
    // roof colours from the orthophoto, for the drawn roofs OSM has no roof:colour for
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
    // TODO: measure the buildings whose height is still a guess (and the roof shapes OSM does not have) from
    // Maanmittauslaitos laser scanning. Its 3D buildings (LoD2) do not cover Tampere yet, and its WCS has no
    // surface model, but the open point cloud does: the file service's OGC API process
    // laserkeilausaineisto_05_karttalehti (dataSetInput "05p_2020-", LAZ, the MML API key) has Tampere's summer
    // 2023 scanning at 0.5 points/m², ~60 MB per 3 x 3 km map sheet (the centre is M4212G3). The points inside
    // an outline minus the elevation model give its height (a high percentile, so chimneys do not count) and
    // the roof's profile. Mind trees over roofs and buildings newer than the scanning.
    const estimated = features.buildings.filter((b) => b.heightEstimated && !b.hasParts).length;
    logger.log(`${estimated} buildings have a height estimated from their type and floor area`);
    // after the register, which tells the use of a building=yes
    const windowed = assignWindows(features.buildings);
    logger.log(`${windowed} of ${features.buildings.filter((b) => !b.hasParts).length} buildings get windows`);
    // entrances from OSM, and guessed doors for the ordinary buildings (with windows) without any
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
    // shops, restaurants, offices, ... in the buildings, after the entrances they show at
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
      const based = setBuildingBases(features.buildings, heightAt, lids);
      logger.log(`${based} buildings stand at their OSM entrance or highest ground (at most ${MAX_PLINTH_M} m above their lowest)`);
    }
    // TODO: entrances that are steps up or down from the street, and buildings with entrances on several
    // floors (a slope with an entrance at each level), stand at the wrong one.

    // people walking on the ways, after the businesses and doors that draw them: counted in Tampere (the
    // counts are empty elsewhere), estimated elsewhere
    let counts: FootfallCount[] = [];
    try {
      const { counts: register, cached: countsCached } = await fetchCounts(fetchBox, { cache, refresh });
      counts = register.map(({ latitude, longitude, ...count }) => ({ point: toMeters(latitude, longitude), ...count }));
      logger.log(`Tampere pedestrian counts: ${counts.length} current counts along ways (${countsCached ? "cached" : "fetched"})`);
    } catch (err) {
      logger.warn(`warning: no pedestrian counts: ${err instanceof Error ? err.message : String(err)}`);
    }
    const footfall = estimateFootfall(features.roads, features.buildings, counts);
    logger.log(
      `footfall on ${footfall.ways} ways (${footfall.separate} streets with their sidewalks drawn apart get none); ` +
        `${footfall.matched} of ${footfall.counts} counts on a way, the estimate ${footfall.model.base} + ${footfall.model.scale} × draw ` +
        `within a factor of two of ${Math.round(footfall.withinTwo * 100)} % of them`,
    );
    if (footfall.matched > 0) {
      otherAttributions.push(TAMPERE_COUNTS_ATTRIBUTION);
    }

    // street and park trees from the city's register (empty outside Tampere), OSM's trees where it has none
    // of its own, and trees planted in woods and scrub
    const osmTrees = features.trees.length;
    try {
      const { trees: register, cached: treesCached } = await fetchTreeRegister(fetchBox, { cache, refresh });
      features.trees = mergeTrees(
        register.map(({ latitude, longitude, ...tree }) => ({ point: toMeters(latitude, longitude), ...tree })),
        features.trees,
      );
      logger.log(
        `Tampere tree register: ${register.length} trees and shrubs (${treesCached ? "cached" : "fetched"}), ` +
          `${osmTrees - (features.trees.length - register.length)} of ${osmTrees} OSM trees at a register tree`,
      );
      if (register.length > 0) {
        otherAttributions.push(TAMPERE_TREES_ATTRIBUTION);
      }
    } catch (err) {
      logger.warn(`warning: no tree register data: ${err instanceof Error ? err.message : String(err)}`);
    }
    // after the decks, which lamps on bridges stand on
    const lamps = placeLamps(features.lamps, features.roads);
    logger.log(
      `${features.lamps.length} street lamps: ${lamps.heights} with heights and ${lamps.facing} facing guessed from the street ` +
        `next to them, ${lamps.onDecks} on bridges`,
    );
    const tilesRect = { minX: Math.min(...xs) * size, minY: Math.min(...ys) * size, maxX: (Math.max(...xs) + 1) * size, maxY: (Math.max(...ys) + 1) * size };
    const planted = plantForests(features, tilesRect);
    logger.log(`${planted} trees and shrubs planted in woods and scrub`);

    const tiles = new Map(cutIntoTiles(features, keys, size).map((tile) => [tileName(tile), tile]));
    const attributions = [OSM_ATTRIBUTION, ...(heightAt ? [ELEVATION_ATTRIBUTION] : []), ...otherAttributions];
    return { info: { origin, tileSize: size, tiles: keys, osmTimestamp, attributions }, tiles, heightAt };
  }
}
