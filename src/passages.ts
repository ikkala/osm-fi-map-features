// Ways through buildings: the walls opened where a way passes through a building (a building passage, a tunnel or
// covered way found to run through one, a railway into a hall, a covered way at a door) and the rooms through it.
import { fillUnderFloatingParts, markBuildingsWithParts, groundFloatingBuildings, raiseRoofsOverRoads } from "./buildingParts.ts";
import { crossing, dedupe, distanceToRing, indexBoxes, nearestOnLine, pointInPolygon, pointInRing, pointKey, pushTo, rectsMeet, type Point, type Polygon, type Ring } from "./geometry.ts";
import { bounds, PASSAGE_HEIGHT_M, WALKWAY_PASSAGE_HEIGHT_M, type Building, type ParseResult, type Passage, type PassageRoom, type Rail, type Road } from "./osm.ts";
import { inTunnel, isBridge } from "./profile.ts";
import { ridgeRoofs } from "./roofRidges.ts";
import { WALKWAYS } from "./ways.ts";

/** A building passage ending inside its building goes on straight to the wall when the wall is this near (m) */
const PASSAGE_ON_M = 10;
/** A passage's end this near (m) a wall of its building is on the wall */
const AT_WALL_M = 0.3;
/** A passage gone on to a wall goes this far (m) past it, so that it crosses the wall */
const PAST_WALL_M = 1;

/** A covered way comes in at a door in OSM when one of its points is this close to it (m) */
const DOOR_ON_WAY_M = 0.5;
/** A covered way coming in at a door opens the wall at most this wide (m): a double door */
const DOORWAY_WIDTH_M = 1.8;

/**
 * Opens the walls of the buildings (and parts reaching the ground) where passages cross them: as wide
 * as the way along the wall, wider where it crosses at a slant. A passage taller than 0 also gets a
 * room through the building (see PassageRoom), unless rooms is false.
 */
export function openPassages(buildings: Building[], passages: Passage[], rooms = true): void {
  const roomed = new Set<Building>();
  const boxes = buildings.map((b) => bounds(b.polygon.outer));
  const near = indexBoxes(boxes, bounds(passages.flatMap((passage) => passage.line)));
  for (const passage of passages) {
    const reach = bounds(passage.line);
    const segments = passage.line.slice(1).map((q, k) => bounds([passage.line[k], q]));
    for (const index of near(reach)) {
      const b = buildings[index];
      if (b.hasParts || b.shelter !== undefined || b.minHeight > passage.height) {
        continue;
      }
      const box = boxes[index];
      if (!rectsMeet(box, reach)) {
        continue;
      }
      // a segment crosses the walls only where its box meets the building's
      const crossable = segments.flatMap((segment, k) => (rectsMeet(segment, box) ? [k] : []));
      for (const ring of [b.polygon.outer, ...b.polygon.holes]) {
        for (let i = 0; i < ring.length; i++) {
          for (const k of crossable) {
            const hit = crossing(ring[i], ring[(i + 1) % ring.length], passage.line[k], passage.line[k + 1], passage.width);
            if (hit) {
              for (const opening of openAlong(ring, i, hit.at, hit.half)) {
                if (!b.passages?.some((o) => samePoint(o.from, opening.from) && samePoint(o.to, opening.to))) {
                  (b.passages ??= []).push({ ...opening, height: passage.height });
                }
              }
            }
          }
        }
      }
      if (passage.height > 0 && rooms) {
        const through = roomsThrough(b.polygon, passage);
        if (through.length > 0) {
          (b.passageRooms ??= []).push(...through);
          roomed.add(b);
        }
      }
    }
  }
  for (const b of roomed) {
    joinNearRooms(b.passageRooms ?? []);
    setRoomWalls(b.passageRooms ?? []);
  }
}

/** A railway into a hall (a depot) opens its walls this wide (m), and the hall is at least this tall */
const RAIL_DOOR_WIDTH_M = 4.5;
const RAIL_HALL_HEIGHT_M = 6;

/**
 * Opens the walls of the buildings a railway runs into (depots, halls) where the track crosses them, and makes a
 * lower one RAIL_HALL_HEIGHT_M tall: OSM seldom maps their doors, and a hall of one storey is taken as 3 m. Returns
 * how many buildings were opened.
 */
