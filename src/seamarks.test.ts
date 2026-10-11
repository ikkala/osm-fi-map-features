import assert from "node:assert/strict";
import { test } from "node:test";
import { lightPhases, parseLight, parseSeamark } from "./seamarks.ts";
import { defined } from "./testing.ts";

const round = (phases: number[]) => phases.map((s) => Math.round(s * 100) / 100);

test("a lighthouse's light: its colour, height and the rhythm of its sequence", () => {
  const seamark = defined(
    parseSeamark(
      {
        man_made: "lighthouse",
        name: "Kari",
        height: "10",
        "seamark:type": "light_major",
        "seamark:light:character": "IVQ",
        "seamark:light:colour": "yellow",
        "seamark:light:group": "5",
        "seamark:light:height": "6.5",
        "seamark:light:period": "6",
        "seamark:light:sequence": "0.2+(0.25)+0.2+(0.25)+0.2+(0.25)+0.2+(0.25)+0.2+(4)",
      },
      "n1",
      [5, 6],
    ),
  );
  assert.equal(seamark.kind, "lighthouse");
  assert.equal(seamark.type, "major");
  assert.equal(seamark.name, "Kari");
  assert.equal(seamark.height, 10);
  assert.deepEqual(seamark.point, [5, 6]);
  const light = defined(seamark.light);
  assert.equal(light.colour, "yellow");
  assert.equal(light.height, 6.5);
  assert.deepEqual(round(light.phases), [0.2, 0.25, 0.2, 0.25, 0.2, 0.25, 0.2, 0.25, 0.2, 4]);
  assert.equal(light.sectors, undefined);
});

test("a light without man_made=lighthouse, a fixed one lit all round", () => {
  const seamark = defined(
    parseSeamark({ "seamark:type": "light_major", "seamark:name": "Lahti", "seamark:light:character": "F", "seamark:light:colour": "red" }, "n2", [0, 0]),
  );
  assert.equal(seamark.kind, "light");
  assert.equal(seamark.name, "Lahti");
  assert.deepEqual(seamark.light, { colour: "red", phases: [] });
});

test("a sectored light's colours by bearing, numbered lights", () => {
  const light = defined(
    parseLight({
      "seamark:light:1:colour": "green",
      "seamark:light:1:character": "F",
      "seamark:light:1:sector_start": "136",
      "seamark:light:1:sector_end": "223",
      "seamark:light:2:colour": "white",
      "seamark:light:2:sector_start": "223",
      "seamark:light:2:sector_end": "400",
    }),
  );
  assert.equal(light.colour, "green");
  assert.deepEqual(light.sectors, [
    { colour: "green", from: 136, to: 223 },
    { colour: "white", from: 223, to: 40 },
  ]);
});

test("buoys and beacons with their colours, pattern, shape and topmark; other seamarks are none", () => {
  const buoy = defined(
    parseSeamark(
      {
        "seamark:type": "buoy_cardinal",
        "seamark:buoy_cardinal:category": "north",
        "seamark:buoy_cardinal:colour": "black;yellow",
        "seamark:buoy_cardinal:colour_pattern": "horizontal",
        "seamark:buoy_cardinal:shape": "spar",
        "seamark:topmark:shape": "2 cones up",
      },
      "n3",
      [1, 2],
    ),
  );
  assert.equal(buoy.kind, "buoy");
  assert.equal(buoy.type, "cardinal");
  assert.equal(buoy.category, "north");
  assert.deepEqual(buoy.colours, ["black", "yellow"]);
  assert.equal(buoy.pattern, "horizontal");
  assert.equal(buoy.shape, "spar");
  assert.equal(buoy.topmark, "2 cones up");
  assert.equal(buoy.light, undefined);
  assert.equal(defined(parseSeamark({ "seamark:type": "beacon_special_purpose" }, "n4", [0, 0])).kind, "beacon");
  assert.equal(parseSeamark({ "seamark:type": "harbour" }, "n5", [0, 0]), undefined);
  assert.equal(parseSeamark({ man_made: "mast" }, "n6", [0, 0]), undefined);
});

test("rhythms from the character, group and period", () => {
  assert.deepEqual(lightPhases("F"), []);
  assert.deepEqual(lightPhases(undefined), []);
  assert.deepEqual(lightPhases("Fl", undefined, 5), [0.5, 4.5]);
  assert.deepEqual(lightPhases("Fl(2)", undefined, 6), [0.5, 1, 0.5, 4]);
  assert.deepEqual(lightPhases("Fl", 3, 10), [0.5, 1, 0.5, 1, 0.5, 6.5]);
  assert.deepEqual(lightPhases("LFl", undefined, 10), [2, 8]);
  assert.deepEqual(lightPhases("Q"), [0.5, 0.5]);
  assert.deepEqual(lightPhases("VQ"), [0.25, 0.25]);
  assert.deepEqual(lightPhases("Q(3)", undefined, 10), [0.5, 0.5, 0.5, 0.5, 0.5, 7.5]);
  assert.deepEqual(lightPhases("IQ", undefined, 4), [0.5, 3.5]);
  assert.deepEqual(lightPhases("Iso", undefined, 4), [2, 2]);
  assert.deepEqual(lightPhases("Oc", undefined, 5), [4, 1]);
  assert.deepEqual(lightPhases("Oc(2)", undefined, 6), [3, 1, 1, 1]);
  assert.deepEqual(lightPhases("Al.Fl", undefined, 4), [0.5, 3.5]);
  // without a period, the character's usual one
  assert.deepEqual(lightPhases("Fl"), [0.5, 4.5]);
});

test("a sequence starting dark goes round to start lit; a period longer than it lengthens the last dark", () => {
  assert.deepEqual(lightPhases("Fl", undefined, undefined, "(2)+1"), [1, 2]);
  assert.deepEqual(lightPhases("Fl", undefined, 5, "1+(2)"), [1, 4]);
  assert.deepEqual(lightPhases("Fl", undefined, 5, "(1)+1+(1)+1"), [1, 1, 1, 2]);
  // what cannot be read falls back on the character
  assert.deepEqual(lightPhases("Fl", undefined, 5, "about a second"), [0.5, 4.5]);
});
