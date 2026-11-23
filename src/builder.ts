// Builds the map's tiles from OpenStreetMap and the open data sources, laid out in meters around the origin.
// The first tile asked for builds the whole area: bridges, tunnels and multipolygons reach over tile edges.
import type { SourceCache } from "./cache.ts";
import { elevationAt, ELEVATION_ATTRIBUTION, fetchElevation, toTm35fin, type ElevationGrid } from "./elevation.ts";
import type { Point, Rect } from "./geometry.ts";
import { bounds, elementsWithin, fetchOverpass, mergeOverpass, overpassQuery, type GeoBox, type OsmElement } from "./osm.ts";
import { inGeoBox, LocalProjection, type GeoPoint } from "./projection.ts";
import { cutGroundSteps, Ground, latticed, stepLines } from "./ground.ts";
import { loadLp } from "./lp.ts";
import { ROOF_TOP_SOURCES, type RoofTopSource } from "./roofTops.ts";
import { cutIntoTiles, tileHeights, tileName, tilePieces, tilesCoveringAny, type Tile, type TileKey } from "./tiles.ts";
import { overlaps, TREE_REGISTERS, type TreeRegisterSource } from "./treeRegister.ts";
import { applyOsmEdits, type OsmEdit } from "./edits.ts";
import { cutWaterways } from "./waterways.ts";
import {
  bareStage,
  bedStage,
  coverStage,
  buildingGroundStage,
  buildingHeightStage,
  buildingLookStage,
  deckStage,
  detailStage,
  footfallStage,
  gambrelStage,
  osmWorld,
  pitchStage,
  registerStage,
  roofColourStage,
  spanStage,
  steppedGround,
  streetStage,
  treeStage,
  tunnelStage,
  waterStage,
  type BuildingGround,
  type Decked,
  type Sources,
  type SteppedGround,
  type Tunnelled,
} from "./world.ts";

export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
export const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";

