// Ground that the elevation model has as it was while it was built on (a heap, a berm or a pit of a building site),
// no longer there: an OSM XML file (as an editor such as JOSM saves it, never uploaded: this is no OSM data) of areas
// tagged ground=levelled whose outlines' nodes have the ground's height there (ele, in the elevation model's system).
// Inside an area the model's heights give way to a surface between the heights along its outline; given to
// MapBuilder as its groundCorrection, everything that takes heights from the model takes the levelled ones.
import { LocalProjection, type GeoPoint } from "./projection.ts";
import type { Point } from "./geometry.ts";
import { readText, type TextSource } from "./text.ts";

/** Points along an outline about this far apart (m) weigh the surface */
const SPACING_M = 2;
/** The surface is eased in over this many meters inside an outline */
const EASE_M = 4;

export interface LevelledArea {
  outline: Point[];
  /** e, n and height (m) along the outline */
  points: [number, number, number][];
  box: { minE: number; minN: number; maxE: number; maxN: number };
}

/** An XML element's attributes, as JOSM writes them (single or double quotes) */
function attributes(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of text.matchAll(/([\w:-]+)=(?:'([^']*)'|"([^"]*)")/g)) {
    result.set(match[1], match[2] ?? match[3] ?? "");
  }
  return result;
}

function tagsOf(body: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const match of body.matchAll(/<tag\s([^>]*?)\/?>/g)) {
    const a = attributes(match[1]);
    const k = a.get("k");
    if (k !== undefined) {
      tags.set(k, a.get("v") ?? "");
    }
  }
  return tags;
}

/** The file's levelled areas in map meters; an outline not closed, or a node of it without ele, is an error */
export function parseLevelledGround(xml: string, origin: GeoPoint): LevelledArea[] {
  const projection = new LocalProjection(origin);
  const nodes = new Map<string, { point: Point; ele: number | undefined }>();
  for (const match of xml.matchAll(/<node\s([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g)) {
    const a = attributes(match[1]);
    const id = a.get("id");
    const latitude = Number(a.get("lat"));
    const longitude = Number(a.get("lon"));
    if (id !== undefined && Number.isFinite(latitude) && Number.isFinite(longitude)) {
      const ele = tagsOf(match[2] ?? "").get("ele");
      nodes.set(id, { point: projection.toMeters({ latitude, longitude }), ele: ele === undefined ? undefined : Number(ele) });
    }
  }
  const areas: LevelledArea[] = [];
  for (const match of xml.matchAll(/<way\s([^>]*?)>([\s\S]*?)<\/way>/g)) {
    const body = match[2];
    if (tagsOf(body).get("ground") !== "levelled") {
      continue;
    }
    const way = attributes(match[1]).get("id");
    const refs = [...body.matchAll(/<nd\s([^>]*?)\/?>/g)].map((nd) => attributes(nd[1]).get("ref"));
    if (refs.length < 4 || refs[0] !== refs[refs.length - 1]) {
      throw new Error(`levelled area ${way}: its outline is not closed`);
    }
    const ring = refs.map((ref) => {
      const node = ref === undefined ? undefined : nodes.get(ref);
      if (!node || node.ele === undefined || !Number.isFinite(node.ele)) {
        throw new Error(`levelled area ${way}: node ${ref} has no ele`);
      }
      return { point: node.point, ele: node.ele };
    });
    const points: [number, number, number][] = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const [ae, an] = ring[i].point;
      const [be, bn] = ring[i + 1].point;
      const steps = Math.max(1, Math.ceil(Math.hypot(be - ae, bn - an) / SPACING_M));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        points.push([ae + (be - ae) * t, an + (bn - an) * t, ring[i].ele + (ring[i + 1].ele - ring[i].ele) * t]);
      }
    }
    const outline = ring.map((r) => r.point);
    const es = outline.map(([e]) => e);
    const ns = outline.map(([, n]) => n);
    areas.push({ outline, points, box: { minE: Math.min(...es), minN: Math.min(...ns), maxE: Math.max(...es), maxN: Math.max(...ns) } });
  }
  return areas;
}

function inside(outline: readonly Point[], [e, n]: Point): boolean {
  let result = false;
  for (let i = 0; i < outline.length - 1; i++) {
    const [ae, an] = outline[i];
    const [be, bn] = outline[i + 1];
    if (an > n !== bn > n && e < ae + ((be - ae) * (n - an)) / (bn - an)) {
      result = !result;
    }
  }
  return result;
}

function fromEdge(outline: readonly Point[], [e, n]: Point): number {
  let best = Infinity;
  for (let i = 0; i < outline.length - 1; i++) {
    const [ae, an] = outline[i];
    const de = outline[i + 1][0] - ae;
    const dn = outline[i + 1][1] - an;
    const t = Math.min(1, Math.max(0, ((e - ae) * de + (n - an) * dn) / (de * de + dn * dn)));
    best = Math.min(best, Math.hypot(ae + de * t - e, an + dn * t - n));
  }
  return best;
}

/**
 * The ground's height at a point with the areas levelled: inside one, a surface between the heights along its
 * outline (weighted by the inverse square of the distance to points along it), eased in from the outline.
 */
export function levelGround(areas: readonly LevelledArea[]): (point: Point, height: number) => number {
  return (point, height) => {
    const [e, n] = point;
    for (const { outline, points, box } of areas) {
      if (e < box.minE || e > box.maxE || n < box.minN || n > box.maxN || !inside(outline, point)) {
        continue;
      }
      let sum = 0;
      let weights = 0;
      for (const [pe, pn, h] of points) {
        const w = 1 / Math.max((pe - e) ** 2 + (pn - n) ** 2, 1e-6);
        sum += w * h;
        weights += w;
      }
      const share = Math.min(1, fromEdge(outline, point) / EASE_M);
      return height + (sum / weights - height) * share;
    }
    return height;
  };
}

/** The ground correction of a file of levelled ground, a text or a stream, for a map laid out around `origin` */
export async function readLevelledGround(source: TextSource, origin: GeoPoint): Promise<(point: Point, height: number) => number> {
  return levelGround(parseLevelledGround(await readText(source), origin));
}
