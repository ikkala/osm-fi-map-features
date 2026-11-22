import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point } from "./geometry.ts";
import type { Rail, Road } from "./osm.ts";
import { inTunnel, isBridge, offStructures, onGround, profileOf } from "./profile.ts";

const line: Point[] = [
  [0, 0],
  [10, 0],
];
const road = (extra: Partial<Road>): Road => ({ osm: "w1", kind: "residential", width: 6, layer: 0, bridge: false, tunnel: false, line, ...extra });
const rail = (extra: Partial<Rail>): Rail => ({ osm: "w2", kind: "rail", layer: 0, bridge: false, tunnel: false, line, ...extra });

test("a way's profile is what the map built it on, its heights those of the kind", () => {
  const two = [90, 91];
  assert.deepEqual(
    [
      road({}),
      rail({ bed: two }),
      road({ tunnel: true, lid: two }),
      road({ tunnel: true, floor: two }),
      road({ tunnel: true }),
      road({ floor: two }),
      road({ deck: two }),
      road({ bridge: true, deck: two }),
      road({ bridge: true, boardwalk: true, deck: two }),
      road({ bridge: true }),
    ].map(profileOf),
    [
      { kind: "ground" },
      { kind: "bed", heights: two },
      { kind: "lid", heights: two },
      { kind: "bored", heights: two },
      { kind: "bored" },
      { kind: "cut", heights: two },
      { kind: "approach", heights: two },
      { kind: "deck", heights: two },
      { kind: "boardwalk", heights: two },
      { kind: "deck" },
    ],
  );
  assert.deepEqual(
    (["ground", "bed", "lid", "bored", "cut", "approach", "deck", "boardwalk"] as const).filter(onGround),
    ["ground", "bed", "lid"],
  );
  assert.deepEqual([road({}), rail({ bed: two }), road({ tunnel: true, lid: two }), road({ deck: two }), road({ floor: two })].map(offStructures), [true, true, false, false, false]);
});

test("where the stages build a way otherwise than OSM tags it, its profile is as built", () => {
  const two = [90, 91];
  assert.deepEqual(
    [
      road({ overLid: true, deck: two }),
      road({ tunnel: true, atGrade: true }),
      road({ tunnel: true, passage: true }),
      rail({ tunnel: true, atGrade: true, floor: two }),
    ].map(profileOf),
    [{ kind: "deck", heights: two }, { kind: "ground" }, { kind: "ground" }, { kind: "cut", heights: two }],
  );
  assert.deepEqual([isBridge(road({ overLid: true })), isBridge(road({})), inTunnel(road({ tunnel: true })), inTunnel(road({ tunnel: true, passage: true }))], [true, false, true, false]);
});
