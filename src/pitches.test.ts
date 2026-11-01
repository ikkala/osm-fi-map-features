import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOsm, type Area, type Building, type MapFeatures, type OverpassResponse } from "./osm.ts";
import { pitchBoxes, setLevelTops, type Pitch } from "./pitches.ts";
import { cutIntoTiles } from "./tiles.ts";
import { LocalProjection } from "./projection.ts";
import { defined } from "./testing.ts";

const origin = { latitude: 61.5, longitude: 23.75 };
const projection = new LocalProjection(origin);

function at(east: number, north: number): { lat: number; lon: number } {
  const geo = projection.toGeo([east, north]);
  return { lat: geo.latitude, lon: geo.longitude };
}

/** A closed way's points: a rectangle length by width with its middle at e, n, its long side turned degrees from east */
function rectangle(e: number, n: number, length: number, width: number, degrees = 0) {
  const a = (degrees * Math.PI) / 180;
  const corner = (u: number, v: number) => at(e + u * Math.cos(a) - v * Math.sin(a), n + u * Math.sin(a) + v * Math.cos(a));
  const [u, v] = [length / 2, width / 2];
  return [corner(-u, -v), corner(u, -v), corner(u, v), corner(-u, v), corner(-u, -v)];
}

function area(osm: string, outer: [number, number][]): Area {
  return { osm, kind: "pitch", polygon: { outer, holes: [] } };
}

test("pitches outdoors mapped as rectangles get their sports and the box they fill", () => {
  const response: OverpassResponse = {
    elements: [
      { type: "way", id: 1, tags: { leisure: "pitch", sport: "Soccer; ice_hockey", surface: "sand" }, geometry: rectangle(100, 50, 40, 25, 30) },
      { type: "way", id: 2, tags: { leisure: "pitch", sport: "tennis" }, geometry: rectangle(200, 0, 36, 18) },
      // indoors, covered, or in a hall
      { type: "way", id: 3, tags: { leisure: "pitch", sport: "padel", indoor: "yes" }, geometry: rectangle(300, 0, 20, 10) },
      { type: "way", id: 4, tags: { leisure: "pitch", sport: "basketball", covered: "yes" }, geometry: rectangle(350, 0, 28, 15) },
      { type: "way", id: 5, tags: { building: "sports_hall" }, geometry: rectangle(400, 0, 60, 30) },
      { type: "way", id: 6, tags: { leisure: "pitch", sport: "floorball" }, geometry: rectangle(400, 0, 40, 20) },
      // an L, and one too small to mark
      { type: "way", id: 7, tags: { leisure: "pitch" }, geometry: [at(0, 0), at(40, 0), at(40, 10), at(10, 10), at(10, 40), at(0, 40), at(0, 0)] },
      { type: "way", id: 8, tags: { leisure: "pitch", sport: "boules" }, geometry: rectangle(500, 0, 3, 2) },
    ],
  };
  const { features, pitches } = parseOsm(response.elements, origin);
  assert.deepEqual(pitches.map((p) => [p.osm, p.sports, p.indoor]), [
    ["w1", ["soccer", "ice_hockey"], false],
    ["w2", ["tennis"], false],
    ["w3", ["padel"], true],
    ["w4", ["basketball"], true],
    ["w6", ["floorball"], false],
    ["w7", [], false],
    ["w8", ["boules"], false],
  ]);
  const areas = features.areas.filter((a) => a.kind === "pitch");
  defined(areas.find((a) => a.osm === "w1")).top = 96.5;
  const boxes = pitchBoxes(pitches, areas, features.buildings);
  assert.deepEqual(boxes.map((p) => p.osm), ["w1", "w2"]);
  const [soccer, tennis] = boxes;
  assert.deepEqual(
    [soccer.surface, soccer.point.map((v) => v.toFixed(1)), ((soccer.angle * 180) / Math.PI).toFixed(1), soccer.length.toFixed(1), soccer.width.toFixed(1), soccer.top],
    ["sand", ["100.0", "50.0"], "30.0", "40.0", "25.0", 96.5],
  );
  assert.deepEqual([tennis.surface, tennis.top, ((tennis.angle * 180) / Math.PI).toFixed(1)], [undefined, undefined, "0.0"]);
});

test("a pitch or a paved area whose ground is level but for a little gets its median as its top; one on a slope does not", () => {
  const level = area("w1", [[0, 0], [40, 0], [40, 20], [0, 20]]);
  const slope = area("w2", [[100, 0], [140, 0], [140, 20], [100, 20]]);
  // a ditch in one corner of a level one
  const ditched = area("w3", [[200, 0], [240, 0], [240, 20], [200, 20]]);
  const grass: Area = { osm: "w4", kind: "grass", polygon: { outer: [[300, 0], [340, 0], [340, 20], [300, 20]], holes: [] } };
  const parking: Area = { osm: "w5", kind: "paved", polygon: { outer: [[400, 0], [440, 0], [440, 20], [400, 20]], holes: [] } };
  const heightAt = (e: number, n: number) => {
    if (e < 50) {
      return 96 + (e / 40) * 0.4;
    }
    if (e < 150) {
      return 100 + (e - 100) * 0.1;
    }
    return e < 202 && n < 2 ? 94 : 98 + (n / 20) * 0.2;
  };
  assert.equal(setLevelTops([level, slope, ditched, grass, parking], heightAt), 3);
  assert.equal(defined(parking.top).toFixed(1), "98.1");
  assert.equal(defined(level.top).toFixed(1), "96.2");
  assert.equal(slope.top, undefined);
  assert.equal(defined(ditched.top).toFixed(1), "98.1");
  assert.equal(grass.top, undefined);
});

test("a pitch goes whole to the tile its box's middle is in, while its area is cut at the tiles' edges", () => {
  const empty: MapFeatures = { roads: [], rails: [], buildings: [], areas: [], trees: [], lamps: [], crossings: [], signals: [], gates: [], barriers: [], playEquipment: [], bridgeDecks: [] };
  const outer: [number, number][] = [[80, 10], [140, 10], [140, 50], [80, 50]];
  const pitch: Pitch = { osm: "w1", sports: ["soccer"], point: [110, 30], angle: 0, length: 60, width: 40, top: 96 };
  const [west, east] = cutIntoTiles({ ...empty, areas: [{ ...area("w1", outer), top: 96 }], pitches: [pitch] }, [{ x: 0, y: 0 }, { x: 1, y: 0 }], 100);
  assert.deepEqual([defined(west.pitches).length, defined(east.pitches).map((p) => p.osm)], [0, ["w1"]]);
  assert.deepEqual([west.areas.map((a) => a.top), east.areas.map((a) => a.top)], [[96], [96]]);
});

test("no pitches, no boxes", () => {
  const building: Building = { osm: "w1", kind: "yes", part: false, hasParts: false, height: 6, minHeight: 0, polygon: { outer: [[0, 0], [9, 0], [9, 9], [0, 9]], holes: [] } };
  assert.deepEqual(pitchBoxes([], [], [building]), []);
});
