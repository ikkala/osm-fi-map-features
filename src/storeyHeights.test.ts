import assert from "node:assert/strict";
import test from "node:test";
import type { Building } from "./osm.ts";
import { fitStoreys, storeySamples, type MeasuredTop, type RegisterPoint, type StoreySample } from "./storeyHeights.ts";

/** Buildings of 2 to 6 storeys of a height each, under a rise, with a little spread */
function buildings(year: number, storey: number, rise: number): StoreySample[] {
  return [2, 3, 4, 5, 6].flatMap((storeys) => [-0.3, 0, 0, 0.3, 0.1, -0.1].map((d) => ({ storeys, year, height: rise + storeys * storey + d })));
}

test("fitStoreys separates the storeys from the rise of the roof", () => {
  const fit = fitStoreys([...buildings(1930, 3.4, 3), ...buildings(1975, 2.9, 1.5)], 1920, 1946);
  assert.ok(fit);
  assert.equal(fit.buildings, 30);
  assert.ok(Math.abs(fit.storey - 3.4) < 0.01 && Math.abs(fit.rise - 3) < 0.05);
  assert.ok(fit.low <= fit.storey && fit.storey <= fit.high && fit.high - fit.low < 0.2);
  // the same every time
  assert.deepEqual(fitStoreys(buildings(1930, 3.4, 3), 1920, 1946), fitStoreys(buildings(1930, 3.4, 3), 1920, 1946));
});

test("fitStoreys leaves out one-storey buildings and storey counts of few buildings", () => {
  const halls = [1, 1, 1, 1, 1, 1].map(() => ({ storeys: 1, year: 1930, height: 12 }));
  const few = [{ storeys: 8, year: 1930, height: 60 }];
  const fit = fitStoreys([...buildings(1930, 3.4, 3), ...halls, ...few], 1920, 1946);
  assert.ok(fit && Math.abs(fit.storey - 3.4) < 0.01);
  // too few storey counts to fit
  assert.equal(fitStoreys(buildings(1930, 3.4, 3).filter((s) => s.storeys === 3), 1920, 1946), undefined);
  assert.equal(fitStoreys(buildings(1930, 3.4, 3), 1950, 1960), undefined);
});

test("storeySamples measures whole buildings with one register point, a year, storeys and a top", () => {
  const square = (x: number, osm: string, fields: Partial<Building> = {}): Building => ({
    osm, kind: "apartments", part: false, hasParts: false, height: 9, minHeight: 0,
    polygon: { outer: [[x, 0], [x + 10, 0], [x + 10, 10], [x, 10]], holes: [] }, ...fields,
  });
  const buildings = [
    square(0, "w1", { levels: 3, year: 1930 }),
    // the register's storeys and year
    square(20, "w2"),
    square(40, "w3", { kind: "industrial", levels: 1, year: 1930 }),
    // two register points: two buildings in one outline
    square(60, "w4", { levels: 3, year: 1930 }),
    // a top 40 m over three storeys is another building's
    square(80, "w5", { levels: 3, year: 1930 }),
  ];
  const register: RegisterPoint[] = [
    { point: [5, 5] },
    { point: [25, 5], floors: 4, year: 1955 },
    { point: [45, 5] },
    { point: [62, 5] },
    { point: [68, 5] },
    { point: [85, 5] },
  ];
  const top = (x: number, t: number): MeasuredTop => ({ polygon: { outer: [[x + 1, 1], [x + 9, 1], [x + 9, 9], [x + 1, 9]], holes: [] }, top: t });
  const tops = [top(0, 112), top(20, 115), top(40, 110), top(60, 112), top(80, 140)];
  const samples = storeySamples(buildings, register, tops, ([x]) => (x <= 10 ? 101 : 100));
  assert.deepEqual(samples, [
    { storeys: 3, year: 1930, height: 11 },
    { storeys: 4, year: 1955, height: 15 },
  ]);
});
