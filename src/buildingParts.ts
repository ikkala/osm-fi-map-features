// Buildings and their parts: the outlines drawn by their parts, what a part takes from its outline, the filling under
// parts raised off the ground, buildings floating over nothing, and open roofs over roads.
import { indexBoxes, pointInPolygon, ringArea, ringCentroid, type Point, type Polygon } from "./geometry.ts";
import { bounds, LEVEL_HEIGHT_M, type Building, type MapFeatures } from "./osm.ts";
import { inTunnel } from "./profile.ts";
import { WALKWAYS } from "./ways.ts";

/** Least height of an untagged roof over a road (vehicles in Finland may be 4.4 m tall) */
const ROOF_OVER_ROAD_M = 5;

/** Lifts open roofs without a tagged height that a road runs under to ROOF_OVER_ROAD_M; a carport is for cars. */
export function raiseRoofsOverRoads(features: MapFeatures): void {
  const roofs = features.buildings.filter((b) => b.shelter !== undefined && b.shelter !== "carport" && b.heightEstimated && b.height < ROOF_OVER_ROAD_M);
  const roads = features.roads.filter((r) => !WALKWAYS.has(r.kind) && !inTunnel(r));
  const near = indexBoxes(roads.map((road) => bounds(road.line)), bounds(roofs.flatMap((roof) => roof.polygon.outer)));
  for (const roof of roofs) {
    const box = bounds(roof.polygon.outer);
    const under = near(box).some((index) =>
      roads[index].line.some((p, i, line) => {
        // the road's points, and points every meter between them
        const next = line[i + 1] ?? p;
        const steps = Math.max(1, Math.ceil(Math.hypot(next[0] - p[0], next[1] - p[1])));
        for (let k = 0; k < steps; k++) {
          const q: Point = [p[0] + ((next[0] - p[0]) * k) / steps, p[1] + ((next[1] - p[1]) * k) / steps];
          const inBox = q[0] >= box.minX && q[0] <= box.maxX && q[1] >= box.minY && q[1] <= box.maxY;
          if (inBox && pointInPolygon(q, roof.polygon)) {
            return true;
          }
        }
        return false;
      }),
    );
    if (under) {
      roof.height = ROOF_OVER_ROAD_M;
      delete roof.heightEstimated;
    }
  }
}

/**
 * A part is not in an outline its centroid is in when another one holds more of it by this share of the part: a
 * chimney mapped inside its pedestal's parts holds only some of them, the building around both all.
 */
const PART_HOLDER_SLACK = 0.1;

/** Each part with the building outlines it is in (see PART_HOLDER_SLACK), smallest first */
function partHolders(buildings: Building[]): Map<Building, Building[]> {
  const outlines = buildings.filter((b) => !b.part).map((b) => ({ b, box: bounds(b.polygon.outer), area: Math.abs(ringArea(b.polygon.outer)) }));
  const result = new Map<Building, Building[]>();
  for (const part of buildings.filter((b) => b.part)) {
    const [x, y] = ringCentroid(part.polygon.outer);
    const around = outlines.filter(({ b, box }) => x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && pointInPolygon([x, y], b.polygon));
    if (around.length === 0) {
      continue;
    }
    const shares = around.length === 1 ? [1] : around.map((o) => shareCovered(part.polygon, [o]));
    const most = Math.max(...shares);
    const holders = around.filter((_, i) => shares[i] >= most - PART_HOLDER_SLACK).sort((a, b) => a.area - b.area);
    result.set(part, holders.map(({ b }) => b));
  }
  return result;
}

/** Each part with the building outline it is in, the smallest of nested ones */
export function partOutlines(buildings: Building[]): Map<Building, Building> {
  const result = new Map<Building, Building>();
  for (const [part, [outline]] of partHolders(buildings)) {
    result.set(part, outline);
  }
  return result;
}

