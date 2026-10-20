import assert from "node:assert/strict";
import test from "node:test";
import type { Point } from "./geometry.ts";
import type { Building } from "./osm.ts";
import { ridgeRoofs } from "./roofRidges.ts";

const building = (outer: Point[], fields: Partial<Building> = {}): Building => ({
  osm: "w1",
  kind: "yes",
  part: true,
  hasParts: false,
  height: 10,
  minHeight: 0,
  roofHeight: 4,
  polygon: { outer, holes: [] },
  ...fields,
});

// a wing 20 m long and 10 m wide, bending at its middle
const WING: Point[] = [[0, 0], [10, 0], [12, 10], [10, 20], [0, 20], [2, 10]];

/** The roof's height (its share) over a point, from the triangle it is in */
function shareAt(faces: { points: number[]; triangles: number[] }, p: Point): number | undefined {
  const at = (i: number) => [faces.points[3 * i], faces.points[3 * i + 1], faces.points[3 * i + 2]];
  for (let t = 0; t < faces.triangles.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => at(faces.triangles[t + k]));
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    const l1 = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / d;
    const l2 = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / d;
    const l3 = 1 - l1 - l2;
    if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) {
      return l1 * a[2] + l2 * b[2] + l3 * c[2];
    }
  }
  return undefined;
}

test("a ridge from side to side bends with the wing: its slopes rise from the eaves to it", () => {
  const wing = building(WING);
  // the ridge from the middle of one end to the other's, through the bend
  assert.equal(ridgeRoofs([wing], [[[5, 0], [7, 10], [5, 20]]]), 1);
  const faces = wing.roofFaces;
  assert.ok(faces);
  // the ridge's ends are on the walls, at the top: the gables under them
  // each slope: its side of the outline from one end of the ridge to the other, and the ridge
  assert.equal(faces.points.length / 3, 2 * (5 + 3));
  assert.equal(shareAt(faces, [7, 10]), 1);
  assert.equal(shareAt(faces, [5, 0.001])?.toFixed(2), "1.00");
  // halfway from the ridge down to the eaves, on both sides of the bend
  assert.equal(shareAt(faces, [4.5, 10])?.toFixed(2), "0.50");
  assert.equal(shareAt(faces, [9.5, 10])?.toFixed(2), "0.50");
  // between the eaves at 1 m and the ridge at 6 m
  assert.equal(shareAt(faces, [2.5, 5])?.toFixed(2), "0.30");
  // the roof covers the outline: two slopes of four triangles each
  assert.equal(faces.triangles.length / 3, 8);
  assert.equal(wing.roofShape, undefined);
});

test("a ridge ending inside the outline is hipped down to the corners beyond it", () => {
  const block = building([[0, 0], [20, 0], [20, 10], [0, 10]]);
  // a gable at the west end, a hip at the east
  assert.equal(ridgeRoofs([block], [[[0, 5], [15, 5]]]), 1);
  const faces = block.roofFaces;
  assert.ok(faces);
  assert.equal(shareAt(faces, [15, 5]), 1);
  assert.equal(shareAt(faces, [0, 5]), 1);
  // the hip's face slopes down to the east wall as the sides do to theirs
  assert.equal(shareAt(faces, [17.5, 5])?.toFixed(2), "0.50");
  assert.equal(shareAt(faces, [10, 2.5])?.toFixed(2), "0.50");
  assert.equal(shareAt(faces, [19.9, 5])?.toFixed(2), "0.02");
  // hipped at both ends
  const hipped = building([[0, 0], [20, 0], [20, 10], [0, 10]]);
  assert.equal(ridgeRoofs([hipped], [[[5, 5], [15, 5]]]), 1);
  assert.equal(shareAt(hipped.roofFaces ?? { points: [], triangles: [] }, [2.5, 5])?.toFixed(2), "0.50");
});

test("no roof from a ridge that does not reach a side, on an outline with parts, or a building with a shape of its own", () => {
  const outside = building(WING);
  assert.equal(ridgeRoofs([outside], [[[5, 0], [7, 10], [25, 10]]]), 0);
  assert.equal(outside.roofFaces, undefined);
  const outline = building(WING, { hasParts: true, part: false });
  const shaped = building(WING, { roofShape: "gabled", roofAngle: 90 });
  const flat = building(WING, { roofHeight: undefined });
  assert.equal(ridgeRoofs([outline, shaped, flat], [[[5, 0], [7, 10], [5, 20]]]), 0);
  // a guessed shape gives way to the ridge
  const guessed = building(WING, { roofShape: "gabled", roofShapeEstimated: true, roofAngle: 0 });
  assert.equal(ridgeRoofs([guessed], [[[5, 0], [7, 10], [5, 20]]]), 1);
  assert.equal(guessed.roofAngle, undefined);
});

test("a ridge ending at a corner, and a second ridge across a slope", () => {
  const square = building([[0, 0], [10, 0], [10, 10], [0, 10]]);
  // corner to corner, then from the diagonal's middle to the far side
  assert.equal(ridgeRoofs([square], [[[0, 0], [10, 10]], [[5, 5], [10, 2]]]), 1);
  const faces = square.roofFaces;
  assert.ok(faces);
  // three slopes: no point added at the corners, the second ridge's end on the side
  assert.equal(shareAt(faces, [10, 10]), 1);
  assert.equal(shareAt(faces, [10, 2]), 1);
  assert.equal(shareAt(faces, [0, 10]), 0);
});
