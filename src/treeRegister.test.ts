import assert from "node:assert/strict";
import { test } from "node:test";
import { overlaps, parseTreeRegister, registerTreeHeight } from "./treeRegister.ts";
import { inGeoBox } from "./projection.ts";

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

test("overlaps tells whether a map reaches into a register's area", () => {
  const tampere = { south: 61.35, west: 23.45, north: 61.9, east: 24.25 };
  assert.equal(overlaps(tampere, { south: 61.49, west: 23.73, north: 61.51, east: 23.79 }), true);
  assert.equal(overlaps(tampere, { south: 62.23, west: 25.72, north: 62.25, east: 25.77 }), false);
});

test("inGeoBox leaves out the points outside the box, such as a register tree with broken coordinates", () => {
  const box = { south: 61.49, west: 23.73, north: 61.51, east: 23.79 };
  const inside = { latitude: 61.5, longitude: 23.76 };
  assert.deepEqual(inGeoBox([inside, { latitude: 0, longitude: 53.256414 }, { latitude: 61.5, longitude: 23.8 }], box), [inside]);
});