export function openRailHalls(buildings: Building[], rails: Rail[]): number {
  const before = new Map(buildings.map((b) => [b, b.passages?.length ?? 0]));
  const passages = rails
    .filter((r) => !inTunnel(r) && !isBridge(r) && r.line.length >= 2)
    .map((r) => ({ line: r.line, width: RAIL_DOOR_WIDTH_M, height: RAIL_HALL_HEIGHT_M - 1 }));
  openPassages(buildings, passages, false);
  let count = 0;
  for (const [b, passages] of before) {
    if ((b.passages?.length ?? 0) > passages) {
      b.height = Math.max(b.height, RAIL_HALL_HEIGHT_M);
      count++;
    }
  }
  return count;
}

/**
 * Opens the walls of stair halls (see bases.ts) where a covered way comes in at one of their doors, from the
 * ground there, at most a door's width (DOORWAY_WIDTH_M) and without a room. heightAt gives the ground at map
 * meters. Returns the number of openings.
 */
export function openDoorways(buildings: Building[], ways: Road[], heightAt: (e: number, n: number) => number | undefined): number {
  let count = 0;
  for (const way of ways) {
    const reach = bounds(way.line);
    for (const b of buildings) {
      const box = bounds(b.polygon.outer);
      if (!rectsMeet(box, reach, DOOR_ON_WAY_M)) {
        continue;
      }
      const atDoor = (b.entrances ?? []).some((e) => !e.guessed && way.line.some((p) => Math.hypot(p[0] - e.at[0], p[1] - e.at[1]) < DOOR_ON_WAY_M));
      if (!atDoor) {
        continue;
      }
      const before = b.passages?.length ?? 0;
      openPassages([b], [{ line: way.line, width: Math.min(way.width, DOORWAY_WIDTH_M), height: WALKWAYS.has(way.kind) ? WALKWAY_PASSAGE_HEIGHT_M : PASSAGE_HEIGHT_M }], false);
      for (const opening of (b.passages ?? []).slice(before)) {
        const ground = heightAt((opening.from[0] + opening.to[0]) / 2, (opening.from[1] + opening.to[1]) / 2);
        if (ground !== undefined) {
          opening.ground = ground;
        }
        count++;
      }
    }
  }
  return count;
}

/** A room's side turning at a corner of its way reaches at most this many half-widths from the way */
const MAX_MITRE = 3;
/** Places this close along a way (meters) are one (a way's node on a building's outline) */
const SAME_PLACE_M = 0.01;

/**
 * The rooms of a passage through a building's polygon: one for each stretch of it inside, from where it
 * comes in (as wide as its opening in the wall) or starts inside, through its corners, to where it goes
 * out or ends. Their walls are set by setRoomWalls.
 */
