// Roofs from the National Land Survey's laser scanning (LAZ point clouds thinned to 0.5 points/m², in ETRS-TM35FIN,
// CC BY 4.0), fetched a map sheet of 3 x 3 km at a time from its file service: the height under nearly all the points
// over the ground inside an outline, so that a measured top far over it, a chimney's or a lantern's, can come down
// to the roof. Only the roofs are cached, a file per sheet, so maps of different places keep theirs.
import type { CacheOptions } from "./cache.ts";
import { distanceToRing, pointInPolygon, type Point, type Polygon } from "./geometry.ts";
import { field, isObject, items, optionalString } from "./json.ts";
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
const CACHE_VERSION = 1;

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

/** A sheet's point cloud from the file service, or undefined when it has none for the sheet */
async function fetchSheet(sheet: string, apiKey: string): Promise<Uint8Array | undefined> {
  // Basic Auth with the key as the user name keeps it out of URLs that end up in logs
  const auth = { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` };
  const started = await fetch(`${PROCESS_URL}/execution`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      id: "laserkeilausaineisto_05_karttalehti",
      inputs: { mapSheetInput: [sheet], fileFormatInput: "LAZ", dataSetInput: "Uusin" },
    }),
  });
  const job: unknown = await started.json().catch(() => undefined);
  const jobUrl = items(field(job, "links")).map((link) => (field(link, "rel") === "self" ? optionalString(field(link, "href")) : undefined)).find((href) => href);
  if (!started.ok || jobUrl === undefined) {
    throw new Error(`laser scanning request for ${sheet} failed (${started.status}): ${JSON.stringify(job)?.slice(0, 500)}`);
  }
  let status: unknown;
  for (let poll = 0; poll < JOB_POLLS; poll++) {
    status = await (await fetch(jobUrl, { headers: { ...auth, accept: "application/json" } })).json();
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
  const results: unknown = await (await fetch(`${jobUrl}/results`, { headers: { ...auth, accept: "application/json" } })).json();
  const path = items(field(results, "results"))
    .map((result) => optionalString(field(result, "path")))
    .find((href) => href?.endsWith(".laz"));
  if (path === undefined) {
    throw new Error(`laser scanning job for ${sheet} gave no LAZ file: ${JSON.stringify(results).slice(0, 500)}`);
  }
  const res = await fetch(path, { headers: auth });
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    throw new Error(`laser scanning download for ${sheet} failed (${res.status}): ${new TextDecoder().decode(bytes.subarray(0, 500))}`);
  }
  return bytes;
}

export interface LaserRoofResult {
  /** The roof (m above sea level) by the index of the outline; missing where the points measured none */
  roofs: Map<number, number>;
  /** Outlines whose roof (or none) came from the cache */
  cached: number;
  /** Sheets fetched */
  fetched: number;
}

/**
 * The roofs of TM35FIN outlines, cached by outline shape in the file of the sheet their box's centre is in, else
 * measured from the sheets their box reaches into, fetched one at a time.
 */
export async function fetchLaserRoofs(
  outlines: Polygon[],
  options: CacheOptions & { apiKey: string; log?: (message: string) => void },
): Promise<LaserRoofResult> {
  const keys = outlines.map(outlineKey);
  const boxes = outlines.map((outline) => ringBox(outline.outer));
  const result: LaserRoofResult = { roofs: new Map(), cached: 0, fetched: 0 };
  // the outlines by the sheet their box's centre is in
  const groups = new Map<string, number[]>();
  boxes.forEach((box, index) => {
    const sheet = mapSheet((box.minE + box.maxE) / 2, (box.minN + box.maxN) / 2);
    groups.set(sheet, [...(groups.get(sheet) ?? []), index]);
  });
  const pending: { sheet: string; known: Map<string, number | null>; missing: number[]; needs: Set<string> }[] = [];
  for (const [sheet, indices] of groups) {
    const known = await readRoofs(`${CACHE_PREFIX}${sheet}.json`, options);
    const missing = indices.filter((index) => !known.has(keys[index]));
    result.cached += indices.length - missing.length;
    for (const index of indices) {
      const roof = known.get(keys[index]);
      if (roof !== undefined && roof !== null) {
        result.roofs.set(index, roof);
      }
    }
    if (missing.length > 0) {
      const needs = new Set(missing.flatMap((index) => cornerSheets(boxes[index])));
      pending.push({ sheet, known, missing, needs });
    }
  }
  // the points over the ground inside each missing outline, and how many on the ground
  const above = new Map<number, number[]>();
  const ground = new Map<number, number>();
  const cells = new Map<string, number[]>();
  for (const { missing } of pending) {
    for (const index of missing) {
      above.set(index, []);
      ground.set(index, 0);
      const box = boxes[index];
      for (let x = Math.floor(box.minE / CELL_M); x <= Math.floor(box.maxE / CELL_M); x++) {
        for (let y = Math.floor(box.minN / CELL_M); y <= Math.floor(box.maxN / CELL_M); y++) {
          cells.set(`${x}_${y}`, [...(cells.get(`${x}_${y}`) ?? []), index]);
        }
      }
    }
  }
  const sheets = [...new Set(pending.flatMap(({ needs }) => [...needs]))].sort();
  const done = new Set<string>();
  for (const sheet of sheets) {
    const waiting = pending.filter(({ needs }) => needs.has(sheet)).reduce((sum, { missing }) => sum + missing.length, 0);
    options.log?.(`fetching the laser scanning of sheet ${sheet} for up to ${waiting} roofs`);
    const bytes = await fetchSheet(sheet, options.apiKey);
    result.fetched++;
    if (bytes !== undefined) {
      await readLaz(bytes, (e, n, z, cls) => {
        if (NOISE_CLASSES.has(cls)) {
          return;
        }
        const p: Point = [e, n];
        for (const index of cells.get(`${Math.floor(e / CELL_M)}_${Math.floor(n / CELL_M)}`) ?? []) {
          const box = boxes[index];
          const outline = outlines[index];
          if (e < box.minE || e > box.maxE || n < box.minN || n > box.maxN || !pointInPolygon(p, outline)) {
            continue;
          }
          if ([outline.outer, ...outline.holes].some((ring) => distanceToRing(p, ring) < EDGE_MARGIN_M)) {
            continue;
          }
          if (GROUND_CLASSES.has(cls)) {
            ground.set(index, (ground.get(index) ?? 0) + 1);
          } else {
            above.get(index)?.push(z);
          }
        }
      });
    }
    done.add(sheet);
    // each sheet's roofs once all the points they need are in, so an interrupted import does not fetch them again
    for (const group of pending.filter(({ needs }) => [...needs].every((s) => done.has(s)))) {
      for (const index of group.missing) {
        const roof = roofOf(above.get(index) ?? [], ground.get(index) ?? 0);
        group.known.set(keys[index], roof ?? null);
        if (roof !== undefined) {
          result.roofs.set(index, roof);
        }
        above.delete(index);
      }
      await options.cache.put(`${CACHE_PREFIX}${group.sheet}.json`, JSON.stringify({ version: CACHE_VERSION, roofs: Object.fromEntries(group.known) }));
      pending.splice(pending.indexOf(group), 1);
    }
  }
  return result;
}

/** The roofs cached under the key, by outline (null for one the points measured none of); none with `refresh` */
async function readRoofs(key: string, options: CacheOptions): Promise<Map<string, number | null>> {
  const known = new Map<string, number | null>();
  const text = options.refresh ? undefined : await options.cache.get(key);
  if (text !== undefined) {
    const json: unknown = JSON.parse(text);
    const roofs = field(json, "roofs");
    if (field(json, "version") === CACHE_VERSION && isObject(roofs)) {
      for (const [outline, roof] of Object.entries(roofs)) {
        if (typeof roof === "number" || roof === null) {
          known.set(outline, roof);
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
