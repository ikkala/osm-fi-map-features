// Roofs from the National Land Survey's laser scanning (LAZ point clouds thinned to 0.5 points/m², in ETRS-TM35FIN,
// CC BY 4.0), fetched a map sheet of 3 x 3 km at a time from its file service: the height under nearly all the points
// over the ground inside an outline, so that a measured top far over it, a chimney's or a lantern's, can come down
// to the roof, and the shapes fitted to the roof (laserRoofShapes.ts), the shape chosen from them as they are read.
// Only the roofs and their fits are cached, a file per sheet, so maps of different places keep theirs and the choice
// can change without fetching the sheets again.
import type { CacheOptions } from "./cache.ts";
import { distanceToRing, pointInPolygon, type Point, type Polygon } from "./geometry.ts";
import { field, isObject, items, optionalNumber, optionalString } from "./json.ts";
import { fitGambrel, GAMBREL_REACH_M, type GambrelFit } from "./gambrelRoofs.ts";
import { chooseRoofShape, fitRoofShapes, type LaserRoofShape, type RoofFit } from "./laserRoofShapes.ts";
import type { RoofShape } from "./osm.ts";
import { outlineKey } from "./ortho.ts";

export const LASER_ATTRIBUTION = "Laser scanning © Maanmittauslaitos (CC BY 4.0)";

const PROCESS_URL = "https://avoin-paikkatieto.maanmittauslaitos.fi/tiedostopalvelu/ogcproc/v1/processes/laserkeilausaineisto_05_karttalehti";
/** How often (ms) and how many times a job is asked whether it is done */
const JOB_POLL_MS = 2000;
const JOB_POLLS = 300;
/** Points this close (m) to an outline's rings are left out (walls, eaves, misalignment) */
const EDGE_MARGIN_M = 1;
/** Fewer points over the ground than this measure no roof */
const MIN_POINTS = 8;
/** At least this share of an outline's points are over the ground, else the building is newer than the scanning */
const MIN_ABOVE_SHARE = 0.8;
/** The roof is the height under this share of the points over the ground, below what stands on a small part of it */
const ROOF_SHARE = 0.98;
/** LAS classes: ground and water, under no roof */
const GROUND_CLASSES = new Set([2, 9]);
/** LAS classes: noise, left out */
const NOISE_CLASSES = new Set([7, 18]);
/** Outlines are indexed in square cells this big (m) */
const CELL_M = 25;
/** Followed by the sheet, "<sheet>.json" */
const CACHE_PREFIX = "mml-laser-roofs-";
/** Bump when the roofs' computation changes, so cached roofs are computed again */
const CACHE_VERSION = 5;

/** The rows of 1:200 000 sheets from the south, 96 km each from northing 6 570 000 */
const SHEET_ROWS = "KLMNPQRSTUVWX";

/**
 * The 1:5000 map sheet of ETRS-TM35FIN's division a point is in, such as M4212G1: a 1:200 000 sheet of 192 x 96 km
 * (its row and column), halved three times (1 south-west, 2 north-west, 3 south-east, 4 north-east), a 1:10 000
 * sheet of 6 x 6 km in columns of two from the west (A to H), and its quarter.
 */
export function mapSheet(e: number, n: number): string {
  const column = Math.floor((e + 76000) / 192000) + 2;
  const row = Math.floor((n - 6570000) / 96000);
  if (row < 0 || row >= SHEET_ROWS.length || column < 2) {
    throw new Error(`no map sheet at ${e} E, ${n} N`);
  }
  let name = `${SHEET_ROWS[row]}${column}`;
  let minE = (column - 2) * 192000 - 76000;
  let minN = 6570000 + row * 96000;
  const quarter = (width: number, height: number) => {
    const east = e >= minE + width;
    const north = n >= minN + height;
    minE += east ? width : 0;
    minN += north ? height : 0;
    return 1 + (east ? 2 : 0) + (north ? 1 : 0);
  };
  for (const [width, height] of [[96000, 48000], [48000, 24000], [24000, 12000]]) {
    name += quarter(width, height);
  }
  const c = Math.floor((e - minE) / 6000);
  const r = Math.floor((n - minN) / 6000);
  name += "ABCDEFGH"[c * 2 + r];
  minE += c * 6000;
  minN += r * 6000;
  return name + quarter(3000, 3000);
}