function roomsThrough(polygon: Polygon, passage: Passage): PassageRoom[] {
  const line = dedupe(passage.line);
  const half = passage.width / 2;
  // meters along the line to each point, and each segment's unit normal to its left
  const run = [0];
  const normals: Point[] = [];
  for (let k = 0; k + 1 < line.length; k++) {
    const length = Math.hypot(line[k + 1][0] - line[k][0], line[k + 1][1] - line[k][1]);
    run.push(run[k] + length);
    normals.push([-(line[k + 1][1] - line[k][1]) / length, (line[k + 1][0] - line[k][0]) / length]);
  }
  if (normals.length === 0) {
    return [];
  }
  const pointAt = (along: number): Point => {
    let k = 0;
    while (k + 2 < line.length && run[k + 1] < along) {
      k++;
    }
    const s = (along - run[k]) / (run[k + 1] - run[k]);
    return [line[k][0] + (line[k + 1][0] - line[k][0]) * s, line[k][1] + (line[k + 1][1] - line[k][1]) * s];
  };

  // where sections go across the way: its points (mitred at a corner) and where it crosses the outline
  const sections: { along: number; section: [Point, Point]; crossing: boolean }[] = [];
  for (let i = 0; i < line.length; i++) {
    const [before, after] = [normals[Math.max(0, i - 1)], normals[Math.min(normals.length - 1, i)]];
    const sum = Math.hypot(before[0] + after[0], before[1] + after[1]);
    const mitre: Point = sum < 1e-9 ? after : [(before[0] + after[0]) / sum, (before[1] + after[1]) / sum];
    const reach = Math.min(half / Math.max(1e-9, mitre[0] * after[0] + mitre[1] * after[1]), half * MAX_MITRE);
    const p = line[i];
    sections.push({
      along: run[i],
      section: [
        [p[0] + mitre[0] * reach, p[1] + mitre[1] * reach],
        [p[0] - mitre[0] * reach, p[1] - mitre[1] * reach],
      ],
      crossing: false,
    });
  }
  for (const ring of [polygon.outer, ...polygon.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const [a, c] = [ring[i], ring[(i + 1) % ring.length]];
      const wall = Math.hypot(c[0] - a[0], c[1] - a[1]);
      for (let k = 0; k + 1 < line.length; k++) {
        const hit = crossing(a, c, line[k], line[k + 1], passage.width);
        if (hit && wall > 1e-9) {
          // across the opening along the wall, its ends on the way's left and right
          const x: Point = [a[0] + (c[0] - a[0]) * hit.at, a[1] + (c[1] - a[1]) * hit.at];
          const [ue, un] = [((c[0] - a[0]) / wall) * hit.half, ((c[1] - a[1]) / wall) * hit.half];
          const leftward = ue * normals[k][0] + un * normals[k][1] > 0;
          const [ahead, back]: Point[] = [
            [x[0] + ue, x[1] + un],
            [x[0] - ue, x[1] - un],
          ];
          const along = run[k] + Math.hypot(x[0] - line[k][0], x[1] - line[k][1]);
          sections.push({ along, section: leftward ? [ahead, back] : [back, ahead], crossing: true });
        }
      }
    }
  }
  // one section at a place, a crossing rather than a point of the way on the outline
  sections.sort((s, t) => s.along - t.along || Number(t.crossing) - Number(s.crossing));
  const places = sections.filter((s, i) => i === 0 || s.along - sections[i - 1].along > SAME_PLACE_M);

  const rooms: PassageRoom[] = [];
  let room: PassageRoom | undefined;
  // an end inside the building is walled across; one on its wall (within AT_WALL_M) is the wall's to close or open
  const closedAt = (place: { along: number; crossing: boolean }) =>
    !place.crossing && [polygon.outer, ...polygon.holes].every((ring) => distanceToRing(pointAt(place.along), ring) > AT_WALL_M);
  for (let j = 0; j + 1 < places.length; j++) {
    if (pointInPolygon(pointAt((places[j].along + places[j + 1].along) / 2), polygon)) {
      room ??= { sections: [places[j].section], height: passage.height, closed: [closedAt(places[j]), false], walls: [] };
      room.sections.push(places[j + 1].section);
      room.closed[1] = closedAt(places[j + 1]);
    } else if (room) {
      rooms.push(room);
      room = undefined;
    }
  }
  if (room) {
    rooms.push(room);
  }
  return rooms;
}

/** Rooms of a building nearer than this (m) side by side are one space, as ways along each other with a rail between */
export const NEAR_ROOMS_M = 0.6;

/**
 * Rooms of a building nearer than NEAR_ROOMS_M side by side meet halfway: each corner of their sections that near
 * another room (not in it) moves halfway to it, an open end's only along it, on the building's wall; so that no strip
 * of ceiling is missing between them and their walls there go (setRoomWalls: another room behind them)
 */
