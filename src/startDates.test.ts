import assert from "node:assert/strict";
import test from "node:test";
import { allows, builtBefore, eraOf, exactYear } from "./startDates.ts";

test("exactYear is the year a start_date names, and none for one that names no single year", () => {
  assert.deepEqual(
    ["1897", "1897-05", "1897-05-01", " 1897 ", "1890s", "C19", "1904..1920", "~1897", "before 1900", "spring 1897", undefined].map(exactYear),
    [1897, 1897, 1897, 1897, undefined, undefined, undefined, undefined, undefined, undefined, undefined],
  );
});

test("builtBefore answers from the year, else from what the start_date tells", () => {
  assert.equal(builtBefore({ year: 1897 }, 1920), true);
  assert.equal(builtBefore({ year: 1920 }, 1920), false);
  // the year wins over start_date
  assert.equal(builtBefore({ year: 1950, startDate: "C19" }, 1920), false);
  const before1920 = (startDate: string) => builtBefore({ startDate }, 1920);
  assert.deepEqual(["1890s", "1910s", "1920s", "C19", "C20", "early C20", "late C19", "C21"].map(before1920), [true, true, false, true, undefined, undefined, true, false]);
  // a span to its last year, before and after a date
  assert.deepEqual(["1904..1919", "1904..1920", "1920..1930", "1890s..1910s", "before 1900", "before 1930", "after 1919", "after 1890"].map(before1920), [
    true,
    undefined,
    false,
    true,
    true,
    undefined,
    false,
    undefined,
  ]);
  // what it does not read tells nothing
  assert.deepEqual(["~1897", "spring 1897", ""].map(before1920), [undefined, undefined, undefined]);
  assert.equal(builtBefore({}, 1920), undefined);
});

test("a century allows its years counted from 1 and from 0", () => {
  // C20 is 1901-2000 or 1900-1999
  assert.equal(builtBefore({ startDate: "C20" }, 1900), false);
  assert.equal(builtBefore({ startDate: "C20" }, 2001), true);
  assert.equal(builtBefore({ startDate: "C20" }, 2000), undefined);
  assert.deepEqual([1899, 1900, 1950, 2000, 2001].map((y) => allows("C20", y)), [false, true, true, true, false]);
  // its thirds overlap by a year
  assert.equal(builtBefore({ startDate: "early C20" }, 1935), true);
  assert.equal(builtBefore({ startDate: "mid C20" }, 1933), false);
  assert.equal(builtBefore({ startDate: "mid C20" }, 1968), true);
  assert.equal(builtBefore({ startDate: "late C20" }, 1966), false);
});

test("allows any year for a start_date it does not read", () => {
  assert.equal(allows("~1897", 1850), true);
  assert.equal(allows("1890s", 1900), false);
});

test("eraOf is the era it was built in, when what is known tells which", () => {
  const eras = [{ before: 1920 }, { before: 1946 }, { before: 1990 }];
  assert.equal(eraOf({ year: 1930 }, eras), eras[1]);
  assert.equal(eraOf({ startDate: "1890s" }, eras), eras[0]);
  assert.equal(eraOf({ startDate: "1925..1940" }, eras), eras[1]);
  // in one of two eras, or after them all
  assert.equal(eraOf({ startDate: "1910..1930" }, eras), undefined);
  assert.equal(eraOf({ startDate: "C20" }, eras), undefined);
  assert.equal(eraOf({ year: 2005 }, eras), undefined);
  assert.equal(eraOf({}, eras), undefined);
});
