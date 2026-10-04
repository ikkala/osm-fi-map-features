import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point } from "./geometry.ts";
import { estimatedLevels, type Building, type BuildingUse } from "./osm.ts";
import { applyRegister, parseBuildingRegister, type RegisterBuilding } from "./buildingRegister.ts";

function square(x: number, size: number, extra: Partial<Building> = {}): Building {
  const outer: Point[] = [[x, 0], [x + size, 0], [x + size, size], [x, size]];
  return { osm: `w${x}`, kind: "yes", part: false, hasParts: false, height: 9, heightEstimated: true, minHeight: 0, polygon: { outer, holes: [] }, ...extra };
}

test("estimatedLevels goes by type and floor area", () => {
  assert.equal(estimatedLevels("yes", 20), 1);
  assert.equal(estimatedLevels("shed", 300), 1);
  assert.equal(estimatedLevels("detached", 180), 2);
  assert.equal(estimatedLevels("yes", 100), 2);
  assert.equal(estimatedLevels("apartments", 600), 3);
});

test("parseBuildingRegister keeps standing buildings with their storeys, facade, use and year", () => {
  const point = (lon: number, lat: number) => ({ type: "Point", coordinates: [lon, lat] });
  const parsed = parseBuildingRegister({
    features: [
      {
        geometry: point(23.1, 61.1),
        properties: { kerrosluku: 4, julkisivumateriaali: "Tiili", paaasiallinen_kayttotarkoitus: "Kerrostalo", valmistumispaivamaara: "1962-11-30Z" },
      },
      // 29 February 1904 stands for an unknown date, and "Muu" for no known material
      { geometry: point(23.2, 61.2), properties: { kerrosluku: null, julkisivumateriaali: "Muu", valmistumispaivamaara: "1904-02-29Z" } },
      { geometry: point(23.3, 61.3), properties: { kerrosluku: 1, kaytossaolo: "Purettu muusta syystä" } },
      { geometry: point(23.35, 61.35), properties: { kerrosluku: 2, purkamispaivamaara: "2020-05-01Z" } },
      // glass is not trusted
      {
        geometry: point(23.4, 61.4),
        properties: { kerrosluku: 6, julkisivumateriaali: "Lasi", paaasiallinen_kayttotarkoitus: "Toimisto-, tuotanto-, yhdyskuntatekniikan tai muut rakennukset" },
      },
    ],
  });
  assert.deepEqual(parsed, [
    { longitude: 23.1, latitude: 61.1, floors: 4, facade: "brick", use: "apartments", year: 1962 },
    { longitude: 23.2, latitude: 61.2 },
    { longitude: 23.4, latitude: 61.4, floors: 6, use: "work" },
  ]);
});

test("applyRegister replaces estimated heights and sets materials from the points inside", () => {
  const estimated = square(0, 10);
  const tagged = square(20, 10, { height: 30, heightEstimated: undefined, levels: 8, material: "glass", year: 2001 });
  const empty = square(40, 10);
  const at = (e: number, n: number, floors?: number, facade?: string, use?: BuildingUse, year?: number): RegisterBuilding => ({ longitude: e, latitude: n, floors, facade, use, year });
  const register = [at(2, 2, 2, "wood", "house", 1950), at(8, 8, 5, "brick", "apartments", 1912), at(9, 1, 1, "brick", "apartments"), at(25, 5, 4, "concrete", undefined, 1980), at(100, 100, 3)];
  const match = applyRegister([estimated, tagged, empty], register, (r) => [r.longitude, r.latitude]);
  assert.deepEqual(match, { matched: 2, heights: 1, materials: 1, unmatched: 1 });
  // the most storeys and the most common facade win
  assert.equal(estimated.height, 15);
  assert.equal(estimated.heightEstimated, undefined);
  assert.equal(estimated.material, "brick");
  assert.equal(estimated.levels, 5);
  assert.equal(estimated.use, "apartments");
  // the earliest year, and the height is counted from storeys
  assert.equal(estimated.year, 1912);
  assert.equal(estimated.heightFromLevels, true);
  // OSM heights, levels, materials and years are kept
  assert.equal(tagged.height, 30);
  assert.equal(tagged.year, 2001);
  assert.equal(tagged.levels, 8);
  assert.equal(tagged.material, "glass");
  assert.equal(empty.height, 9);
  assert.equal(empty.heightEstimated, true);
});

test("applyRegister keeps a height guessed by type", () => {
  const church = square(0, 20, { kind: "church", height: 9, heightByType: true });
  applyRegister([church], [{ longitude: 2, latitude: 2, floors: 1 }], (r) => [r.longitude, r.latitude]);
  assert.deepEqual([church.height, church.heightEstimated, church.levels], [9, true, 1]);
});

test("applyRegister gives a point in a part to the outline around it, and to a part in none", () => {
  const outline = square(0, 40, { hasParts: true });
  const base = square(2, 5, { part: true });
  const alone = square(100, 5, { part: true });
  const at = (e: number, n: number): RegisterBuilding => ({ longitude: e, latitude: n, facade: "brick", year: 1952 });
  const match = applyRegister([outline, base, alone], [at(4, 4), at(102, 2)], (r) => [r.longitude, r.latitude]);
  assert.equal(match.matched, 2);
  assert.deepEqual([outline.material, outline.year], ["brick", 1952]);
  assert.deepEqual([base.material, base.year], [undefined, undefined]);
  assert.deepEqual([alone.material, alone.year], ["brick", 1952]);
});

test("applyRegister replaces a guessed material", () => {
  const chimney = square(0, 4, { material: "brick", materialEstimated: true });
  const match = applyRegister([chimney], [{ longitude: 2, latitude: 2, facade: "concrete" }], (r) => [r.longitude, r.latitude]);
  assert.equal(match.materials, 1);
  assert.deepEqual([chimney.material, chimney.materialEstimated], ["concrete", undefined]);
});