function joinNearRooms(rooms: PassageRoom[]): void {
  const quads = rooms.map((room) => room.sections.slice(1).map(([left, right], i): Point[] => [room.sections[i][0], room.sections[i][1], right, left]));
  // an open end's corners move only along it, on the building's wall
  const open = (room: PassageRoom, i: number) => (i === 0 && !room.closed[0]) || (i === room.sections.length - 1 && !room.closed[1]);
  const moved = rooms.map((room, r) =>
    room.sections.map((section, i): [Point, Point] => {
      const [left, right] = [toward(section[0], r), toward(section[1], r)];
      return open(room, i) ? [along(section, left), along(section, right)] : [left, right];
    }),
  );
  rooms.forEach((room, r) => {
    room.sections = moved[r];
  });

  // a point onto a section's line
  function along([a, b]: [Point, Point], p: Point): Point {
    const [de, dn] = [b[0] - a[0], b[1] - a[1]];
    const length2 = de * de + dn * dn;
    const k = length2 > 0 ? ((p[0] - a[0]) * de + (p[1] - a[1]) * dn) / length2 : 0;
    return [a[0] + de * k, a[1] + dn * k];
  }

  // a corner halfway to the nearest other room within NEAR_ROOMS_M, unless it is in one
  function toward(p: Point, r: number): Point {
    let nearest: Point | undefined;
    let distance = NEAR_ROOMS_M;
    for (const [o, others] of quads.entries()) {
      for (const quad of o === r ? [] : others) {
        if (pointInRing(p, quad)) {
          return p;
        }
        const near = nearestOnLine([...quad, quad[0]], p);
        if (near.distance < distance) {
          distance = near.distance;
          nearest = near.point;
        }
      }
    }
    return nearest ? [(p[0] + nearest[0]) / 2, (p[1] + nearest[1]) / 2] : p;
  }
}

/** A room's wall goes where another room is this far (m) behind it */
const BEHIND_WALL_M = 0.1;

/**
 * Sets the walls of a building's passage rooms: along both sides of each, and across its closed ends,
 * less where another room goes on: behind a side (a way beside it or across it: one space), and where an end
 * lies in it. Rooms overlapping on the same side of a side wall, as a passage carried on through its building's
 * wall (passagesOnToWalls) over the passage's own, both keep it; the passage's end just inside the wall is open
 * where the carried-on room goes on out through the wall. Nor is a gap walled that is all within NEAR_ROOMS_M of
 * two other rooms, one at each end (a walk and steps beside it going on from a wider way's end).
 */
function setRoomWalls(rooms: PassageRoom[]): void {
  const quads = rooms.map((room) =>
    room.sections.slice(1).map(([left, right], i): Point[] => [room.sections[i][0], room.sections[i][1], right, left]),
  );
  // the other rooms within NEAR_ROOMS_M of a point
  const near = (p: Point, r: number) =>
    quads.flatMap((others, o) =>
      o !== r && others.some((quad) => pointInRing(p, quad) || nearestOnLine([...quad, quad[0]], p).distance <= NEAR_ROOMS_M) ? [o] : [],
    );
  // a piece of wall all within NEAR_ROOMS_M of other rooms, its ends of different ones: a gap between them; not of a
  // room over this one at the piece, on its side of it (the room is on the wall's right), which is no gap
  const between = ([a, b]: [Point, Point], r: number) => {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.ceil(length / (NEAR_ROOMS_M / 2));
    const at = (k: number): Point => [a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps];
    const inside: Point = [(a[0] + b[0]) / 2 + ((b[1] - a[1]) / length) * BEHIND_WALL_M, (a[1] + b[1]) / 2 - ((b[0] - a[0]) / length) * BEHIND_WALL_M];
    const over = new Set(quads.flatMap((others, o) => (o !== r && others.some((quad) => pointInRing(inside, quad)) ? [o] : [])));
    const around = (p: Point) => near(p, r).filter((o) => !over.has(o));
    const [first, last] = [around(a), around(b)];
    return first.some((p) => last.some((q) => q !== p)) && Array.from({ length: steps - 1 }, (_, k) => at(k + 1)).every((p) => around(p).length > 0);
  };
  rooms.forEach((room, r) => {
    const { sections, closed } = room;
    const last = sections.length - 1;
    // each with whether it is across an end
    const walls: [Point, Point, boolean][] = [];
    if (closed[0]) {
      walls.push([sections[0][1], sections[0][0], true]);
    }
    for (let i = 0; i < last; i++) {
      walls.push([sections[i][0], sections[i + 1][0], false]);
    }
    if (closed[1]) {
      walls.push([sections[last][0], sections[last][1], true]);
    }
    for (let i = last; i > 0; i--) {
      walls.push([sections[i][1], sections[i - 1][1], false]);
    }
    const others = quads.filter((_, o) => o !== r).flat();
    room.walls = walls.flatMap(([a, b, end]) => {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < 1e-9) {
        return [];
      }
      // a side looked at a little behind it, on its left (the room is on its right); an end where it is
      const [be, bn] = end ? [0, 0] : [(-(b[1] - a[1]) / length) * BEHIND_WALL_M, ((b[0] - a[0]) / length) * BEHIND_WALL_M];
      const [ba, bb]: [Point, Point] = [
        [a[0] + be, a[1] + bn],
        [b[0] + be, b[1] + bn],
      ];
      const spans = others.map((quad) => spanInside(ba, bb, quad)).filter((span) => span !== undefined);
      return spansLeft(spans)
        .filter(([t0, t1]) => (t1 - t0) * length > SAME_PLACE_M)
        .map(([t0, t1]): [Point, Point] => [
          [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0],
          [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1],
        ])
        .filter((piece) => !between(piece, r));
    });
  });
}