/** Fetch this much around the tiles, so a long road segment crossing a tile corner is not missed. */
const FETCH_MARGIN_M = 50;
/** A source's pieces fetched at once: the public Overpass servers give an address two slots */
const PIECES_AT_ONCE = 2;
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
  /** Every tile that touches this box, or one of these boxes, is part of the map */
  area: GeoBox | GeoBox[];
  tileSizeM: number;
  /**
   * Fetches the sources in pieces, squares of this many tiles a side on a grid from tile 0, 0, each around the map's
   * tiles in it: no request grows with the map, none asks for what is between its parts, and a piece's responses stay
   * cached while the map changes elsewhere. Put together as from one request (mergeOverpass, uniques, elevationAt). By
   * default in one piece around all the tiles.
   */
  fetchPieceTiles?: number;
  /** Where the sources' responses are kept */
  cache: SourceCache;
  /** Fetch the sources again instead of using the cache */
  refresh?: boolean;
  overpassUrl?: string;
  /** Maanmittauslaitos open interfaces: ground heights, bridge decks, roof colours and laser-scanned roofs when set */
  mmlApiKey?: string;
  /** The tree registers to take street and park trees from, of those that cover the area; TREE_REGISTERS by default */
  treeRegisters?: TreeRegisterSource[];
  /** The 3D building parts to take measured roof tops from, of those that cover the area; ROOF_TOP_SOURCES by default */
  roofTops?: RoofTopSource[];
  /** Local edits of the OSM data, not uploaded (yet): applied to what is fetched, new elements to the map's features, entrances and landmarks */
  edits?: OsmEdit[];
  /**
   * Tunnels' floors known at points, from plans or surveys (the height of the way's surface, m, in the elevation
   * model's system, N2000): the tunnel's point nearest each, within a few meters, has that floor, in place of one hung
   * under the ground over it; with a `name`, the nearest point of the tunnels of that name=*
   */
  tunnelFloors?: { at: GeoPoint; floor: number; name?: string }[];
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
  /** The ground with all its layers, where the elevation model is, for the tiles' heights */
  ground: Ground | undefined;
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
    if (options.fetchPieceTiles !== undefined && !(Number.isInteger(options.fetchPieceTiles) && options.fetchPieceTiles > 0)) {
      throw new Error(`invalid fetch piece: ${options.fetchPieceTiles} tiles`);
    }
    const boxes = Array.isArray(options.area) ? options.area : [options.area];
    if (boxes.length === 0) {
      throw new Error("no area");
    }
    const toMeters = (latitude: number, longitude: number) => this.#projection.toMeters({ latitude, longitude });
    this.tiles = tilesCoveringAny(
      boxes.map((box) => bounds([toMeters(box.south, box.west), toMeters(box.south, box.east), toMeters(box.north, box.west), toMeters(box.north, box.east)])),
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
    const { heights, missing } = tileHeights(tile, this.#options.tileSizeM, HEIGHT_STEP_M, built.ground.top);
    if (missing > 0) {
      this.#logger.warn(`warning: tile ${tileName(tile)}: ${missing} height points outside the elevation model got the tile's average`);
    }
    tile.heights = heights;
    return tile;
  }

  /**
   * The ground: the elevation model over the pieces' corners, its points projected on a lattice (TM_LATTICE_M), and
   * the ground corrected where the options say (groundCorrection)
   */
  async #ground(corners: GeoPoint[][], apiKey: string, tellFetched: (what: string, index: number, count: number, cached: boolean) => void): Promise<Ground> {
    const { cache } = this.#options;
    const refresh = this.#options.refresh ?? false;
    const grids: ElevationGrid[] = [];
    let elevationCached = true;
    for (const [index, piece] of corners.entries()) {
      // the corners' TM35FIN box covers the piece's tiles, turned or not
      const tm = piece.map(toTm35fin);
      const { grid, cached } = await fetchElevation(
        {
          minE: Math.min(...tm.map(([e]) => e)),
          minN: Math.min(...tm.map(([, n]) => n)),
          maxE: Math.max(...tm.map(([e]) => e)),
          maxN: Math.max(...tm.map(([, n]) => n)),
        },
        { apiKey, cache, refresh },
      );
      tellFetched("elevation model", index, corners.length, cached);
      grids.push(grid);
      elevationCached &&= cached;
    }
    const cells = grids.reduce((sum, grid) => sum + grid.cols * grid.rows, 0);
    this.#logger.log(
      (grids.length === 1 ? `elevation model ${grids[0].cols} x ${grids[0].rows} cells` : `elevation model in ${grids.length} pieces, ${cells} cells`) +
        ` of ${grids[0].cellSize} m (${elevationCached ? "cached" : "fetched"})`,
    );
    const elevation = elevationAt(grids);
    const toTm = latticed((e, n) => toTm35fin(this.#projection.toGeo([e, n])), this.#options.tileSizeM, TM_LATTICE_M);
    const ground = new Ground((e, n) => elevation(...toTm(e, n)));
    const correction = this.#options.groundCorrection;
    if (correction) {
      ground.lay("levelled", (below) => (e, n) => {
        const height = below(e, n);
        return height === undefined ? height : correction([e, n], height);
      });
    }
    return ground;
  }

  #build(): Promise<Built> {
    this.#built ??= this.#buildArea();
    return this.#built;
  }

  /**
   * The area's tiles and pieces, those to build, and how the stages reach the sources: in pieces, PIECES_AT_ONCE
   * asked at a time, with the local edits applied and kept to the part being built
   */
  #sources(): {
    sources: Sources;
    pieces: { corners: GeoPoint[]; box: GeoBox }[];
    built: TileKey[];
    builtRect: Rect;
    roofTopSources: RoofTopSource[];
    treeSources: TreeRegisterSource[];
    tellFetched: (what: string, index: number, count: number, cached: boolean) => void;
  } {
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
    const pieceTiles = this.#options.fetchPieceTiles;
    // each piece's corners around its tiles, and its box
    const pieces = (pieceTiles === undefined ? [keys] : tilePieces(keys, pieceTiles)).map((piece) => {
      const minX = Math.min(...piece.map((key) => key.x)) * size - FETCH_MARGIN_M;
      const maxX = (Math.max(...piece.map((key) => key.x)) + 1) * size + FETCH_MARGIN_M;
      const minY = Math.min(...piece.map((key) => key.y)) * size - FETCH_MARGIN_M;
      const maxY = (Math.max(...piece.map((key) => key.y)) + 1) * size + FETCH_MARGIN_M;
      const corners = [toGeo([minX, minY]), toGeo([minX, maxY]), toGeo([maxX, minY]), toGeo([maxX, maxY])];
      return { corners, box: geoBoxOf(corners) };
    });
    const covering = (covers?: GeoBox) => pieces.filter(({ box }) => !covers || overlaps(covers, box));
    const roofTopSources = (this.#options.roofTops ?? ROOF_TOP_SOURCES).filter((s) => covering(s.covers).length > 0);
    const treeSources = (this.#options.treeRegisters ?? TREE_REGISTERS).filter((s) => covering(s.covers).length > 0);
    // a request for each piece: six Overpass queries and the building register, with the elevation model also it, the
    // waterways' query and the roof tops; and the tree registers
    const requests =
      pieces.length * (mmlApiKey ? 9 : 7) +
      (mmlApiKey ? roofTopSources.reduce((sum, s) => sum + covering(s.covers).length, 0) : 0) +
      treeSources.reduce((sum, s) => sum + covering(s.covers).length, 0);

    logger.log(
      `${keys.length} tiles of ${size} m: x ${Math.min(...xs)} .. ${Math.max(...xs)}, y ${Math.min(...ys)} .. ${Math.max(...ys)}` +
        (pieces.length > 1 ? `, their sources fetched in ${pieces.length} pieces of up to ${pieceTiles} x ${pieceTiles} tiles, ${requests} requests` : ""),
    );
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
    // a line for each piece fetched, as fetching many takes a while, with how far the requests are
    let answered = 0;
    const tellFetched = (what: string, index: number, count: number, cached: boolean) => {
      answered++;
      if (!cached && count > 1) {
        logger.log(`[${String(Math.floor((answered * 100) / requests)).padStart(3)} %] ${what}: piece ${index + 1} of ${count} fetched`);
      }
    };
    // a source's responses for the pieces of the area it covers, in their order, PIECES_AT_ONCE asked at a time
    const inPieces = async <T>(what: string, fetchPiece: (box: GeoBox) => Promise<{ cached: boolean } & T>, covers?: GeoBox): Promise<{ cached: boolean; pieces: T[] }> => {
      const asked = covering(covers);
      const fetched: ({ cached: boolean } & T)[] = [];
      let next = 0;
      let told = 0;
      let failed = false;
      const askInTurn = async () => {
        while (!failed && next < asked.length) {
          const index = next++;
          try {
            fetched[index] = await fetchPiece(asked[index].box);
          } catch (err) {
            // the other asker stops too, rather than fetching on while the caller goes on
            failed = true;
            throw err;
          }
          if (!failed) {
            tellFetched(what, index, asked.length, fetched[index].cached);
            told++;
          }
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(PIECES_AT_ONCE, asked.length) }, askInTurn));
      } catch (err) {
        // the source's pieces left are not asked: the progress goes past them
        answered += asked.length - told;
        throw err;
      }
      return { cached: fetched.every((f) => f.cached), pieces: fetched };
    };
    const overpass = async (what: string, query: (box: GeoBox) => string, addNew = false, report = addNew) => {
      const asked = await inPieces(what, (box) => fetchOverpass(query(box), { url: overpassUrl, cache, refresh }));
      const fetched = { cached: asked.cached, response: mergeOverpass(asked.pieces.map((p) => p.response)) };
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
    return {
      sources: { cache, refresh, mmlApiKey, origin, overpass, inPieces, near, toMeters, toGeo, uniques },
      pieces,
      built,
      builtRect,
      roofTopSources,
      treeSources,
      tellFetched,
    };
  }

  async #buildArea(): Promise<Built> {
    const { origin, tileSizeM: size, mmlApiKey } = this.#options;
    const logger = this.#logger;
    const keys = this.tiles;
    const { sources, pieces, built, builtRect, roofTopSources, treeSources, tellFetched } = this.#sources();
    const { response, cached } = await sources.overpass("OSM elements", overpassQuery, true);
    const osmTimestamp = response.osm3s?.timestamp_osm_base;
    logger.log(`${response.elements.length} OSM elements (${cached ? "cached, refresh to fetch again" : "fetched"}), data from ${osmTimestamp ?? "?"}`);

    const world = osmWorld(response.elements, origin, logger);
    const attributions = [OSM_ATTRIBUTION];
    // the ground and what is built into it, where the National Land Survey's key gives the elevation model
    const ground = mmlApiKey ? await this.#ground(pieces.map((p) => p.corners), mmlApiKey, tellFetched) : undefined;
    let shaped: { stepped: SteppedGround; tunnelled: Tunnelled; decked: Decked } | undefined;
    if (ground) {
      attributions.push(ELEVATION_ATTRIBUTION);
      bareStage(world, ground, logger);
      const stepped = steppedGround(world, ground, logger);
      const knownFloors = (this.#options.tunnelFloors ?? []).map(({ at, floor, name }) => ({ p: this.#projection.toMeters(at), floor, name }));
      const spanned = spanStage(world, coverStage(world, stepped, logger), logger);
      const tunnelled = tunnelStage(world, spanned, knownFloors, await loadLp(), logger);
      const decked = deckStage(world, tunnelled, logger);
      bedStage(world, tunnelled, decked, logger);
      shaped = { stepped, tunnelled, decked };
    } else {
      logger.log("no MML API key: the tiles get no ground heights");
    }
    pitchStage(world, logger);
    const registered = await registerStage(world, sources, logger);
    attributions.push(...registered.attributions);
    attributions.push(...(await roofColourStage(world, sources, registered, logger)));
    const windowed = buildingLookStage(world, registered, logger);
    await detailStage(world, sources, windowed, logger);
    let buildingGround: BuildingGround | undefined;
    if (shaped) {
      buildingGround = buildingGroundStage(world, shaped.tunnelled, logger);
      attributions.push(...(await buildingHeightStage(world, sources, shaped.tunnelled, buildingGround, roofTopSources, logger)));
    }
    gambrelStage(world, logger);
    // TODO: buildings with entrances on several levels, or steps at the door, stand at the wrong one.
    footfallStage(world, logger);
    attributions.push(...(await treeStage(world, sources, treeSources, logger)));
    streetStage(world, buildingGround?.ground.at("buildings"), shaped?.decked, builtRect, logger);
    const water = buildingGround ? await waterStage(world, sources, buildingGround, logger) : undefined;

    const { features } = world;
    const tiles = new Map(cutIntoTiles(features, built, size).map((tile) => [tileName(tile), tile]));
    if (water) {
      cutWaterways(tiles, water.waterways, size);
    }
    if (shaped && buildingGround) {
      // the retaining walls' steps where the walls stand once opened for the ways through them, as the tiles have them
      const walls = features.barriers.filter((b) => b.kind === "retaining_wall").map((b) => b.line);
      cutGroundSteps(tiles, [...stepLines(shaped.stepped.steps, "high", walls), ...stepLines(buildingGround.steps, "low")], size);
    }
    return { info: { origin, tileSize: size, tiles: keys, osmTimestamp, attributions }, tiles, ground: buildingGround && ground };
  }
}

/**
 * The pieces' register entries as from one request: an entry as many times as in the piece that has it most often
 * (neighbouring pieces' responses have those between them alike, and a register may list one twice), in the order of
 * their JSON, so that it does not hang on the pieces'.
 */
function uniques<T>(pieces: T[][]): T[] {
  if (pieces.length === 1) {
    return pieces[0];
  }
  const most = new Map<string, T[]>();
  for (const piece of pieces) {
    const alike = new Map<string, T[]>();
    for (const item of piece) {
      const key = JSON.stringify(item);
      const items = alike.get(key);
      if (items) {
        items.push(item);
      } else {
        alike.set(key, [item]);
      }
    }
    for (const [key, items] of alike) {
      if (items.length > (most.get(key)?.length ?? 0)) {
        most.set(key, items);
      }
    }
  }
  return [...most].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).flatMap(([, items]) => items);
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