/** The roof of an outline from the heights of the points over the ground inside it and how many are on the ground */
export function roofOf(above: number[], ground: number): number | undefined {
  if (above.length < MIN_POINTS || above.length < MIN_ABOVE_SHARE * (above.length + ground)) {
    return undefined;
  }
  const sorted = [...above].sort((a, b) => a - b);
  return sorted[Math.floor(ROOF_SHARE * (sorted.length - 1))];
}

/** The LAZ decoder, made once: each one adds listeners of its own to the process */
let decoder: ReturnType<typeof makeDecoder> | undefined;

async function makeDecoder() {
  const { createLazPerf } = await import("laz-perf");
  return createLazPerf();
}

/** Calls visit with every point of a LAZ file: its easting, northing, height and LAS class */
export async function readLaz(bytes: Uint8Array, visit: (e: number, n: number, z: number, cls: number) => void): Promise<void> {
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "LASF") {
    throw new Error(`not a LAS file: ${new TextDecoder().decode(bytes.subarray(0, 200))}`);
  }
  const [scaleE, scaleN, scaleZ] = [131, 139, 147].map((offset) => header.getFloat64(offset, true));
  const [offsetE, offsetN, offsetZ] = [155, 163, 171].map((offset) => header.getFloat64(offset, true));
  decoder ??= makeDecoder();
  const laz = await decoder;
  const file = laz._malloc(bytes.length);
  laz.HEAPU8.set(bytes, file);
  const reader = new laz.LASZip();
  try {
    reader.open(file, bytes.length);
    const count = reader.getCount();
    const format = reader.getPointFormat();
    const point = laz._malloc(reader.getPointLength());
    // the class byte: in formats 6 and over a whole byte of its own
    const classAt = format >= 6 ? 16 : 15;
    const classMask = format >= 6 ? 0xff : 0x1f;
    for (let i = 0; i < count; i++) {
      reader.getPoint(point);
      const heap = laz.HEAPU8;
      const int32 = (at: number) => heap[point + at] | (heap[point + at + 1] << 8) | (heap[point + at + 2] << 16) | (heap[point + at + 3] << 24);
      visit(int32(0) * scaleE + offsetE, int32(4) * scaleN + offsetN, int32(8) * scaleZ + offsetZ, heap[point + classAt] & classMask);
    }
    laz._free(point);
  } finally {
    reader.delete();
    laz._free(file);
  }
}

/** Times a request the service fails (a 5xx, or no JSON) is made again */
const RETRIES = 3;

/** The JSON the service answers at url, or undefined when it answers none (failing, or a gateway's timeout) */
async function jsonOf(url: string, auth: Record<string, string>): Promise<unknown> {
  try {
    const res = await fetch(url, { headers: { ...auth, accept: "application/json" } });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

function start(sheet: string, auth: Record<string, string>): Promise<Response> {
  return fetch(`${PROCESS_URL}/execution`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      id: "laserkeilausaineisto_05_karttalehti",
      inputs: { mapSheetInput: [sheet], fileFormatInput: "LAZ", dataSetInput: "Uusin" },
    }),
  });
}