/**
 * The span (0 .. 1) of the segment a -> b in a convex polygon or on its edges (within SAME_PLACE_M), or
 * undefined.
 */
function spanInside(a: Point, b: Point, polygon: Point[]): [number, number] | undefined {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [p, q] = [polygon[i], polygon[(i + 1) % polygon.length]];
    area += p[0] * q[1] - q[0] * p[1];
  }
  if (Math.abs(area) < 1e-9) {
    return undefined;
  }
  let [t0, t1] = [0, 1];
  for (let i = 0; i < polygon.length; i++) {
    const [p, q] = [polygon[i], polygon[(i + 1) % polygon.length]];
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (length < 1e-9) {
      continue;
    }
    // how far inside the edge's line a point is (meters), and a little more
    const inside = (x: Point) => (Math.sign(area) * ((q[0] - p[0]) * (x[1] - p[1]) - (q[1] - p[1]) * (x[0] - p[0]))) / length + SAME_PLACE_M;
    const [fa, fb] = [inside(a), inside(b)];
    if (fa < 0 && fb < 0) {
      return undefined;
    }
    if (fa < 0) {
      t0 = Math.max(t0, fa / (fa - fb));
    } else if (fb < 0) {
      t1 = Math.min(t1, fa / (fa - fb));
    }
  }
  return t0 < t1 ? [t0, t1] : undefined;
}

/** What is left of 0 .. 1 without the spans */
function spansLeft(spans: [number, number][]): [number, number][] {
  const left: [number, number][] = [];
  let at = 0;
  for (const [t0, t1] of spans.sort((s, t) => s[0] - t[0])) {
    if (t0 > at) {
      left.push([at, t0]);
    }
    at = Math.max(at, t1);
  }
  if (at < 1) {
    left.push([at, 1]);
  }
  return left;
}

/**
 * Whether a tunnel or covered way is really a passage through buildings (often tagged tunnel=yes): short (an
 * arcade, along a building's front, may be long), at least half inside one, and neither end well inside (a ramp
 * into a garage ends inside) unless another way goes on from it (goesOn). The caller leaves out layers under -1.
 */
function runsThroughBuildings(line: Point[], buildings: Building[], arcade = false, goesOn: (p: Point) => boolean = () => false): boolean {
  let length = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    length += Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
  }
  if (length > MAX_GUESSED_PASSAGE_M && !arcade) {
    return false;
  }
  const reach = bounds(line);
  const grounded = buildings.filter((b) => {
    if (b.hasParts || b.shelter !== undefined || b.minHeight >= 1) {
      return false;
    }
    const box = bounds(b.polygon.outer);
    return rectsMeet(box, reach);
  });
  const deepInside = (p: Point) =>
    !goesOn(p) && grounded.some((b) => pointInPolygon(p, b.polygon) && distanceToRing(p, b.polygon.outer) > THROUGH_END_SLACK_M);
  if (grounded.length === 0 || deepInside(line[0]) || deepInside(line[line.length - 1])) {
    return false;
  }
  let inside = 0;
  let total = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const [p, q] = [line[i], line[i + 1]];
    const steps = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1])));
    for (let k = 0; k < steps; k++) {
      const point: Point = [p[0] + ((q[0] - p[0]) * (k + 0.5)) / steps, p[1] + ((q[1] - p[1]) * (k + 0.5)) / steps];
      total++;
      if (grounded.some((b) => pointInPolygon(point, b.polygon))) {
        inside++;
      }
    }
  }
  return inside >= total / 2;
}

