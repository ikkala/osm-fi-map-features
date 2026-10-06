// Passages through buildings on bridges: a way carried through a building on its deck (setBridgeDecks) opens the
// walls and has its room from the deck up, the wall staying whole under it.
import { deckAt } from "./bridges.ts";
import { nearestOnLine, type Point } from "./geometry.ts";
import type { Building } from "./osm.ts";

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