/**
 * Gives parts what their building outline has and they do not: the wall material and colour, the register's
 * frame material, the roof material and the year or start_date (mappers tag these on the outline). Returns how many parts got any.
 */
export function inheritFromOutlines(buildings: Building[]): number {
  let count = 0;
  for (const [part, outline] of partOutlines(buildings)) {
    let got = false;
    if (part.material === undefined && outline.material !== undefined) {
      part.material = outline.material;
      if (outline.materialEstimated) {
        part.materialEstimated = true;
      }
      got = true;
    }
    if (part.colour === undefined && outline.colour !== undefined) {
      part.colour = outline.colour;
      got = true;
    }
    if (part.frameMaterial === undefined && outline.frameMaterial !== undefined) {
      part.frameMaterial = outline.frameMaterial;
      got = true;
    }
    if (part.roofMaterial === undefined && outline.roofMaterial !== undefined) {
      part.roofMaterial = outline.roofMaterial;
      got = true;
    }
    if (part.year === undefined && part.startDate === undefined && (outline.year !== undefined || outline.startDate !== undefined)) {
      if (outline.year !== undefined) {
        part.year = outline.year;
      }
      if (outline.startDate !== undefined) {
        part.startDate = outline.startDate;
      }
      got = true;
    }
    if (got) {
      count++;
    }
  }
  return count;
}

/**
 * Parts replace the outline they are in, unless they cover less than this share of it: mappers often give
 * parts to only some of a building.
 */
const MIN_PARTS_COVER = 0.5;

export function markBuildingsWithParts(buildings: Building[]): void {
  const inside = new Map<Building, { b: Building; box: ReturnType<typeof bounds> }[]>();
  for (const [part, outlines] of partHolders(buildings)) {
    for (const outline of outlines) {
      inside.set(outline, [...(inside.get(outline) ?? []), { b: part, box: bounds(part.polygon.outer) }]);
    }
  }
  for (const [outline, parts] of inside) {
    outline.hasParts = shareCovered(outline.polygon, parts) >= MIN_PARTS_COVER;
  }
}

/** The share of a polygon under the buildings, sampled on a grid. */
function shareCovered(polygon: Polygon, buildings: { b: Building; box: ReturnType<typeof bounds> }[]): number {
  const box = bounds(polygon.outer);
  const step = Math.max(0.5, Math.sqrt(((box.maxX - box.minX) * (box.maxY - box.minY)) / 400));
  let points = 0;
  let covered = 0;
  for (let x = box.minX + step / 2; x < box.maxX; x += step) {
    for (let y = box.minY + step / 2; y < box.maxY; y += step) {
      const p: Point = [x, y];
      if (!pointInPolygon(p, polygon)) {
        continue;
      }
      points++;
      if (buildings.some(({ b, box: pb }) => x >= pb.minX && x <= pb.maxX && y >= pb.minY && y <= pb.maxY && pointInPolygon(p, b.polygon))) {
        covered++;
      }
    }
  }
  return points === 0 ? 1 : covered / points;
}

/**
 * Fillers from the outline's bottom up to parts that start higher with nothing under them, as mappers often
 * give parts only to what stands out. Overhanging parts and parts over a way are left floating.
 */