/** A way's end this close to a building's edge is not inside it (meters) */
const THROUGH_END_SLACK_M = 1;
/** A tunnel or covered way longer than this is not taken for a passage through buildings (meters) */
const MAX_GUESSED_PASSAGE_M = 60;

/** Walls meeting at a corner that turns less than this (radians) are one wall for a passage */
const STRAIGHT_ON = (30 * Math.PI) / 180;

/**
 * The stretches, one per edge, `half` meters either way along the ring from `at` (0 .. 1) on edge i: on
 * into the next edges where the wall goes on nearly straight.
 */
function openAlong(ring: Ring, i: number, at: number, half: number): { from: Point; to: Point }[] {
  const count = ring.length;
  const edge = (j: number) => {
    const a = ring[((j % count) + count) % count];
    const c = ring[(((j + 1) % count) + count) % count];
    return { a, c, length: Math.hypot(c[0] - a[0], c[1] - a[1]) };
  };
  const along = (j: number, k: number): Point => {
    const { a, c } = edge(j);
    return [a[0] + (c[0] - a[0]) * k, a[1] + (c[1] - a[1]) * k];
  };
  const turn = (j: number) => {
    // the turn at the start of edge j
    const before = edge(j - 1);
    const after = edge(j);
    const angle = Math.atan2(after.c[1] - after.a[1], after.c[0] - after.a[0]) - Math.atan2(before.c[1] - before.a[1], before.c[0] - before.a[0]);
    return Math.abs(((angle + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
  };
  const first = edge(i);
  const back = Math.min(at, half / first.length);
  const ahead = Math.min(1 - at, half / first.length);
  const stretches = [{ from: along(i, at - back), to: along(i, at + ahead) }];
  // backwards through the edges before
  let left = half - back * first.length;
  for (let j = i; left > 1e-6 && j > i - count + 1 && turn(j) < STRAIGHT_ON; j--) {
    const previous = edge(j - 1);
    const k = Math.min(1, left / previous.length);
    stretches.push({ from: along(j - 1, 1 - k), to: along(j - 1, 1) });
    left -= k * previous.length;
  }
  // and forwards through the edges after
  left = half - ahead * first.length;
  for (let j = i + 1; left > 1e-6 && j < i + count && turn(j) < STRAIGHT_ON; j++) {
    const next = edge(j);
    const k = Math.min(1, left / next.length);
    stretches.push({ from: along(j, 0), to: along(j, k) });
    left -= k * next.length;
  }
  return stretches.filter((s) => !samePoint(s.from, s.to));
}

function samePoint(a: Point, b: Point | undefined): boolean {
  return b !== undefined && Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
}

/**
 * Building passages, tagged or found to run through buildings (an arcade, a tunnel), that end at their building's wall
 * or short of it, where another way goes on (on the ground as the passage is, neither a tunnel nor a bridge, whatever
 * its layer): an end on the wall, within AT_WALL_M of it (at a corner), does not
 * cross it, and OSM's tag is at times split off a little inside. The passage goes on straight from its last stretch
 * to the wall and PAST_WALL_M through it, when the wall is within PASSAGE_ON_M; returns those passages, which open
 * the wall there (openPassages, which opens a wall once however many passages cross it there).
 */
export function passagesOnToWalls(tagged: { road: Road; passage: Passage }[], roads: Road[], buildings: Building[]): Passage[] {
  const passageRoads = new Set(tagged.map(({ road }) => road));
  const at = new Map<string, Road[]>();
  for (const road of roads) {
    for (const p of road.line) {
      pushTo(at, pointKey(p), road);
    }
  }
  const boxes = buildings.map((b) => bounds(b.polygon.outer));
  const found: Passage[] = [];
  for (const { road, passage } of tagged) {
    const line = road.line;
    for (const [end, before] of [
      [line[0], line[1]],
      [line[line.length - 1], line[line.length - 2]],
    ]) {
      const goesOn = (at.get(pointKey(end)) ?? []).filter((r) => r !== road && !passageRoads.has(r));
      // ways on the ground go on from it, whatever their layers (an arcade under its building's floors is often
      // tagged a layer over the street's)
      if (goesOn.length === 0 || goesOn.some((r) => inTunnel(r) || isBridge(r) || r.layer < 0 !== road.layer < 0)) {
        continue;
      }
      const inside = buildings.find(
        (b, i) =>
          !b.hasParts &&
          b.minHeight <= passage.height &&
          end[0] >= boxes[i].minX && end[0] <= boxes[i].maxX && end[1] >= boxes[i].minY && end[1] <= boxes[i].maxY &&
          (pointInPolygon(end, b.polygon) || distanceToRing(end, b.polygon.outer) <= AT_WALL_M),
      );
      const length = Math.hypot(end[0] - before[0], end[1] - before[1]);
      if (!inside || length < 1e-9) {
        continue;
      }
      const along = (d: number): Point => [end[0] + ((end[0] - before[0]) * d) / length, end[1] + ((end[1] - before[1]) * d) / length];
      // the first half meter on out of the building, then the wall in it, by halving
      let step = 0.5;
      while (step <= PASSAGE_ON_M && pointInPolygon(along(step), inside.polygon)) {
        step += 0.5;
      }
      if (step > PASSAGE_ON_M) {
        continue;
      }
      let [lo, hi] = [step - 0.5, step];
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        [lo, hi] = pointInPolygon(along(mid), inside.polygon) ? [mid, hi] : [lo, mid];
      }
      // from inside, so that it crosses the wall clear of its end (one just outside, past a corner, crossed nowhere)
      found.push({ ...passage, line: [along(-PAST_WALL_M), along(hi + PAST_WALL_M)] });
    }
  }
  return found;
}

/** The ways through buildings, once the buildings are opened for them */
export interface ThroughBuildings {
  /** Covered ways (covered=yes) that are no passages through buildings: they may come in at a door (see openDoorways) */
  covered: Road[];
  /** Whether a road runs through buildings: a building passage, or a tunnel or covered way found to (see setBridgeDecks) */
  throughBuildings: (road: Road) => boolean;
}

/**
 * Fits the parsed buildings to the ways through them: marks the outlines drawn by their parts and shapes the roofs
 * along ridges, finds the tunnels and covered ways that run through buildings (built as passages, no longer in
 * tunnels: `passage`), fills under the parts raised off the ground and grounds the buildings floating over nothing, carries the
 * passages on to their buildings' walls and opens the walls and rooms for them, and lifts open roofs over roads.
 */
export function openBuildings(parsed: ParseResult): ThroughBuildings {
  const { features, ridges, maybePassages, basements, levels, tagged, covered } = parsed;
  const passages = [...parsed.passages];
  const through = new Set(parsed.through);
  markBuildingsWithParts(features.buildings);
  ridgeRoofs(features.buildings, ridges);
  const found = new Set<Road>();
  // how many ways have each point: the end of a covered way on the ground floor where another goes on is no dead end
  // (a ramp down into a garage goes on into its tunnel, a way on an upper storey into the building)
  const ways = new Map<string, number>();
  for (const r of features.roads) {
    for (const key of new Set(r.line.map(pointKey))) {
      ways.set(key, (ways.get(key) ?? 0) + 1);
    }
  }
  for (const { road, passage, arcade } of maybePassages) {
    if (inTunnel(road) && [road.line[0], road.line[road.line.length - 1]].some((p) => basements.has(pointKey(p)))) {
      continue;
    }
    const groundFloor = !inTunnel(road) && road.layer >= 0 && (levels.get(road) ?? [0]).every((storey) => storey === 0);
    const goesOn = (p: Point) => groundFloor && (ways.get(pointKey(p)) ?? 0) > 1;
    if (runsThroughBuildings(passage.line, features.buildings, arcade, goesOn)) {
      road.passage = true;
      passages.push(passage);
      found.add(road);
      through.add(road);
      // carried on through the wall it ends at, as a tagged one
      tagged.push({ road, passage });
    }
  }
  features.buildings.push(...fillUnderFloatingParts(features));
  groundFloatingBuildings(features);
  passages.push(...passagesOnToWalls(tagged, features.roads, features.buildings));
  openPassages(features.buildings, passages);
  raiseRoofsOverRoads(features);
  return { covered: covered.filter((r) => !found.has(r)), throughBuildings: (road) => through.has(road) };
}
