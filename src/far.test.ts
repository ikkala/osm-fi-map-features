import assert from "node:assert/strict";
import { test } from "node:test";
import { FAR_CLASSES, farTile } from "./far.ts";
import type { Point } from "./geometry.ts";
import type { Building, Road } from "./osm.ts";
import type { Tile } from "./tiles.ts";
import { defined } from "./testing.ts";

function tile(features: Partial<Tile> = {}): Tile {
  return {
    x: 1,
    y: 2,
    roads: [],
    rails: [],
    buildings: [],
    areas: [],
    trees: [],
    lamps: [],
    crossings: [],
    signals: [],
    gates: [],
    barriers: [],
    playEquipment: [],
    bridgeDecks: [],
    ...features,
  };
}

function building(outer: Point[], extra: Partial<Building> = {}): Building {
  return { osm: "w1", kind: "yes", part: false, hasParts: false, height: 12, minHeight: 0, polygon: { outer, holes: [] }, ...extra };
}

function road(line: Point[], extra: Partial<Road> = {}): Road {
  return { osm: "w2", kind: "residential", width: 10, layer: 0, bridge: false, tunnel: false, line, ...extra };
}

// The tile covers east 100 ... 200 and north 200 ... 300; a cover of 10 cells has cells of 10 m.
function cell(cells: string, east: number, north: number): string {
  const x = Math.floor((east - 100) / 10);
  const y = Math.floor((300 - north) / 10);
  return FAR_CLASSES[parseInt(cells[y * 10 + x], 36)];
}

test("farTile's cover paints areas, then roads, paths and rails over them, rows from the north", () => {
  const water: Point[] = [[150, 200], [200, 200], [200, 300], [150, 300]];
  const far = farTile(
    tile({
      areas: [{ osm: "w3", kind: "water", polygon: { outer: water, holes: [] } }],
      roads: [
        road([[100, 295], [200, 295]]),
        road([[100, 205], [200, 205]], { kind: "footway", width: 2 }),
        road([[105, 200], [105, 300]], { tunnel: true }),
      ],
    }),
    100,
    { coverSize: 10 },
  );
  assert.equal(far.cover.size, 10);
  assert.equal(far.cover.cells.length, 100);
  assert.equal(cell(far.cover.cells, 125, 250), "ground");
  assert.equal(cell(far.cover.cells, 175, 250), "water");
  // the northmost row is the road's, the southmost the path's, and a tunnel is not drawn
  assert.equal(cell(far.cover.cells, 125, 295), "road");
  assert.equal(cell(far.cover.cells, 175, 205), "path");
  assert.equal(cell(far.cover.cells, 105, 250), "ground");
});

test("farTile makes a turned building a box around it, and leaves out small ones and outlines with parts", () => {
  // a 20 m × 10 m building turned 30 degrees, centred at (150, 250)
  const angle = Math.PI / 6;
  const corner = (u: number, v: number): Point => [150 + u * Math.cos(angle) - v * Math.sin(angle), 250 + u * Math.sin(angle) + v * Math.cos(angle)];
  const turned = building([corner(-10, -5), corner(10, -5), corner(10, 5), corner(-10, 5)], { base: 120, minHeight: 3, colour: "#aa0000" });
  const shed = building([[110, 210], [114, 210], [114, 214], [110, 214]]);
  const outline = building([[160, 260], [190, 260], [190, 290], [160, 290]], { hasParts: true });
  const far = farTile(tile({ buildings: [turned, shed, outline] }), 100);
  assert.equal(far.boxes.length, 1);
  const box = defined(far.boxes[0]);
  assert.ok(Math.abs(box.center[0] - 150) < 1e-6 && Math.abs(box.center[1] - 250) < 1e-6, `centre ${box.center}`);
  assert.ok(Math.abs(box.angle - angle) < 1e-6, `angle ${box.angle}`);
  assert.ok(Math.abs(box.length - 20) < 1e-6 && Math.abs(box.width - 10) < 1e-6, `${box.length} × ${box.width}`);
  assert.deepEqual([box.base, box.minHeight, box.height, box.colour, box.roofColour], [120, 3, 12, "#aa0000", undefined]);
});

test("farTile resamples the heights to a coarse grid over the tile", () => {
  // 1 m apart, rising 1 dm a meter eastward and 2 dm northward
  const count = 101;
  const values: number[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      values.push(1000 + col + 2 * row);
    }
  }
  const far = farTile(tile({ heights: { step: 1, count, values } }), 100, { heightCount: 5 });
  const heights = defined(far.heights);
  assert.deepEqual([heights.step, heights.count], [25, 5]);
  assert.deepEqual(heights.values.slice(0, 5), [1000, 1025, 1050, 1075, 1100]);
  assert.equal(heights.values[4 * 5 + 4], 1300);
  assert.equal(farTile(tile(), 100).heights, undefined);
});
