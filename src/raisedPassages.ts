// Passages through buildings on bridges: a way carried through a building on its deck (setBridgeDecks) opens the
// walls and has its room from the deck up, the wall staying whole under it. A room whose deck or ground slopes along
// it has a ground for each section, a few metres apart, and its ceiling follows them.
import { deckAt } from "./bridges.ts";
import { nearestOnLine, pointInRing, type Point } from "./geometry.ts";
import { NEAR_ROOMS_M, type Building, type PassageRoom } from "./osm.ts";

/** An opening or a room's section is the way's when its middle is within this of the way's side (m) */
const SIDE_M = 0.5;
/** A room's ground slopes along it when its sections' differ by more than this (m) */
const SLOPED_M = 0.25;
/** A sloping room's sections are at most this far apart (m), so that its ceiling follows the ground */
const SLOPE_STEP_M = 3;

function middleOf([l, r]: [Point, Point]): Point {
  return [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2];
}

function lerp(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** The sections, with more between those farther apart than SLOPE_STEP_M */
function finer(sections: [Point, Point][]): [Point, Point][] {
  const out = sections.slice(0, 1);
  for (let i = 1; i < sections.length; i++) {
    const [a, b] = [sections[i - 1], sections[i]];
    const [p, q] = [middleOf(a), middleOf(b)];
    const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / SLOPE_STEP_M);
    for (let k = 1; k < n; k++) {
      out.push([lerp(a[0], b[0], k / n), lerp(a[1], b[1], k / n)]);
    }
    out.push(b);
  }
  return out;
}

/**
 * Sets a room's ground to the highest at its sections' middles when that is over `over`, and where they differ along
 * it by more than SLOPED_M (all of them known), each section's, the sections no farther apart than SLOPE_STEP_M.
 * Whether it set one.
 */
function setRoomGround(room: PassageRoom, at: (p: Point) => number | undefined, over = -Infinity): boolean {
  const sections = finer(room.sections);
  const heights = sections.map((s) => at(middleOf(s)));
  const known = heights.filter((h) => h !== undefined);
  if (known.length === 0 || Math.max(...known) <= over) {
    return false;
  }
  room.ground = Math.max(...known);
  if (known.length === heights.length && room.ground - Math.min(...known) > SLOPED_M) {
    room.sections = sections;
    room.grounds = known;
  }
  return true;
}

interface DeckWay {
  line: Point[];
  width: number;
  deck?: number[];
}

/**
 * Sets the ground of the openings and rooms (see openPassages) of the ways on decks through the buildings to the
 * deck's height there; a room's to the highest of its sections' (see setRoomGround), so its ceiling clears the deck
 * all through.
 */
export function raisePassages(buildings: Building[], ways: DeckWay[]): void {
  const decked = ways.filter((w) => w.deck !== undefined && w.line.length >= 2);
  if (decked.length === 0) {
    return;
  }
  // the deck's height at p of the way p is on, if any
  const deckAtPoint = (p: Point): number | undefined => {
    for (const w of decked) {
      const near = nearestOnLine(w.line, p);
      if (w.deck && near.distance <= w.width / 2 + SIDE_M) {
        return deckAt(w.line, w.deck, near.point);
      }
    }
    return undefined;
  };
  for (const b of buildings) {
    for (const o of b.passages ?? []) {
      const h = deckAtPoint([(o.from[0] + o.to[0]) / 2, (o.from[1] + o.to[1]) / 2]);
      if (h !== undefined) {
        o.ground = h;
      }
    }
    for (const room of b.passageRooms ?? []) {
      if (room.sections.every((s) => deckAtPoint(middleOf(s)) !== undefined)) {
        setRoomGround(room, deckAtPoint);
      }
    }
  }
}

/** The ground at a passage is up its slope when it is this much (m) over the building's base */
const UP_SLOPE_M = 0.2;

/**
 * Sets the ground of the openings and rooms of the passages through buildings that are higher than the building's
 * base (a building on a slope stands at most MAX_PLINTH_M over its lowest ground): an opening's to the ground at
 * its middle, a room's to the highest at the middles of its sections (see setRoomGround), so the way has its room
 * over it all through.
 * Those already with a ground (on a deck, at a door up a slope) keep it. Returns how many openings and rooms.
 */
export function passagesUpSlopes(buildings: Building[], heightAt: (e: number, n: number) => number | undefined): number {
  let count = 0;
  const middle = ([l, r]: [Point, Point]) => heightAt((l[0] + r[0]) / 2, (l[1] + r[1]) / 2);
  for (const b of buildings) {
    const base = b.base;
    if (base === undefined) {
      continue;
    }
    for (const o of b.passages ?? []) {
      const h = o.ground === undefined ? middle([o.from, o.to]) : undefined;
      if (h !== undefined && h > base + UP_SLOPE_M) {
        o.ground = h;
        count++;
      }
    }
    for (const room of b.passageRooms ?? []) {
      if (room.ground === undefined && setRoomGround(room, (p) => heightAt(p[0], p[1]), base + UP_SLOPE_M)) {
        count++;
      }
    }
  }
  matchOpeningsToRooms(buildings);
  return count;
}

/** A room's end section is at an opening when their ends are this close (m) */
const AT_OPENING_M = 0.2;

