import assert from "node:assert/strict";
import { test } from "node:test";
import { districtKind, districtKindOf, districtOf, districtsQuery, parseDistricts, type District } from "./districts.ts";
import { parseOverpassResponse, type OsmElement } from "./osm.ts";
import { LocalProjection } from "./projection.ts";
import { defined } from "./testing.ts";

const origin = { latitude: 61.5, longitude: 23.75 };
const projection = new LocalProjection(origin);

/** lat / lon of a point `east`, `north` meters from origin */
function at(east: number, north: number): { lat: number; lon: number } {
  const geo = projection.toGeo([east, north]);
  return { lat: geo.latitude, lon: geo.longitude };
}

/** A closed square, its corner at east, north */
function square(east: number, north: number, size: number) {
  return [at(east, north), at(east + size, north), at(east + size, north + size), at(east, north + size), at(east, north)];
}

const elements: OsmElement[] = [
  {
    type: "relation",
    id: 1,
    tags: { type: "boundary", boundary: "administrative", admin_level: "10", name: "Keskusta" },
    members: [
      // the outer ring split into two ways, one drawn backwards, a hole, and a label node inside
      { type: "way", role: "outer", geometry: [at(0, 0), at(1000, 0), at(1000, 1000)] },
      { type: "way", role: "outer", geometry: [at(0, 0), at(0, 1000), at(1000, 1000)] },
      { type: "way", role: "inner", geometry: square(100, 100, 100) },
      { type: "node", role: "label", ...at(700, 700) },
      { type: "node", role: "admin_centre", ...at(10, 10) },
    ],
  },
  { type: "way", id: 2, tags: { place: "neighbourhood", name: "Kortteli" }, geometry: square(400, 400, 200) },
  { type: "way", id: 3, tags: { place: "suburb", name: "Auki" }, geometry: [at(0, 0), at(10, 0), at(10, 10)] },
  { type: "way", id: 4, tags: { place: "suburb" }, geometry: square(0, 0, 10) },
  { type: "way", id: 5, tags: { place: "city", name: "Kaupunki" }, geometry: square(0, 0, 5000) },
  {
    type: "relation",
    id: 6,
    tags: { type: "boundary", boundary: "administrative", admin_level: "10", name: "Rikki" },
    members: [{ type: "way", role: "outer", geometry: [at(2000, 0), at(3000, 0)] }],
  },
];

test("the query asks for the administrative divisions and the places of a district's kinds, with their names", () => {
  const query = districtsQuery({ south: 61.4, west: 23.6, north: 61.6, east: 23.9 });
  assert.match(query, /\[bbox:61\.4,23\.6,61\.6,23\.9\]/);
  assert.match(query, /relation\[boundary=administrative\]\[admin_level~"\^\(9\|10\)\$"\]\[name\];/);
  assert.match(query, /relation\[place~"\^\(suburb\|quarter\|neighbourhood\)\$"\]\[name\];/);
  assert.match(query, /way\[place~"\^\(suburb\|quarter\|neighbourhood\)\$"\]\[name\];/);
  assert.match(query, /out geom;$/);
});

test("a district's kind is its admin level or its place, of those a district can be", () => {
  assert.equal(districtKind({ boundary: "administrative", admin_level: "10" }), "admin_level=10");
  assert.equal(districtKind({ boundary: "administrative", admin_level: "8" }), undefined);
  assert.equal(districtKind({ place: "suburb" }), "place=suburb");
  assert.equal(districtKind({ place: "city" }), undefined);
  assert.equal(districtKind({ admin_level: "10" }), undefined);
});

test("districts are read in meters: a relation's rings stitched with their holes, a closed way, the rest left out", () => {
  const { districts, warnings } = parseDistricts(elements, origin);
  assert.deepEqual(districts.map((d) => [d.osm, d.name, d.kind]), [
    ["r1", "Keskusta", "admin_level=10"],
    ["w2", "Kortteli", "place=neighbourhood"],
  ]);
  assert.deepEqual(warnings, ["r6 (Rikki): 1 unclosed ring(s) dropped"]);
  const [centre, block] = districts;
  assert.equal(centre.polygons.length, 1);
  assert.equal(centre.polygons[0].holes.length, 1);
  assert.ok(Math.abs(centre.area - (1000 * 1000 - 100 * 100)) < 50, String(centre.area));
  // the label node, inside it
  assert.ok(Math.abs(centre.center[0] - 700) < 0.5 && Math.abs(centre.center[1] - 700) < 0.5);
  // without a label, the centroid
  assert.ok(Math.abs(block.center[0] - 500) < 0.5 && Math.abs(block.center[1] - 500) < 0.5);
});

test("a point is in the smallest district of the kind that has it, not in a hole", () => {
  const { districts } = parseDistricts(elements, origin);
  assert.equal(districtOf(districts, [500, 500])?.osm, "w2");
  assert.equal(districtOf(districts, [500, 500], "admin_level=10")?.osm, "r1");
  assert.equal(districtOf(districts, [900, 900])?.osm, "r1");
  assert.equal(districtOf(districts, [150, 150]), undefined);
  assert.equal(districtOf(districts, [-10, 500]), undefined);
  assert.equal(districtOf(districts, [500, 500], "place=suburb"), undefined);
});

test("the city's districts are of the kind whose districts have the most of the points, of those with enough", () => {
  const district = (osm: string, kind: string, east: number): Pick<District, "osm" | "kind" | "polygons" | "area"> => ({
    osm,
    kind,
    polygons: [{ outer: [[east, 0], [east + 100, 0], [east + 100, 100], [east, 100]], holes: [] }],
    area: 100 * 100,
  });
  const districts = [
    district("a", "admin_level=10", 0),
    district("b", "admin_level=10", 100),
    district("c", "place=suburb", 0),
    district("d", "place=suburb", 100),
    district("e", "place=suburb", 200),
    district("f", "admin_level=9", 0),
  ];
  const points: [number, number][] = [[50, 50], [150, 50], [250, 50]];
  assert.equal(districtKindOf(districts, points), "place=suburb");
  assert.equal(districtKindOf(districts, points.slice(0, 2)), "admin_level=10", "a tie goes to the earlier kind");
  assert.equal(districtKindOf(districts, [[5000, 5000]]), undefined);
  assert.equal(districtKindOf(districts, points, 4), undefined);
});

test("a relation's node members keep their point", () => {
  const parsed = parseOverpassResponse({
    elements: [{ type: "relation", id: 1, members: [{ type: "node", ref: 9, role: "label", lat: 61.5, lon: 23.7 }, { type: "way", role: "outer" }] }],
  });
  const relation = defined(parsed.elements[0]);
  assert.equal(relation.type, "relation");
  if (relation.type === "relation") {
    assert.deepEqual(relation.members, [
      { type: "node", role: "label", geometry: undefined, lat: 61.5, lon: 23.7 },
      { type: "way", role: "outer", geometry: undefined },
    ]);
  }
});