export function fillUnderFloatingParts(features: MapFeatures): Building[] {
  const buildings = features.buildings;
  const outlines = buildings.filter((b) => b.hasParts).map((b) => ({ b, box: bounds(b.polygon.outer) }));
  const parts = buildings.filter((b) => b.part);
  const ways = [...features.roads, ...features.rails].filter((w) => !inTunnel(w)).map((w) => ({ line: w.line, box: bounds(w.line) }));
  const fillers: Building[] = [];
  for (const part of parts) {
    if (part.minHeight <= 0 || OVERHANGING_PARTS.has(part.kind)) {
      continue;
    }
    const partBox = bounds(part.polygon.outer);
    const nearby = ways.filter(({ box }) => box.maxX >= partBox.minX && box.minX <= partBox.maxX && box.maxY >= partBox.minY && box.minY <= partBox.maxY);
    if (nearby.some(({ line }) => lineEntersPolygon(line, part.polygon))) {
      continue;
    }
    const p = ringCentroid(part.polygon.outer);
    const outline = outlines.find(
      ({ b, box }) =>
        b.minHeight < part.minHeight && p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minY && p[1] <= box.maxY && pointInPolygon(p, b.polygon),
    )?.b;
    const below = parts.some((other) => other !== part && other.minHeight < part.minHeight && pointInPolygon(p, other.polygon));
    if (outline && !below) {
      fillers.push({
        osm: outline.osm,
        kind: outline.kind,
        part: true,
        hasParts: false,
        height: part.minHeight,
        minHeight: outline.minHeight,
        ...(outline.colour && { colour: outline.colour }),
        ...(outline.roofColour && { roofColour: outline.roofColour }),
        ...(outline.material && { material: outline.material }),
        ...(outline.frameMaterial && { frameMaterial: outline.frameMaterial }),
        ...(outline.special && { special: true }),
        ...(outline.worship && { worship: true }),
        ...(outline.lattice && { lattice: true }),
        polygon: part.polygon,
      });
    }
  }
  return fillers;
}

/** A raised building stays raised when at least this share of it is over lower buildings */
const MIN_OVER_BUILDINGS = 0.5;

/**
 * Brings buildings without parts that start higher with nothing under them down to the ground, their storeys with
 * them, as mappers sometimes leave out a ground floor (building:min_level=1 over shops on the street). Overhanging
 * kinds, buildings over a way (an arcade, a skyway) and buildings over lower ones are left raised.
 */
export function groundFloatingBuildings(features: MapFeatures): void {
  const all = features.buildings.map((b) => ({ b, box: bounds(b.polygon.outer) }));
  const ways = [...features.roads, ...features.rails].filter((w) => !inTunnel(w)).map((w) => ({ line: w.line, box: bounds(w.line) }));
  type Box = ReturnType<typeof bounds>;
  const meet = (a: Box, b: Box) => a.maxX >= b.minX && a.minX <= b.maxX && a.maxY >= b.minY && a.minY <= b.maxY;
  for (const { b, box } of all) {
    if (b.part || b.hasParts || b.shelter !== undefined || b.minHeight <= 0 || OVERHANGING_PARTS.has(b.kind)) {
      continue;
    }
    if (ways.some((w) => meet(box, w.box) && lineEntersPolygon(w.line, b.polygon))) {
      continue;
    }
    const lower = all.filter((o) => o.b !== b && o.b.minHeight < b.minHeight && meet(box, o.box));
    if (lower.length > 0 && shareCovered(b.polygon, lower) >= MIN_OVER_BUILDINGS) {
      continue;
    }
    if (b.levels !== undefined) {
      b.levels += Math.round(b.minHeight / LEVEL_HEIGHT_M);
    }
    b.minHeight = 0;
  }
}

/** building:part=* values that stick out of a building with nothing under them */
const OVERHANGING_PARTS = new Set(["balcony", "roof", "canopy", "antenna", "bridge", "corridor", "porch"]);

/** Whether a line has a point, or a point every meter along it, inside a polygon */
function lineEntersPolygon(line: Point[], polygon: Polygon): boolean {
  for (let i = 0; i < line.length; i++) {
    const [p, next] = [line[i], line[i + 1] ?? line[i]];
    const steps = Math.max(1, Math.ceil(Math.hypot(next[0] - p[0], next[1] - p[1])));
    for (let k = 0; k < steps; k++) {
      if (pointInPolygon([p[0] + ((next[0] - p[0]) * k) / steps, p[1] + ((next[1] - p[1]) * k) / steps], polygon)) {
        return true;
      }
    }
  }
  return false;
}