/**
 * Where rooms of passages are one space, near each other in a building (NEAR_ROOMS_M) or ending at an opening (a
 * building's door, or a wall between two parts with a room on each side), they take the higher ceiling where they
 * meet, a room with a sloping ground there only and one without all through, and the opening reaches up to it from
 * its own ground: no strip of wall or step of ceiling over the way where the ground under it slopes from one room to
 * the next.
 */
export function matchOpeningsToRooms(buildings: Building[]): void {
  // a ceiling raised at an opening raises those of the rooms near it, and theirs at their openings
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const near = matchNearRooms(buildings);
    if (!matchAtOpenings(buildings) && !near) {
      break;
    }
  }
}

/** Rounds of matching at most */
const MAX_PASSES = 10;

/** A room's ceiling at its section k (m above sea level) */
function ceilingAt(room: PassageRoom, base: number, k: number): number {
  return (room.grounds?.[k] ?? room.ground ?? base) + room.height;
}

/** Raises a room's ceiling to `ceiling` at its section k, a room without a sloping ground all through; whether it rose */
function raiseAt(room: PassageRoom, base: number, k: number, ceiling: number): boolean {
  if (ceilingAt(room, base, k) >= ceiling - 1e-9) {
    return false;
  }
  const ground = ceiling - room.height;
  if (room.grounds) {
    room.grounds[k] = ground;
  }
  room.ground = Math.max(room.ground ?? -Infinity, ground);
  return true;
}

/** A room's quadrilaterals (between consecutive sections) */
function quadsOf(room: PassageRoom): Point[][] {
  return room.sections.slice(1).map(([left, right], i) => [room.sections[i][0], room.sections[i][1], right, left]);
}

function closeTo(p: Point, quads: Point[][]): boolean {
  return quads.some((quad) => pointInRing(p, quad) || nearestOnLine([...quad, quad[0]], p).distance <= NEAR_ROOMS_M);
}

/** The sections of room a where room b is in it or nearer than NEAR_ROOMS_M: none where they are apart */
function sectionsNear(a: PassageRoom, b: PassageRoom): number[] {
  const [qa, qb] = [quadsOf(a), quadsOf(b)];
  const near = new Set<number>();
  for (const [k, s] of a.sections.entries()) {
    if ([s[0], s[1], middleOf(s)].some((p) => closeTo(p, qb))) {
      near.add(k);
    }
  }
  for (const [i, quad] of qa.entries()) {
    if (b.sections.flat().some((p) => closeTo(p, [quad]))) {
      near.add(i).add(i + 1);
    }
  }
  return [...near];
}

/** The section of a room whose middle is nearest p */
function nearestSection(room: PassageRoom, p: Point): number {
  let best = 0;
  for (const [k, s] of room.sections.entries()) {
    const [m, n] = [middleOf(s), middleOf(room.sections[best])];
    if (Math.hypot(m[0] - p[0], m[1] - p[1]) < Math.hypot(n[0] - p[0], n[1] - p[1])) {
      best = k;
    }
  }
  return best;
}

/** A building's rooms that are one space take the higher ceiling where they meet; whether one rose */
function matchNearRooms(buildings: Building[]): boolean {
  let rose = false;
  for (const b of buildings) {
    const rooms = b.passageRooms ?? [];
    const base = b.base;
    if (base === undefined || rooms.length < 2) {
      continue;
    }
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let changed = false;
      for (const [i, a] of rooms.entries()) {
        for (const other of rooms.slice(i + 1)) {
          for (const [x, y] of [[a, other], [other, a]]) {
            for (const k of sectionsNear(x, y)) {
              const ceiling = ceilingAt(y, base, nearestSection(y, middleOf(x.sections[k])));
              changed = raiseAt(x, base, k, ceiling) || changed;
            }
          }
        }
      }
      rose ||= changed;
      if (!changed) {
        break;
      }
    }
  }
  return rose;
}

/** Rooms ending at an opening take the highest ceiling of them there, and the opening reaches it; whether one rose */
function matchAtOpenings(buildings: Building[]): boolean {
  const ends: { room: PassageRoom; base: number; k: number }[] = [];
  for (const b of buildings) {
    if (b.base === undefined) {
      continue;
    }
    for (const room of b.passageRooms ?? []) {
      ends.push({ room, base: b.base, k: 0 }, { room, base: b.base, k: room.sections.length - 1 });
    }
  }
  const near = (p: Point, q: Point) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= AT_OPENING_M;
  let rose = false;
  for (const b of buildings) {
    if (b.base === undefined) {
      continue;
    }
    for (const o of b.passages ?? []) {
      const at = ends.filter(({ room, k }) => {
        const [l, r] = room.sections[k];
        return (near(l, o.from) && near(r, o.to)) || (near(l, o.to) && near(r, o.from));
      });
      if (at.length === 0) {
        continue;
      }
      const ceiling = Math.max(...at.map(({ room, base, k }) => ceilingAt(room, base, k)));
      for (const { room, base, k } of at) {
        rose = raiseAt(room, base, k, ceiling) || rose;
      }
      o.height = Math.max(o.height, ceiling - (o.ground ?? b.base));
    }
  }
  return rose;
}
