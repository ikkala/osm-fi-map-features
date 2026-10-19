// Measures storey heights by when buildings were built from a map's cached sources (src/storeyHeights.ts): the
// Overpass response with the most buildings, the building register's pages, the 3D building parts' roof tops and
// the elevation model's grids. Prints the fit for the eras between the years given and for each decade.
//
//   npm run measure-storeys -- <cache dir> [<year> ...]     e.g. npm run measure-storeys -- .cache 1920 1946 1960
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseBuildingRegister } from "../src/buildingRegister.ts";
import { parseAsciiGrid, sampleElevation, toTm35fin, type ElevationGrid } from "../src/elevation.ts";
import type { Point } from "../src/geometry.ts";
import { parseOsm, parseOverpassResponse } from "../src/osm.ts";
import { LocalProjection } from "../src/projection.ts";
import { parseRoofTops } from "../src/roofTops.ts";
import { fitStoreys, storeySamples, type StoreyFit } from "../src/storeyHeights.ts";

const [dir, ...yearArgs] = process.argv.slice(2);
if (!dir) {
  console.error("usage: measureStoreys.ts <cache dir> [<year> ...]");
  process.exit(2);
}
const years = (yearArgs.length > 0 ? yearArgs.map(Number) : [1920, 1946, 1960]).sort((a, b) => a - b);
const files = await readdir(dir);
const json = async (name: string): Promise<unknown> => JSON.parse(await readFile(join(dir, name), "utf8"));

// the response of the buildings' query: the one with the most buildings, the latest of those
let best: { name: string; buildings: number; base: string } | undefined;
for (const name of files.filter((f) => /^overpass-.*\.json$/.test(f))) {
  const text = await readFile(join(dir, name), "utf8");
  const buildings = (text.match(/"building":/g) ?? []).length;
  const base = /"timestamp_osm_base":\s*"([^"]+)"/.exec(text)?.[1] ?? "";
  if (!best || buildings > best.buildings || (buildings === best.buildings && base > best.base)) {
    best = { name, buildings, base };
  }
}
if (!best) {
  throw new Error(`no Overpass responses in ${dir}`);
}
const { elements } = parseOverpassResponse(await json(best.name));
const first = elements.find((e) => e.type === "way" && e.geometry?.length);
const at = first?.type === "way" ? first.geometry?.[0] : undefined;
if (!at) {
  throw new Error(`${best.name} has no ways`);
}
const projection = new LocalProjection({ latitude: at.lat, longitude: at.lon });
const { buildings } = parseOsm(elements, projection.origin).features;

// the register's points, once each where pages overlap
const seen = new Set<string>();
const register = [];
for (const name of files.filter((f) => /^ryhti-buildings-.*\.json$/.test(f))) {
  for (const r of parseBuildingRegister(await json(name))) {
    const key = `${r.latitude},${r.longitude}`;
    if (!seen.has(key)) {
      seen.add(key);
      register.push({ point: projection.toMeters(r), floors: r.floors, year: r.year });
    }
  }
}

const tops = [];
for (const name of files.filter((f) => /-roof-tops-.*\.json$/.test(f))) {
  for (const part of parseRoofTops(await json(name))) {
    const ring = (points: { latitude: number; longitude: number }[]) => points.map((p) => projection.toMeters(p));
    tops.push({ polygon: { outer: ring(part.outer), holes: part.holes.map(ring) }, top: part.top });
  }
}

// the grids reaching the buildings, by their headers
let [minE, minN, maxE, maxN] = [Infinity, Infinity, -Infinity, -Infinity];
for (const b of buildings) {
  for (const [e, n] of b.polygon.outer.map((p) => toTm35fin(projection.toGeo(p)))) {
    [minE, minN, maxE, maxN] = [Math.min(minE, e), Math.min(minN, n), Math.max(maxE, e), Math.max(maxN, n)];
  }
}
const grids: ElevationGrid[] = [];
for (const name of files.filter((f) => /^mml-elevation-.*\.asc$/.test(f))) {
  const text = await readFile(join(dir, name), "utf8");
  const head = (key: string) => Number(new RegExp(`^${key}\\s+(\\S+)`, "im").exec(text.slice(0, 500))?.[1]);
  const size = head("cellsize");
  const west = head("xllcorner");
  const south = head("yllcorner");
  if (west < maxE && west + head("ncols") * size > minE && south < maxN && south + head("nrows") * size > minN) {
    grids.push(parseAsciiGrid(text));
  }
}
const groundAt = (p: Point) => {
  const [e, n] = toTm35fin(projection.toGeo(p));
  for (const grid of grids) {
    const h = sampleElevation(grid, e, n);
    if (h !== undefined) {
      return h;
    }
  }
  return undefined;
};

const samples = storeySamples(buildings, register, tops, groundAt);
console.log(`${best.name} (OSM of ${best.base}): ${buildings.length} buildings, ${register.length} register points, ${tops.length} roof tops, ${grids.length} grids: ${samples.length} buildings measured`);
const row = (label: string, fit: StoreyFit | undefined) =>
  console.log(
    fit
      ? `${label}  storey ${fit.storey.toFixed(2)} m (90 %: ${fit.low.toFixed(2)}-${fit.high.toFixed(2)}), rise ${fit.rise.toFixed(2)} m, ${fit.buildings} buildings`
      : `${label}  too few buildings`,
  );
const bounds = [-Infinity, ...years, Infinity];
for (let i = 0; i + 1 < bounds.length; i++) {
  const [from, until] = [bounds[i], bounds[i + 1]];
  row(`${from === -Infinity ? "" : from}-${until === Infinity ? "" : until - 1}`.padEnd(10), fitStoreys(samples, from, until));
}
const decades = samples.map((s) => Math.floor(s.year / 10) * 10).sort((a, b) => a - b);
for (let d = decades[0]; d <= decades[decades.length - 1]; d += 10) {
  row(`${d}s`.padEnd(10), fitStoreys(samples, d, d + 10));
}