/** A sheet's point cloud from the file service, or undefined when it has none for the sheet */
async function fetchSheet(sheet: string, apiKey: string): Promise<Uint8Array | undefined> {
  // Basic Auth with the key as the user name keeps it out of URLs that end up in logs
  const auth = { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` };
  let started = await start(sheet, auth);
  // the service fails now and then: ask again in a moment
  for (let retry = 1; retry <= RETRIES && started.status >= 500; retry++) {
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS * retry));
    started = await start(sheet, auth);
  }
  const job: unknown = await started.json().catch(() => undefined);
  const jobUrl = items(field(job, "links")).map((link) => (field(link, "rel") === "self" ? optionalString(field(link, "href")) : undefined)).find((href) => href);
  if (!started.ok || jobUrl === undefined) {
    throw new Error(`laser scanning request for ${sheet} failed (${started.status}): ${JSON.stringify(job)?.slice(0, 500)}`);
  }
  let status: unknown;
  for (let poll = 0; poll < JOB_POLLS; poll++) {
    // a poll the service answers with no JSON (a gateway's timeout) is polled again
    status = (await jsonOf(jobUrl, auth)) ?? { status: "running" };
    if (field(status, "status") !== "accepted" && field(status, "status") !== "running") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
  }
  const message = optionalString(field(status, "message")) ?? "";
  if (field(status, "status") !== "successful") {
    if (message.startsWith("data not found")) {
      return undefined;
    }
    throw new Error(`laser scanning job for ${sheet} ended ${String(field(status, "status"))}: ${message}`);
  }
  let results = await jsonOf(`${jobUrl}/results`, auth);
  for (let retry = 1; retry <= RETRIES && results === undefined; retry++) {
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS * retry));
    results = await jsonOf(`${jobUrl}/results`, auth);
  }
  const path = items(field(results, "results"))
    .map((result) => optionalString(field(result, "path")))
    .find((href) => href?.endsWith(".laz"));
  if (path === undefined) {
    throw new Error(`laser scanning job for ${sheet} gave no LAZ file: ${JSON.stringify(results).slice(0, 500)}`);
  }
  return download(path, auth, `laser scanning download for ${sheet}`);
}

/** Times a download cut off midway goes on from where it was cut (a Range request) */
const RESUMES = 5;

/**
 * The file at url, a download cut off midway (a proxy that ends long transfers) going on from where it was cut, with
 * Range requests, where the server answers them
 */
export async function download(url: string, headers: Record<string, string>, what: string): Promise<Uint8Array> {
  let res = await fetch(url, { headers });
  for (let retry = 1; retry <= RETRIES && res.status >= 500; retry++) {
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS * retry));
    res = await fetch(url, { headers });
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`${what} failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  const total = Number(res.headers.get("content-length") ?? NaN);
  for (let resume = 0; ; resume++) {
    try {
      const reader = res.body?.getReader();
      for (let read = await reader?.read(); read && !read.done; read = await reader?.read()) {
        chunks.push(read.value);
        received += read.value.length;
      }
      if (Number.isNaN(total) || received >= total) {
        break;
      }
      throw new Error(`${received} of ${total} bytes`);
    } catch (err) {
      if (resume >= RESUMES || received === 0) {
        throw err;
      }
      res = await fetch(url, { headers: { ...headers, range: `bytes=${received}-` } });
      if (res.status !== 206) {
        throw new Error(`${what} was cut off at ${received} bytes and cannot go on (${res.status}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

export interface LaserRoofResult {
  /** The roof (m above sea level) by the index of the outline; missing where the points measured none */
  roofs: Map<number, number>;
  /** The roof's shape by the index of the outline; missing where the points tell none */
  shapes: Map<number, LaserRoofShape>;
  /** Outlines whose roof (or none) came from the cache */
  cached: number;
  /** Sheets fetched */
  fetched: number;
  /** Sheets whose fetch failed, their groups' roofs left out */
  failed: number;
}

/**
 * The roofs of TM35FIN outlines, cached by outline shape in the file of the sheet their box's centre is in (a group),
 * else measured from the sheets their box reaches into, fetched one at a time, a group's together.
 */
export async function fetchLaserRoofs(
  outlines: Polygon[],
  options: CacheOptions & { apiKey: string; log?: (message: string) => void },
): Promise<LaserRoofResult> {
  const keys = outlines.map(outlineKey);
  const boxes = outlines.map((outline) => ringBox(outline.outer));
  const result: LaserRoofResult = { roofs: new Map(), shapes: new Map(), cached: 0, fetched: 0, failed: 0 };
  // the outlines by the sheet their box's centre is in
  const groups = new Map<string, number[]>();
  boxes.forEach((box, index) => {
    const sheet = mapSheet((box.minE + box.maxE) / 2, (box.minN + box.maxN) / 2);
    groups.set(sheet, [...(groups.get(sheet) ?? []), index]);
  });
  const pending: { sheet: string; known: Map<string, Measured | null>; missing: number[]; needs: Set<string> }[] = [];
  for (const [sheet, indices] of groups) {
    const known = await readRoofs(`${CACHE_PREFIX}${sheet}.json`, options);
    const missing = indices.filter((index) => !known.has(keys[index]));
    result.cached += indices.length - missing.length;
    for (const index of indices) {
      const measured = known.get(keys[index]);
      if (measured) {
        result.roofs.set(index, measured.roof);
        const shape = chooseRoofShape(measured.fits, measured.gambrel);
        if (shape) {
          result.shapes.set(index, shape);
        }
      }
    }
    if (missing.length > 0) {
      const needs = new Set(missing.flatMap((index) => cornerSheets(boxes[index])));
      pending.push({ sheet, known, missing, needs });
    }
  }
  // the points over the ground inside each missing outline, and how many on the ground; and those over the ground
  // near it, inside or out, that a gambrel roof is fitted to
  const above = new Map<number, [number, number, number][]>();
  const near = new Map<number, [number, number, number][]>();
  const ground = new Map<number, number>();
  const cells = new Map<string, number[]>();
  const reach = (box: { minE: number; minN: number; maxE: number; maxN: number }) => ({
    minE: box.minE - GAMBREL_REACH_M,
    minN: box.minN - GAMBREL_REACH_M,
    maxE: box.maxE + GAMBREL_REACH_M,
    maxN: box.maxN + GAMBREL_REACH_M,
  });
  for (const { missing } of pending) {
    for (const index of missing) {
      above.set(index, []);
      near.set(index, []);
      ground.set(index, 0);
      const box = reach(boxes[index]);
      for (let x = Math.floor(box.minE / CELL_M); x <= Math.floor(box.maxE / CELL_M); x++) {
        for (let y = Math.floor(box.minN / CELL_M); y <= Math.floor(box.maxN / CELL_M); y++) {
          cells.set(`${x}_${y}`, [...(cells.get(`${x}_${y}`) ?? []), index]);
        }
      }
    }
  }
  // a group's sheets at a time, so that each group's roofs are cached as soon as can be and an interrupted import
  // fetches few sheets again; a sheet that fails leaves out only the groups needing it, to be fetched another time
  pending.sort((a, b) => (a.sheet < b.sheet ? -1 : a.sheet > b.sheet ? 1 : 0));
  const done = new Set<string>();
  const failed = new Set<string>();
  const next = () => pending.flatMap(({ needs }) => [...needs].sort()).find((sheet) => !done.has(sheet) && !failed.has(sheet));
  for (let sheet = next(); sheet !== undefined; sheet = next()) {
    const waiting = pending.filter(({ needs }) => needs.has(sheet)).reduce((sum, { missing }) => sum + missing.length, 0);
    options.log?.(`fetching the laser scanning of sheet ${sheet} for up to ${waiting} roofs`);
    let bytes: Uint8Array | undefined;
    try {
      bytes = await fetchSheet(sheet, options.apiKey);
    } catch (err) {
      failed.add(sheet);
      options.log?.(`the laser scanning of sheet ${sheet} failed, its roofs left out: ${err instanceof Error ? err.message : String(err)}`);
      for (const group of pending.filter(({ needs }) => needs.has(sheet))) {
        group.missing.forEach((index) => {
          above.delete(index);
          near.delete(index);
        });
        pending.splice(pending.indexOf(group), 1);
      }
      continue;
    }
    result.fetched++;
    if (bytes !== undefined) {
      await readLaz(bytes, (e, n, z, cls) => {
        if (NOISE_CLASSES.has(cls)) {
          return;
        }
        const p: Point = [e, n];
        for (const index of cells.get(`${Math.floor(e / CELL_M)}_${Math.floor(n / CELL_M)}`) ?? []) {
          const box = reach(boxes[index]);
          const outline = outlines[index];
          if (e < box.minE || e > box.maxE || n < box.minN || n > box.maxN) {
            continue;
          }
          const inside = pointInPolygon(p, outline);
          const edge = Math.min(...[outline.outer, ...outline.holes].map((ring) => distanceToRing(p, ring)));
          if (!GROUND_CLASSES.has(cls) && (inside || edge <= GAMBREL_REACH_M)) {
            near.get(index)?.push([e, n, z]);
          }
          if (!inside || edge < EDGE_MARGIN_M) {
            continue;
          }
          if (GROUND_CLASSES.has(cls)) {
            ground.set(index, (ground.get(index) ?? 0) + 1);
          } else {
            above.get(index)?.push([e, n, z]);
          }
        }
      });
    }
    done.add(sheet);
    // each group's roofs once all the points they need are in, so an interrupted import does not fetch them again
    for (const group of pending.filter(({ needs }) => [...needs].every((s) => done.has(s)))) {
      for (const index of group.missing) {
        const points = above.get(index) ?? [];
        const roof = roofOf(points.map(([, , z]) => z), ground.get(index) ?? 0);
        let fits: RoofFit[] = [];
        let gambrel: GambrelFit | undefined;
        try {
          fits = roof === undefined ? [] : fitRoofShapes(points, outlines[index]);
          gambrel = roof === undefined ? undefined : fitGambrel(near.get(index) ?? [], outlines[index]);
        } catch (err) {
          // one outline's shapes failing leaves out only its shape
          options.log?.(`the roof shapes of an outline in sheet ${group.sheet} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        const shape = chooseRoofShape(fits, gambrel);
        group.known.set(keys[index], roof === undefined ? null : { roof, fits, ...(gambrel && { gambrel }) });
        if (roof !== undefined) {
          result.roofs.set(index, roof);
          if (shape) {
            result.shapes.set(index, shape);
          }
        }
        above.delete(index);
        near.delete(index);
      }
      const rows = [...group.known].map(([key, measured]) => [
        key,
        measured && (measured.fits.length > 0 || measured.gambrel ? [measured.roof, ...measured.fits.flatMap(fitRow), ...(measured.gambrel ? gambrelRow(measured.gambrel) : [])] : measured.roof),
      ]);
      await options.cache.put(`${CACHE_PREFIX}${group.sheet}.json`, JSON.stringify({ version: CACHE_VERSION, roofs: Object.fromEntries(rows) }));
      pending.splice(pending.indexOf(group), 1);
    }
  }
  result.failed = failed.size;
  return result;
}

/** An outline's roof (m above sea level) and the shapes fitted to its points */
interface Measured {
  roof: number;
  fits: RoofFit[];
  gambrel?: GambrelFit;
}

const SHAPES: readonly (RoofShape | "flat")[] = ["flat", "gabled", "hipped", "pyramidal", "skillion"];
/** Values of a fit in the cache's rows */
const FIT_LENGTH = 6;

/**
 * A fit as the cache keeps it: its shape's name, angle, rise, top, miss and slope; a roof of wings' name ends in
 * "-wings", its way of cutting in place of the angle
 */
function fitRow(fit: RoofFit): (string | number)[] {
  const name = fit.shape ?? "flat";
  return fit.wings === undefined ? [name, fit.angle, fit.rise, fit.top, fit.miss, fit.slope] : [`${name}-wings`, fit.wings, fit.rise, fit.top, fit.miss, fit.slope];
}

/** The values of a gambrel roof's fit in the cache's rows, after its name */
const GAMBREL_FIELDS = ["angle", "offset", "knee", "rise", "top", "slope", "lowerSlope", "miss", "lowerMiss", "gabledLowerMiss", "lowerPoints"] as const;

/** A gambrel roof's fit as the cache keeps it: "gambrel" and its GAMBREL_FIELDS */
function gambrelRow(fit: GambrelFit): (string | number)[] {
  return ["gambrel", ...GAMBREL_FIELDS.map((name) => fit[name])];
}

function parseGambrel(row: unknown[]): GambrelFit | undefined {
  const values = row.slice(1).map(optionalNumber);
  const value = (name: (typeof GAMBREL_FIELDS)[number]) => values[GAMBREL_FIELDS.indexOf(name)];
  const [angle, offset, knee, rise, top, slope, lowerSlope, miss, lowerMiss, gabledLowerMiss, lowerPoints] = GAMBREL_FIELDS.map(value);
  if (
    angle === undefined ||
    offset === undefined ||
    knee === undefined ||
    rise === undefined ||
    top === undefined ||
    slope === undefined ||
    lowerSlope === undefined ||
    miss === undefined ||
    lowerMiss === undefined ||
    gabledLowerMiss === undefined ||
    lowerPoints === undefined
  ) {
    return undefined;
  }
  return { angle, offset, knee, rise, top, slope, lowerSlope, miss, lowerMiss, gabledLowerMiss, lowerPoints };
}

function parseFit(row: unknown[]): RoofFit | undefined {
  const text = typeof row[0] === "string" ? row[0] : "";
  const wings = text.endsWith("-wings");
  const name = SHAPES.find((s) => s === (wings ? text.slice(0, -"-wings".length) : text));
  const [angle, rise, top, miss, slope] = row.slice(1).map(optionalNumber);
  if (name === undefined || angle === undefined || rise === undefined || top === undefined || miss === undefined || slope === undefined) {
    return undefined;
  }
  const shape = name !== "flat" && { shape: name };
  return wings ? { ...shape, angle: 0, rise, top, miss, slope, wings: angle } : { ...shape, angle, rise, top, miss, slope };
}

/**
 * The roofs cached under the key, by outline: its height, or a list of it and its fits' rows (fitRow); null for
 * one the points measured none of. None with `refresh`.
 */
async function readRoofs(key: string, options: CacheOptions): Promise<Map<string, Measured | null>> {
  const known = new Map<string, Measured | null>();
  const text = options.refresh ? undefined : await options.cache.get(key);
  if (text !== undefined) {
    const json: unknown = JSON.parse(text);
    const roofs = field(json, "roofs");
    if (field(json, "version") === CACHE_VERSION && isObject(roofs)) {
      for (const [outline, roof] of Object.entries(roofs)) {
        if (typeof roof === "number" || roof === null) {
          known.set(outline, roof === null ? null : { roof, fits: [] });
        } else if (Array.isArray(roof) && typeof roof[0] === "number") {
          const fits: RoofFit[] = [];
          let gambrel: GambrelFit | undefined;
          for (let at = 1; at < roof.length; ) {
            if (roof[at] === "gambrel") {
              gambrel = parseGambrel(roof.slice(at, at + 1 + GAMBREL_FIELDS.length));
              at += 1 + GAMBREL_FIELDS.length;
              continue;
            }
            const fit = at + FIT_LENGTH <= roof.length ? parseFit(roof.slice(at, at + FIT_LENGTH)) : undefined;
            if (fit) {
              fits.push(fit);
            }
            at += FIT_LENGTH;
          }
          known.set(outline, { roof: roof[0], fits, ...(gambrel && { gambrel }) });
        }
      }
    }
  }
  return known;
}

/** The sheets a box's corners are in: all it reaches into, as a building is far smaller than a sheet */
function cornerSheets(box: { minE: number; minN: number; maxE: number; maxN: number }): string[] {
  return [...new Set([mapSheet(box.minE, box.minN), mapSheet(box.minE, box.maxN), mapSheet(box.maxE, box.minN), mapSheet(box.maxE, box.maxN)])];
}

function ringBox(ring: Point[]): { minE: number; minN: number; maxE: number; maxN: number } {
  const es = ring.map(([e]) => e);
  const ns = ring.map(([, n]) => n);
  return { minE: Math.min(...es), minN: Math.min(...ns), maxE: Math.max(...es), maxN: Math.max(...ns) };
}
