// Passages through buildings on bridges: a way carried through a building on its deck (setBridgeDecks) opens the
// walls and has its room from the deck up, the wall staying whole under it.
import { deckAt } from "./bridges.ts";
import { nearestOnLine, pointInRing, type Point } from "./geometry.ts";
import { NEAR_ROOMS_M, type Building, type PassageRoom } from "./osm.ts";

/** An opening or a room's section is the way's when its middle is within this of the way's side (m) */
const SIDE_M = 0.5;

interface DeckWay {
  line: Point[];
  width: number;
  deck?: number[];
}

/**
 * Sets the ground of the openings and rooms (see openPassages) of the ways on decks through the buildings to the
 * deck's height there; a room's to the highest of its sections', so its ceiling clears the deck all through.
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
      const heights = room.sections.map(([l, r]) => deckAtPoint([(l[0] + r[0]) / 2, (l[1] + r[1]) / 2]));
      if (heights.length > 0 && heights.every((h) => h !== undefined)) {
        room.ground = Math.max(...heights.filter((h) => h !== undefined));
      }
    }
  }
}

/** The ground at a passage is up its slope when it is this much (m) over the building's base */
const UP_SLOPE_M = 0.2;

/**
 * Sets the ground of the openings and rooms of the passages through buildings that are higher than the building's
 * base (a building on a slope stands at most MAX_PLINTH_M over its lowest ground): an opening's to the ground at
 * its middle, a room's to the highest at the middles of its sections, so the way has its room over it all through.
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
      const heights = room.ground === undefined ? room.sections.map(middle).filter((h) => h !== undefined) : [];
      const h = heights.length > 0 ? Math.max(...heights) : undefined;
      if (h !== undefined && h > base + UP_SLOPE_M) {
        room.ground = h;
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
 * building's door, or a wall between two parts with a room on each side), all take the highest ceiling of them, and
 * the opening reaches up to it from its own ground: no strip of wall or step of ceiling over the way where the ground
 * under it slopes from one room to the next.
 */
export function matchOpeningsToRooms(buildings: Building[]): void {
  // twice: a ceiling raised at an opening raises those of the rooms near it, and theirs at their openings
  for (let pass = 0; pass < 2; pass++) {
    matchNearRooms(buildings);
    matchAtOpenings(buildings);
  }
}

/** A room's quadrilaterals (between consecutive sections) */
function quadsOf(room: PassageRoom): Point[][] {
  return room.sections.slice(1).map(([left, right], i) => [room.sections[i][0], room.sections[i][1], right, left]);
}

/** Whether two rooms are one space: overlapping, or nearer than NEAR_ROOMS_M side by side */
function near(a: PassageRoom, b: PassageRoom): boolean {
  const [qa, qb] = [quadsOf(a), quadsOf(b)];
  const corners = (qs: Point[][]) => qs.flat();
  const close = (points: Point[], qs: Point[][]) =>
    points.some((p) => qs.some((quad) => pointInRing(p, quad) || nearestOnLine([...quad, quad[0]], p).distance <= NEAR_ROOMS_M));
  return close(corners(qa), qb) || close(corners(qb), qa);
}

/** A building's rooms that are one space take the highest ceiling of them */
function matchNearRooms(buildings: Building[]): void {
  for (const b of buildings) {
    const rooms = b.passageRooms ?? [];
    const base = b.base;
    if (base === undefined || rooms.length < 2) {
      continue;
    }
    // the spaces: rooms joined to each other, near by near
    const space = rooms.map((_, i) => i);
    const find = (i: number): number => (space[i] === i ? i : (space[i] = find(space[i])));
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        if (find(i) !== find(j) && near(rooms[i], rooms[j])) {
          space[find(i)] = find(j);
        }
      }
    }
    const ceilings = new Map<number, number>();
    for (const [i, room] of rooms.entries()) {
      const top = (room.ground ?? base) + room.height;
      ceilings.set(find(i), Math.max(ceilings.get(find(i)) ?? -Infinity, top));
    }
    for (const [i, room] of rooms.entries()) {
      const ceiling = ceilings.get(find(i)) ?? -Infinity;
      if ((room.ground ?? base) + room.height < ceiling) {
        room.ground = ceiling - room.height;
      }
    }
  }
}

/** Rooms ending at an opening take the highest ceiling of them, and the opening reaches it */
function matchAtOpenings(buildings: Building[]): void {
  const ends: { room: PassageRoom; base: number; end: [Point, Point] }[] = [];
  for (const b of buildings) {
    if (b.base === undefined) {
      continue;
    }
    for (const room of b.passageRooms ?? []) {
      ends.push({ room, base: b.base, end: room.sections[0] }, { room, base: b.base, end: room.sections[room.sections.length - 1] });
    }
  }
  const near = (p: Point, q: Point) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= AT_OPENING_M;
  for (const b of buildings) {
    if (b.base === undefined) {
      continue;
    }
    for (const o of b.passages ?? []) {
      const at = ends.filter(({ end: [l, r] }) => (near(l, o.from) && near(r, o.to)) || (near(l, o.to) && near(r, o.from)));
      if (at.length === 0) {
        continue;
      }
      const ceiling = Math.max(...at.map(({ room, base }) => (room.ground ?? base) + room.height));
      for (const { room, base } of at) {
        if ((room.ground ?? base) + room.height < ceiling) {
          room.ground = ceiling - room.height;
        }
      }
      o.height = Math.max(o.height, ceiling - (o.ground ?? b.base));
    }
  }
}
