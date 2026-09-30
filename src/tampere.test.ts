import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point } from "./geometry.ts";
import { estimatedLevels, type Building } from "./osm.ts";
import { applyRegister, parseCounts, parseRegister, parseTreeRegister, registerTreeHeight, type RegisterBuilding } from "./tampere.ts";

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

test("parseRegister keeps buildings with their storeys and facade material", () => {
  const point = (lon: number, lat: number) => ({ type: "Point", coordinates: [lon, lat] });
  const parsed = parseRegister({
    features: [
      { geometry: point(23.1, 61.1), properties: { TYYPPI: "Rakennus", I_KERRLKM: 4, C_JULKISIVU: "2", C_RAKENNUSLUOKKA: "0121" } },
      { geometry: point(23.2, 61.2), properties: { TYYPPI: "Rakennus", I_KERRLKM: null, C_JULKISIVU: "7" } },
      { geometry: point(23.3, 61.3), properties: { TYYPPI: "Rakennelma", I_KERRLKM: 1, C_JULKISIVU: "5" } },
      // glass is not trusted
      { geometry: point(23.4, 61.4), properties: { TYYPPI: "Rakennus", I_KERRLKM: 6, C_JULKISIVU: "6", C_RAKENNUSLUOKKA: "0400" } },
    ],
  });
  assert.deepEqual(parsed, [
    { longitude: 23.1, latitude: 61.1, floors: 4, facade: "brick", use: "0121" },
    { longitude: 23.2, latitude: 61.2 },
    { longitude: 23.4, latitude: 61.4, floors: 6, use: "0400" },
  ]);
});

test("applyRegister replaces estimated heights and sets materials from the points inside", () => {
  const estimated = square(0, 10);
  const tagged = square(20, 10, { height: 30, heightEstimated: undefined, levels: 8, material: "glass" });
  const empty = square(40, 10);
  const at = (e: number, n: number, floors?: number, facade?: string, use?: string): RegisterBuilding => ({ longitude: e, latitude: n, floors, facade, use });
  const register = [at(2, 2, 2, "wood", "0110"), at(8, 8, 5, "brick", "0121"), at(9, 1, 1, "brick", "0121"), at(25, 5, 4, "concrete"), at(100, 100, 3)];
  const match = applyRegister([estimated, tagged, empty], register, (r) => [r.longitude, r.latitude]);
  assert.deepEqual(match, { heights: 1, materials: 1, unmatched: 1 });
  // the most storeys and the most common facade win
  assert.equal(estimated.height, 15);
  assert.equal(estimated.heightEstimated, undefined);
  assert.equal(estimated.material, "brick");
  assert.equal(estimated.levels, 5);
  assert.equal(estimated.use, "0121");
  // OSM heights, levels and materials are kept
  assert.equal(tagged.height, 30);
  assert.equal(tagged.levels, 8);
  assert.equal(tagged.material, "glass");
  assert.equal(empty.height, 9);
  assert.equal(empty.heightEstimated, true);
});

test("registerTreeHeight takes the middle of the height class, or guesses from the trunk", () => {
  assert.equal(registerTreeHeight("11 - 15m", 100, "broadleaved"), 13);
  assert.equal(registerTreeHeight("30m ->", undefined, "conifer"), 32);
  assert.equal(registerTreeHeight("Ei tietoa", 150, "broadleaved").toFixed(1), "19.7");
  assert.equal(registerTreeHeight("Ei tietoa", 0, "conifer"), 10);
  assert.equal(registerTreeHeight(undefined, 80, "shrub"), 2);
});

test("parseTreeRegister reads the kind, height, genus and trunk of each plant", () => {
  const point = (lon: number, lat: number) => ({ type: "Point", coordinates: [lon, lat] });
  const parsed = parseTreeRegister({
    features: [
      { geometry: point(23.1, 61.1), properties: { Kasviryhma: "Lehtipuu", Kasvilaji: "BETULA PENDULA (RAUDUSKOIVU)", Pituusluokka: "16 - 20m", Rungon_ymparys: 150 } },
      { geometry: point(23.2, 61.2), properties: { Kasviryhma: "Havupuu", Kasvilaji: "HAVUPUU", Pituusluokka: "Ei tietoa", Rungon_ymparys: 0 } },
      { geometry: point(23.3, 61.3), properties: { Kasviryhma: "Lehtipensas", Kasvilaji: "SYRINGA VULGARIS (PIHASYREENI)" } },
      { geometry: null, properties: { Kasviryhma: "Lehtipuu" } },
    ],
  });
  assert.deepEqual(parsed, [
    { longitude: 23.1, latitude: 61.1, kind: "broadleaved", height: 18, genus: "betula", trunk: 1.5 },
    { longitude: 23.2, latitude: 61.2, kind: "conifer", height: 10 },
    { longitude: 23.3, latitude: 61.3, kind: "shrub", height: 2, genus: "syringa" },
  ]);
});

test("parseCounts keeps current counts along ways, as average days", () => {
  const count = (properties: Record<string, unknown>) => ({ geometry: { type: "Point", coordinates: [23.7, 61.5] }, properties });
  const current = { tulos_vanhentunut: "ei", paiva: "2026-06-10Z" };
  const parsed = parseCounts({
    features: [
      count({ ...current, kohteen_tyyppi: "JKPP", vuorokausi_jk: 1155, iltahuipputunti_jk: 120, vuorokausi_pp: 1650 }),
      // only the afternoon peak hour
      count({ ...current, kohteen_tyyppi: "Koko poikkileikkaus", vuorokausi_jk: null, iltahuipputunti_jk: 121.275 }),
      count({ ...current, kohteen_tyyppi: "Suojatie", vuorokausi_jk: 500 }),
      count({ ...current, kohteen_tyyppi: "JKPP", tulos_vanhentunut: "kyllä", vuorokausi_jk: 500 }),
      count({ ...current, kohteen_tyyppi: "JKPP", vuorokausi_jk: null, iltahuipputunti_jk: null }),
    ],
  });
  // a Wednesday in June: walking 1.1 × 1.05, cycling 1.5 × 1.1
  assert.deepEqual(parsed, [
    { longitude: 23.7, latitude: 61.5, walking: 1000, cycling: 1000, whole: false },
    { longitude: 23.7, latitude: 61.5, walking: 1000, whole: true },
  ]);
});
