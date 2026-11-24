// The heights of the ways that leave the ground, as one linear program for each group of them its rows join (lp.ts):
// the bridges' decks and their approaches, the cuts under the decks, the bored tunnels' floors (floors.ts) and the
// ramps out of their portals. A column is a way's height at a point, one where ways share it, so ways meeting or
// crossing are at one height there; the bounds are missed only by priority, at the least cost (HARD_COST and on),
// each miss told with its way and place.
// - The lines solved: the spans' (bridges.ts, every STEP_M), and stretches of the ways from them along their lines,
//   on through joints (a way's end where one other way goes on): an approach from a landing as far as the most its
//   deck may need to rise there takes at its users' grade, a cut along a way under a deck as far as the room it may
//   need there goes down at its grade (MAX_DEPTH_M at most), a ramp out of a portal as far as the ground over the
//   portal is over its floor at TUNNEL_GRADE (stairs' up stairs), each BEND_SPAN_M twice longer for its bends. An
//   approach or a ramp ends at a junction; a cut or a ramp takes the ways crossing it there down with it within
//   their own stretch, as far as its depth needs. A point of a stretch where a way meets it that has none there is
//   held at the ground, as are a stretch's ends inside a way and a cut's dead end.
// - hard: a cut's grade and a ramp's between their points, as their users' or the ground's where steeper (an
//   approach's as steep as stairs for people), a deck never dipping, under a deck a railway's least room (a tramway's over the lowest its
//   bed goes down to there, trackbeds.ts), and the floors' (floors.ts);
// - the room under the decks (the way's or bridge's that OSM tells, else the users'), under them over the tunnels,
//   and over a cut the surfaces of the ways in its room at its height; the heights steps tell; then the bends of
//   every line through its points (a deck's at a junction through its straightest pair), no more than
//   MAX_BEND_M over BEND_SPAN_M once rounded to the tiles' resolution, which yield to all of those (BEND_COST, floors.ts); then the users' grade on the
//   approaches and the decks (a deck's as steep as its landings are);
// - and each meter a deck or an approach is raised or a way cut, by the length it stands for (a train's TRACK_COST
//   times), so that the decks keep to the line between their landings, the ways to the ground and the cuts shallow;
//   the floors' own (a portal at its height cheaper than a deck raised over it).
// A railway's deck keeps to its landings. A way's stretch over the ground becomes an approach with a deck, one under
// it a cut with a floor.
import { approachable, landings, setBoardwalkDeck, spansOf, type Landing } from "./bridges.ts";
import { DeckIndex, MAX_DEPTH_M } from "./deckIndex.ts";
import { BEND_COST, bends, floorRows, HARD_COST, PORTAL_COST, ROOM_COST, setFloors, SHALLOW_COST, type FloorBound, type KnownFloor, type OverTunnel } from "./floors.ts";
import { densify, distancesAlong, grownRect, indexOwnBoxes, nearestOnLine, pointAt, pointKey, pushTo, RESOLUTION_M, simplifyLine, type Point } from "./geometry.ts";
import { groupsOf, NamedPrograms, type NamedRow, type SolveLp } from "./lp.ts";
import { bounds, type BridgeOutline, type MapFeatures, type Road } from "./osm.ts";
import { inTunnel, isBridge, offStructures } from "./profile.ts";
import { spread, tunnelNetwork, type TunnelNetwork } from "./tunnels.ts";
import { BEND_SPAN_M, DECK_THICKNESS_M, GRADE, isRoad, LEAST_CLEARANCE_M, MIN_CLEARANCE_M, ROOM_SIDE_M, STAIRS_GRADE, TRAM_CUT_CLEARANCE_M, TUNNEL_GRADE, userOf, widthOf, type Way } from "./ways.ts";

/** The ways' heights are solved this often along them (m) */
const STEP_M = 2;
/**
 * The costs after the hard bounds, the room and the bends (floors.ts), a meter: an approach steeper than its users'
 * grade, and each meter a deck or an approach is over the ground (or a deck over the line between its landings) or a
 * way down in a cut, a meter along: raising a deck dearer than a cut under it, and a railway's TRACK_COST times a road's
 */
const GRADE_COST = 10;
const RAISE_COST = 0.1;
const CUT_COST = 0.01;
const TRACK_COST = 10;
/**
 * A tram's room under a deck, a meter of it missed: dearer than a cut, cheaper than raising the deck, as its bed goes
 * down under the deck where no cut gives it the room (trackbeds.ts), as deep as MAX_DEPTH_M
 */
const TRAM_ROOM_COST = 0.5;
/** A way's height this near its ground (m) is the ground's: as near as the solver keeps a bound */
const ON_GROUND_M = 1e-3;

type HeightAt = (e: number, n: number) => number | undefined;

/** A height's bound missed: on which way, where most and by how much (m) */
export interface HeightConflict {
  way: string;
  bound: "grade" | "dip" | "room" | "steps" | "bend" | "known" | "hall" | "portal" | "cover";
  at: Point;
  by: number;
}

export type HeightTag = Omit<HeightConflict, "by">;

/** What the heights' solving did, for the log */
export interface HeightsSolved {
  /** The points of decks steps told the heights of, the stretches of ways raised as approaches and lowered into cuts */
  told: number;
  approaches: number;
  cuts: number;
  /** The tunnels with floors, the known floors on a tunnel, and the tunnels going down into basements (floors.ts) */
  floors: number;
  known: number;
  basements: Road[];
  network: TunnelNetwork;
  conflicts: HeightConflict[];
}

export interface HeightOptions {
  /** Whether a point is an end of a way indoors, and whether a road runs through buildings (see spansOf, landings) */
  indoors?: (p: Point) => boolean;
  through?: (road: Road) => boolean;
  /** The tunnel ways' storeys (tunnels.ts' network), the floors known, and the bridges' outlines */
  levels?: ReadonlyMap<Way, number[]>;
  known?: readonly KnownFloor[];
  outlines?: readonly BridgeOutline[];
}

type Kind = "deck" | "approach" | "cut" | "held";

/** A point whose height is solved: a deck's, an approach's, a cut's or a ramp's, or one held at the ground */
interface HeightNode {
  p: Point;
  kind: Kind;
  ground: number;
  /** How deep under its ground a cut may go */
  depth: number;
  /** The length of way it stands for (m), its cost a meter of that off the ground, and whether a railway's */
  weight: number;
  cost: number;
  rail: boolean;
  train: boolean;
  /** The way told of its misses */
  osm: string;
}

interface Edge {
  a: string;
  b: string;
  length: number;
  kind: Kind;
  way: Way;
  /** The steepest its users go between its points, and whether it may be steeper, up to stairs' grade (a ramp's) */
  grade: number;
  soft: boolean;
}

/** A stretch of a way solved: from and to how far along it, its kind, how deep it may go, its grade, its ground */
interface Stretch {
  from: number;
  to: number;
  kind: "approach" | "cut";
  depth: number;
  grade: number;
  /** Its cost a meter off the ground, a meter along; its grade missed at a portal's cost (a ramp's); on the ground raised to the portals' walls (a ramp's), and held at a dead end */
  cost: number;
  soft: boolean;
  raised: boolean;
  /** Level (stairs across a tunnel's room) */
  level?: boolean;
  deadEnds: boolean;
}

/** A bound on a sum of heights (their points' keys and factors), missed at its cost a meter, told at k */
interface Bound {
  cost: number;
  bound: HeightConflict["bound"];
  k: string;
  terms: [string, number][];
  lower: number;
  upper: number;
}

/** Where a way passes under a deck: its point's key and ground, the deck's segment's ends and how far along it, the room */
interface Under {
  way: Way;
  at: number;
  ground: number;
  deck: [string, string, number];
  room: number;
  told: boolean;
}

const NODE_RANK = { deck: 3, approach: 2, held: 1, cut: 0 };

/**
 * Sets the heights of the ways leaving the ground (heightAt: its height, meters east / north, with the walls and the
 * flights stepped): the bridges' decks, and split off the ways, pushed onto them, their stretches raised as approaches
 * (`deck`) and lowered into cuts and ramps (`floor`, and a road's `room` under a deck), and the bored tunnels'
 * floors, solved by lp. An end that no line leads on from but ways indoors do (`indoors`) goes into a building, at
 * whatever floor: it takes no height from the ground, so the deck runs level from its other landings.
 */
export function solveHeights(features: MapFeatures, heightAt: HeightAt, lp: SolveLp, options: HeightOptions = {}): HeightsSolved {
  const { roads, rails } = features;
  const ways: Way[] = [...roads, ...rails];
  const boardwalks = roads.filter((l) => isBridge(l) && l.boardwalk === true && !inTunnel(l) && l.floor === undefined && l.line.length >= 2);
  // a boardwalk in a tunnel or ramping down to one goes as a bridge: its line keeps its points
  roads.filter((l) => l.boardwalk === true && !boardwalks.includes(l)).forEach((l) => delete l.boardwalk);
  boardwalks.forEach((b) => setBoardwalkDeck(b, heightAt));
  const network = tunnelNetwork(features, heightAt, options.levels);
  const atPoint = new Map<string, Way[]>();
  ways.forEach((w) => new Set(w.line.map(pointKey)).forEach((k) => pushTo(atPoint, k, w)));
  const { spans, toldAt, telling, lifting } = spansOf(ways, atPoint, heightAt, options.through ?? (() => false));
  const original = new Map(spans.map((w) => [w, new Set(w.line.map(pointKey))]));
  spans.forEach((s) => (s.line = densify(s.line, STEP_M)));
  const model = new HeightModel(heightAt, network, atPoint, telling);
  const told = model.addDecks(spans, toldAt, original);
  const under = underWays(ways, spans, model);
  model.addApproaches(landings(spans, atPoint, heightAt, options.indoors ?? (() => false), lifting, telling, boardwalks), under);
  model.addCuts(under);
  const decks = new DeckIndex(spans, options.outlines);
  const { bounds: floorBounds, over, ...floors } = floorRows(model.program, features, network, (p) => decks.under(p), options.known ?? [], (p, layer) => model.deckTerms(decks, p, layer));
  model.addRamps([...floorBounds, ...over.map(({ k, ground, depth }) => ({ cost: ROOM_COST, bound: "room" as const, k, terms: [[k, 1]] satisfies [string, number][], lower: -Infinity, upper: ground - depth }))]);
  model.build();
  model.addOver(over);
  model.addBesides(ways);
  model.solve(lp);
  spans.forEach((s) => model.setDeck(s, original.get(s)));
  const pieces = [...model.regions.keys()].flatMap((way) => model.split(way));
  for (const piece of pieces) {
    if (isRoad(piece)) {
      roads.push(piece);
    } else {
      rails.push(piece);
    }
  }
  const floored = setFloors(network, model.heights);
  return { told, approaches: model.raised, cuts: model.cut, floors: floored, ...floors, network, conflicts: model.conflicts };
}

/**
 * The points where the ways pass under the decks, every STEP_M along them and at their points (not the ways meeting a
 * deck, which lead on from it), with the deck's segment over each and the room: the way's or the bridge's OSM tells,
 * else its users' (a tram's under its overhead line)
 */
function underWays(ways: Way[], spans: Way[], model: HeightModel): Under[] {
  const index = new DeckIndex(spans);
  const spanned = new Set(spans);
  const found: Under[] = [];
  for (const way of ways.filter((w) => offStructures(w) && !spanned.has(w) && w.line.length >= 2)) {
    const points = new Set(way.line.map(pointKey));
    const along = distancesAlong(way.line);
    for (const d of stations(0, along[along.length - 1], along)) {
      const p = pointAt(way.line, along, d);
      const deck = index.spanOver(p, way.layer);
      const ground = model.groundAt(p);
      // a railway under a railway's deck is beside its own bridge
      if (!deck || ground === undefined || deck.way.line.some((q) => points.has(pointKey(q))) || (!isRoad(way) && !isRoad(deck.way))) {
        continue;
      }
      const told = way.clearance ?? deck.way.roomUnder;
      const user = userOf(way);
      const room = told ?? (user === "trams" ? TRAM_CUT_CLEARANCE_M : MIN_CLEARANCE_M[user]);
      const [a, b] = [model.deckKey(deck.way, deck.segment), model.deckKey(deck.way, deck.segment + 1)];
      found.push({ way, at: d, ground, deck: [a, b, deck.t], room, told: told !== undefined });
    }
  }
  return found;
}

/** The distances from `from` to `to` along a line no more than STEP_M apart, and its points' distances (along) between */
function stations(from: number, to: number, along: number[]): number[] {
  const pieces = Math.max(1, Math.ceil((to - from) / STEP_M - 1e-9));
  // a step's station at a point of the line is the point's
  const snap = (d: number) => along.find((x) => Math.abs(x - d) < 1e-6) ?? d;
  const found = [...Array.from({ length: pieces + 1 }, (_, i) => snap(from + ((to - from) * i) / pieces)), ...along.filter((d) => d > from && d < to)];
  return [...new Set(found)].sort((x, y) => x - y);
}

/** The heights' program: its points, the ways' stretches in it, and its bounds */
class HeightModel {
  readonly nodes = new Map<string, HeightNode>();
  readonly edges: Edge[] = [];
  readonly bounds: Bound[] = [];
  readonly program = new NamedPrograms<HeightTag>();
  /** Each way's stations in the program: distance along it → its point's key */
  readonly regions = new Map<Way, Map<number, string>>();
  readonly heights = new Map<string, number>();
  readonly conflicts: HeightConflict[] = [];
  readonly #under: Under[] = [];
  readonly #underOf = new Map<Way, Under[]>();
  /** The landings' heights (none: a free end's), those kept, the heights steps tell, and the approaches' lowest out of the hollows */
  readonly #landings = new Map<string, number | undefined>();
  readonly #fixed = new Map<string, number>();
  readonly #told = new Map<string, number>();
  readonly #fills = new Map<string, number>();
  readonly #hollows = new Map<Way, (Landing["approaches"][number] & { height: number | undefined })[]>();
  readonly #alongs = new Map<Way, number[]>();
  readonly #deckKeys = new Map<Way, string[]>();
  readonly #sorted = new Map<Way, [number, string][]>();
  readonly #stretches = new Map<Way, Stretch[]>();
  readonly #grounds = new Map<string, number | undefined>();
  readonly #heightAt: HeightAt;
  readonly #network: TunnelNetwork;
  readonly #atPoint: Map<string, Way[]>;
  readonly #telling: Set<Way>;
  raised = 0;
  cut = 0;

  constructor(heightAt: HeightAt, network: TunnelNetwork, atPoint: Map<string, Way[]>, telling: Set<Way>) {
    this.#heightAt = heightAt;
    this.#network = network;
    this.#atPoint = atPoint;
    this.#telling = telling;
  }

  groundAt(p: Point): number | undefined {
    const k = pointKey(p);
    return this.#grounds.has(k) ? this.#grounds.get(k) : this.#grounds.set(k, this.#heightAt(...p)).get(k);
  }

  /** A point of a way, of a kind (the higher of NODE_RANK where several ways' meet), its key: a point added to its line the way's own */
  node(p: Point, kind: Kind, way: Way, own: boolean, ground = this.groundAt(p), depth = 0, cost = RAISE_COST): string {
    const k = own ? pointKey(p) : `${pointKey(p)}|${way.osm}`;
    const there = this.nodes.get(k);
    if (!there || NODE_RANK[kind] > NODE_RANK[there.kind]) {
      this.nodes.set(k, { p, kind, ground: there?.ground ?? ground ?? 0, depth: Math.max(depth, there?.depth ?? 0), weight: there?.weight ?? 0, cost: Math.max(cost, there?.cost ?? 0), rail: !isRoad(way), train: userOf(way) === "trains", osm: way.osm });
    } else {
      there.cost = Math.max(cost, there.cost);
    }
    return k;
  }

  /** A stretch of a way from one point to the next, of a kind */
  edge(way: Way, a: string, b: string, length: number, kind: Kind, grade = GRADE[userOf(way)], soft = false): void {
    this.edges.push({ a, b, length, kind, way, grade, soft });
    [a, b].forEach((k) => {
      const node = this.nodes.get(k);
      if (node) {
        node.weight += length / 2;
      }
    });
  }

  /** The spans' points, and the heights steps tell at them (each a riser told): how many */
  addDecks(spans: Way[], toldAt: (p: Point, except?: Way) => number | undefined, original: Map<Way, Set<string>>): number {
    let told = 0;
    for (const span of spans) {
      const along = distancesAlong(span.line);
      const keys = span.line.map((p) => this.node(p, "deck", span, original.get(span)?.has(pointKey(p)) ?? true));
      this.#deckKeys.set(span, keys);
      keys.slice(1).forEach((k, i) => this.edge(span, keys[i], k, along[i + 1] - along[i], "deck"));
      span.line.forEach((p, i) => {
        const h = toldAt(p, span);
        if (h !== undefined) {
          told++;
          this.#told.set(keys[i], Math.max(h, this.#told.get(keys[i]) ?? -Infinity));
          this.bounds.push({ cost: ROOM_COST, bound: "steps", k: keys[i], terms: [[keys[i], 1]], lower: h, upper: Infinity });
        }
      });
    }
    return told;
  }

  /**
   * The landings' heights, and the ways leading on from them as approaches out of the hollows under the bridges and
   * as far as the most their deck may need over the ways under it (or steps tell) lets it rise at their grade
   */
  addApproaches(landings: Landing[], under: Under[]): void {
    const decks = this.#decks();
    const need = new Map<string, number>();
    const needs = (k: string, h: number) => need.set(decks(k), Math.max(h, need.get(decks(k)) ?? -Infinity));
    under.forEach((u) => needs(u.deck[0], u.ground + u.room + DECK_THICKNESS_M));
    this.#told.forEach((h, k) => needs(k, h));
    for (const { p, height: ground, approaches, host, inner } of landings) {
      const k = pointKey(p);
      // steps up to it tell its height
      const height = inner ? undefined : (this.#told.get(k) ?? ground);
      if (!inner) {
        this.#landings.set(k, height);
      }
      // on a boardwalk, or with no way to raise as an approach, it keeps its height
      // a railway's deck stays on its landings: its line keeps its gentle grade far past the approaches, and its tracks side by side would part
      const fixed = !inner && (host || approaches.length === 0 || this.nodes.get(k)?.rail === true) && height !== undefined;
      if (fixed) {
        this.#fixed.set(k, height);
      }
      approaches.forEach((a) => pushTo(this.#hollows, a.line, { ...a, height }));
      const rise = fixed ? 0 : Math.max(0, (need.get(decks(k)) ?? -Infinity) - (height ?? this.groundAt(p) ?? Infinity));
      for (const a of approaches.filter((a) => rise > 0 || a.length > 0)) {
        const reach = a.length + rise / GRADE[userOf(a.line)] + 2 * BEND_SPAN_M;
        this.#stretch(this.#walk(a.line, a.at, a.toward, reach, approachable(this.#telling)), { kind: "approach", depth: 0, grade: 0, cost: RAISE_COST, soft: false, raised: false, deadEnds: false });
      }
    }
  }

  /**
   * The ways under the decks with too little room under the lowest of their landings, as far along them as a cut
   * MAX_DEPTH_M deep ramps up at their grade, and the ways crossing them as far: those that may go down (not those
   * with the room under them told, nor on another layer)
   */
  addCuts(under: Under[]): void {
    const decks = this.#decks();
    const lowest = this.#lowestLandings();
    for (const u of under.filter((u) => !u.told)) {
      const depth = Math.min(MAX_DEPTH_M, u.ground + u.room + DECK_THICKNESS_M - (lowest.get(decks(u.deck[0])) ?? -Infinity));
      const may = (w: Way) => offStructures(w) && w.clearance === undefined && !this.#telling.has(w) && w.layer === u.way.layer && w.line.length >= 2;
      if (depth > 0) {
        this.#stretch(this.#walk(u.way, u.at, 0, MAX_DEPTH_M / GRADE[userOf(u.way)] + 2 * BEND_SPAN_M, may, MAX_DEPTH_M), { kind: "cut", depth: MAX_DEPTH_M, grade: 0, cost: CUT_COST, soft: false, raised: false, deadEnds: true });
      }
    }
    this.#under.push(...under);
    under.forEach((u) => pushTo(this.#underOf, u.way, u));
  }

  /**
   * The ways out of the tunnels' portals and stairs' feet, as far as the ground over the portal (raised to its wall)
   * may be over its floor at TUNNEL_GRADE, up stairs at theirs, and the ways crossing them as far: the floor no
   * higher than its portal, or at stairs as deep as its room and roof, or than the floors' bounds under what is over
   * them leave it coming up from them at TUNNEL_GRADE, a deck over them taken at its lowest landing
   */
  addRamps(floorBounds: FloorBound[]): void {
    const { nodes, heightAt } = this.#network;
    const tunnels = new Set(this.#network.tunnels);
    const may = (w: Way) => !tunnels.has(w) && offStructures(w) && w.line.length >= 2;
    const lowest = this.#lowestLandings();
    const decks = this.#decks();
    const under = floorBounds.flatMap(({ k, terms, upper }): [string, number][] => {
      const others = terms.filter(([q]) => q !== k);
      const deck = others.reduce((sum, [q, v]) => sum - v * (lowest.get(decks(q)) ?? this.nodes.get(q)?.ground ?? 0), 0);
      return upper < Infinity && others.every(([q]) => this.nodes.get(q)?.kind === "deck") ? [[k, upper + deck]] : [];
    });
    const low = spread(nodes, under, (length) => TUNNEL_GRADE * length);
    for (const [k, node] of nodes) {
      const ground = heightAt(...node.p);
      if ((node.portal === undefined && !node.stairs && !node.sideStairs) || ground === undefined) {
        continue;
      }
      const rise = ground - Math.min(node.portal ?? ground - node.depth, low.get(k) ?? Infinity);
      // stairs leaving a tunnel going on past them are level across its room
      const level = node.sideStairs ? node.half : 0;
      for (const way of (this.#atPoint.get(k) ?? []).filter(may)) {
        const i = way.line.findIndex((q) => pointKey(q) === k);
        const [at, toward] = [this.#along(way)[i], i === 0 ? 1 : -1];
        const ramp = { kind: "cut", depth: Infinity, cost: SHALLOW_COST, raised: true, deadEnds: true } as const;
        if (rise > 0 && (i === 0 || i === way.line.length - 1)) {
          this.#stretch(new Map([[way, [[Math.min(at, at + toward * level), Math.max(at, at + toward * level)]]]]), { ...ramp, grade: 0, soft: false, level: true });
          this.#stretch(this.#walk(way, at, toward, level + rise / (rising(way) ? STAIRS_GRADE : TUNNEL_GRADE) + 2 * BEND_SPAN_M, may, rise), { ...ramp, grade: TUNNEL_GRADE, soft: true });
        }
      }
    }
  }

  /** The lowest landing of each deck's group, by its root */
  #lowestLandings(): Map<string, number> {
    const decks = this.#decks();
    const lowest = new Map<string, number>();
    this.#landings.forEach((h, k) => h !== undefined && lowest.set(decks(k), Math.min(h, lowest.get(decks(k)) ?? Infinity)));
    return lowest;
  }

  /** The decks' groups: the root of a deck point's */
  #decks(): (k: string) => string {
    return groupsOf(this.edges.filter((e) => e.kind === "deck").map((e) => [e.a, e.b]));
  }

  /**
   * The stretches of a line from `at` along `way` (toward its end: 1, its start: -1, both: 0) as far as `reach` (m),
   * on through joints to the ways `may` take: up to a junction (a point another way meets) or, with `depth`, past it,
   * the ways there that `may` take crossing it as far as that depth needs at their grade
   */
  #walk(way: Way, at: number, toward: number, reach: number, may: (way: Way) => boolean, depth?: number): Map<Way, [number, number][]> {
    const found = new Map<Way, [number, number][]>();
    const queue = (toward === 0 ? [1, -1] : [toward]).map((dir) => ({ way, at, dir, left: reach, crossing: depth !== undefined }));
    const seen = new Map<Way, string[]>();
    const first = (w: Way, id: string) => !seen.get(w)?.includes(id) && pushTo(seen, w, id) === undefined;
    for (let next = queue.pop(); next; next = queue.pop()) {
      const { way: w, at: from, dir, left, crossing } = next;
      const along = this.#along(w);
      const end = dir > 0 ? along.length - 1 : 0;
      let to = dir > 0 ? Math.min(along[end], from + left) : Math.max(0, from - left);
      for (const i of dir > 0 ? along.keys() : [...along.keys()].reverse()) {
        const d = along[i];
        const k = pointKey(w.line[i]);
        const others = (this.#atPoint.get(k) ?? []).filter((o) => o !== w);
        if ((d - from) * dir <= 1e-9 || (d - to) * dir > 1e-9 || others.length === 0 || (i === end && joint(w, others, k, may))) {
          continue;
        }
        if (!crossing) {
          to = d;
          break;
        }
        for (const o of others.filter(may)) {
          if (first(o, k) && depth !== undefined) {
            const j = o.line.findIndex((q) => pointKey(q) === k);
            queue.push({ way: o, at: this.#along(o)[j], dir: 1, left: depth / GRADE[userOf(o)] + 2 * BEND_SPAN_M, crossing: false });
            queue.push({ way: o, at: this.#along(o)[j], dir: -1, left: depth / GRADE[userOf(o)] + 2 * BEND_SPAN_M, crossing: false });
          }
        }
      }
      pushTo(found, w, [Math.min(from, to), Math.max(from, to)]);
      const k = pointKey(w.line[end]);
      const [o] = (this.#atPoint.get(k) ?? []).filter((x) => x !== w);
      if (Math.abs(to - along[end]) < 1e-9 && left > Math.abs(to - from) && o && joint(w, [o], k, may) && first(w, `${k}|joint`)) {
        const j = o.line.findIndex((q) => pointKey(q) === k);
        queue.push({ way: o, at: this.#along(o)[j], dir: j === 0 ? 1 : -1, left: left - Math.abs(to - from), crossing });
      }
    }
    return found;
  }

  /** Stretches of ways, of a kind: an approach's grade its users', a ramp's its own (stairs' up stairs), a cut's its users' (stairs' for steps), a `level` one's none */
  #stretch(walked: Map<Way, [number, number][]>, stretch: Omit<Stretch, "from" | "to">): void {
    for (const [way, list] of walked) {
      const steps = isRoad(way) && way.kind === "steps";
      const grade = stretch.level ? 0 : stretch.kind === "approach" ? GRADE[userOf(way)] : stretch.grade > 0 ? (rising(way) ? STAIRS_GRADE : stretch.grade) : steps ? STAIRS_GRADE : GRADE[userOf(way)];
      list.forEach(([from, to]) => pushTo(this.#stretches, way, { ...stretch, grade, from, to }));
    }
  }

  /**
   * The stations and steps of the ways' stretches, those of several kinds on a way joined (an approach's where they
   * overlap), held at the ground at their ends inside a way, at a cut's dead end, and where a way meets them with no
   * stretch of its own there (a span's and a tunnel's points have theirs)
   */
  build(): void {
    const merged = new Map([...this.#stretches].map(([way, list]) => [way, joined(list.map((s): [number, number] => [s.from, s.to]))]));
    const tunnels = new Set(this.#network.tunnels);
    const covers = (other: Way, k: string) => {
      const along = this.#along(other);
      const i = other.line.findIndex((q) => pointKey(q) === k);
      const d = along[i];
      const end = i === 0 || i === along.length - 1;
      return isBridge(other) || this.#deckKeys.has(other) || tunnels.has(other) || (merged.get(other) ?? []).some(([from, to]) => (from < d - 1e-6 || (end && from <= d + 1e-6)) && (to > d + 1e-6 || (end && to >= d - 1e-6)));
    };
    for (const [way, list] of this.#stretches) {
      const along = this.#along(way);
      const length = along[along.length - 1];
      const own = new Map<number, string>();
      this.regions.set(way, own);
      const covering = (d: number) => list.filter((s) => s.from <= d + 1e-6 && s.to >= d - 1e-6).sort((x, y) => NODE_RANK[y.kind] - NODE_RANK[x.kind])[0];
      for (const [from, to] of merged.get(way) ?? []) {
        const ds = stations(from, to, [...along, ...this.#fillEnds(way), ...list.flatMap((s) => (s.level ? [s.from, s.to] : []))]);
        const keys = ds.map((d, i) => {
          const p = pointAt(way.line, along, d);
          const k = pointKey(p);
          const by = covering(d);
          const inside = d > 1e-6 && d < length - 1e-6 && (i === 0 || i === ds.length - 1);
          const there = along.some((x) => Math.abs(x - d) < 1e-9) ? (this.#atPoint.get(k) ?? []) : [];
          const deadEnd = by.deadEnds && there.length === 1 && (d < 1e-6 || d > length - 1e-6);
          const held = inside || deadEnd || there.some((o) => o !== way && !covers(o, k));
          const ground = by.raised ? this.#network.heightAt(...p) : this.groundAt(p);
          return this.node(p, held ? "held" : by.kind, way, there.length > 0, ground, by.kind === "cut" ? by.depth : 0, by.cost);
        });
        ds.forEach((d, i) => {
          own.set(d, keys[i]);
          const fill = this.#fill(way, d);
          if (fill !== undefined) {
            this.#fills.set(keys[i], Math.max(fill, this.#fills.get(keys[i]) ?? -Infinity));
          }
        });
        keys.slice(1).forEach((k, i) => {
          const by = covering((ds[i] + ds[i + 1]) / 2);
          this.edge(way, keys[i], k, ds[i + 1] - ds[i], by.kind, by.grade, by.soft);
        });
      }
    }
  }

  /** How high an approach's point `d` along its way is raised out of the hollow under its bridge: from its landing's height down to the ground where the ground stops rising */
  #fill(way: Way, d: number): number | undefined {
    const fills = (this.#hollows.get(way) ?? []).flatMap(({ at, toward, length, height }) => {
      const off = (d - at) * toward;
      const end = this.groundAt(pointAt(way.line, this.#along(way), at + toward * length));
      return height === undefined || end === undefined || length <= 0 || off < 0 || off > length ? [] : [height + ((end - height) * off) / length];
    });
    return fills.length > 0 ? Math.max(...fills) : undefined;
  }

  /** Where along a way its approaches' fills out of the hollows end */
  #fillEnds(way: Way): number[] {
    return (this.#hollows.get(way) ?? []).filter((a) => a.length > 0).map(({ at, toward, length }) => at + toward * length);
  }

  /**
   * The ways in the room of a cut under a deck (its width and ROOM_SIDE_M either side), crossing ones too, have their
   * surface there at the cut's floor across from it: they go down with it, or hold it at theirs; not the way it goes
   * on from at a joint. A ramp's room is its tunnel's, under the floors' bounds.
   */
  addBesides(ways: Way[]): void {
    const near = ways.filter((w) => offStructures(w) && w.line.length >= 2);
    const index = indexOwnBoxes(near.map((w) => grownRect(bounds(w.line), widthOf(w) / 2)));
    for (const [way, own] of this.regions) {
      const reach = widthOf(way) / 2 + ROOM_SIDE_M;
      const ends = [way.line[0], way.line[way.line.length - 1]].map(pointKey);
      const goesOn = (other: Way) => ends.some((k) => joint(way, (this.#atPoint.get(k) ?? []).filter((o) => o !== way), k, (o) => o === other));
      for (const k of own.values()) {
        const node = this.nodes.get(k);
        if (node?.kind !== "cut" || node.cost === SHALLOW_COST || this.program.has(k)) {
          continue;
        }
        for (const other of index(grownRect(bounds([node.p]), reach)).map((i) => near[i]).filter((o) => o !== way && !goesOn(o))) {
          const { point, distance } = nearestOnLine(other.line, node.p);
          const across = this.#terms(way, this.#at(way, point));
          const terms = this.#terms(other, this.#at(other, point));
          const ground = this.groundAt(point);
          if (distance < reach + widthOf(other) / 2 && across.length > 0 && (terms.length > 0 || ground !== undefined)) {
            const level = terms.length > 0 ? 0 : (ground ?? 0);
            this.bounds.push({ cost: ROOM_COST, bound: "room", k, terms: [...across, ...terms.map(([q, v]): [string, number] => [q, -v])], lower: level, upper: level });
          }
        }
      }
    }
  }

  /** How far along a way the point of it nearest p is */
  #at(way: Way, p: Point): number {
    const { point, segment } = nearestOnLine(way.line, p);
    return this.#along(way)[segment] + Math.hypot(point[0] - way.line[segment][0], point[1] - way.line[segment][1]);
  }

  /** The room and roof under the ways over the tunnels: under the ground, or under their heights where they leave it */
  addOver(over: OverTunnel[]): void {
    for (const { k, way, at, ground, depth } of over) {
      const terms = this.#terms(way, this.#at(way, at));
      this.bounds.push({ cost: ROOM_COST, bound: "room", k, terms: [[k, 1], ...terms.map(([q, v]): [string, number] => [q, -v])], lower: -Infinity, upper: (terms.length > 0 ? 0 : ground) - depth });
    }
  }

  /** A span's point's key */
  deckKey(span: Way, i: number): string {
    return this.#deckKeys.get(span)?.[i] ?? pointKey(span.line[i]);
  }

  /** The height of the deck over a point of a way on a layer, as the deck's points' terms (decks: the spans') */
  deckTerms(decks: DeckIndex, p: Point, layer: number): [string, number][] | undefined {
    const over = decks.spanOver(p, layer, undefined, true);
    return over && [[this.deckKey(over.way, over.segment), 1 - over.t], [this.deckKey(over.way, over.segment + 1), over.t]];
  }

  /** A way's stations in the program in order along it, once its stretches are all there */
  #stations(way: Way): [number, string][] {
    const found = this.#sorted.get(way) ?? [...(this.regions.get(way) ?? [])].sort((x, y) => x[0] - y[0]);
    this.#sorted.set(way, found);
    return found;
  }

  #along(way: Way): number[] {
    const found = this.#alongs.get(way) ?? distancesAlong(way.line);
    this.#alongs.set(way, found);
    return found;
  }

  /** Solves the heights, a program for each group of points the bounds join */
  solve(lp: SolveLp): void {
    const decks = this.#decks();
    const anchors = new Map<string, number>();
    for (const [k, h] of [...this.#landings, ...this.#told]) {
      const root = decks(k);
      anchors.set(root, Math.max(h ?? -Infinity, anchors.get(root) ?? -Infinity));
    }
    const floors = new Set([...this.nodes.keys()].filter((k) => this.program.has(k)));
    for (const [k, node] of this.nodes) {
      if (!floors.has(k)) {
        const [low, high] = this.#limits(k, node, anchors.get(decks(k)));
        this.program.column(k, node.weight * (node.train ? TRACK_COST : 1) * (node.kind === "cut" ? -node.cost : node.kind === "held" ? 0 : node.cost), low, high);
      }
    }
    const soft = ({ cost, bound, k, terms, lower, upper }: Bound): NamedRow<HeightTag> => {
      const node = this.nodes.get(k);
      const tunnel = this.#network.nodes.get(k);
      return { cost, lower, upper, terms, tag: { way: node?.osm ?? this.#network.through.get(k)?.[0]?.osm ?? k, bound, at: node?.p ?? tunnel?.p ?? [0, 0] } };
    };
    [...this.bounds, ...this.#grades(decks), ...this.#rooms()].forEach((b) => this.program.soft(soft(b)));
    // the bends held where the lines leave the ground, more of them each round, solved again where they did
    const strict = new Set<string>();
    const misses = new Map<string, { tag: HeightTag; by: number }[]>();
    for (let only: (k: string) => boolean = () => true; ; ) {
      const solved = this.program.solve(lp, RESOLUTION_M / 2, this.#bends(floors, strict).map(soft), only);
      solved.values.forEach((h, k) => this.heights.set(k, h));
      solved.missed.forEach((list, root) => misses.set(root, list));
      const off = [...this.nodes].filter(([k, node]) => !strict.has(k) && node.kind !== "deck" && !floors.has(k) && Math.abs((this.heights.get(k) ?? node.ground) - node.ground) > ON_GROUND_M).map(([k]) => k);
      if (off.length === 0) {
        break;
      }
      if (process.env.DBG) console.log("off", off.map((k) => [k, this.heights.get(k), this.nodes.get(k)?.ground]));
      off.forEach((k) => strict.add(k));
      only = (k) => off.includes(k);
    }
    const worst = new Map<string, HeightConflict>();
    for (const { tag, by } of [...misses.values()].flat()) {
      const key = `${tag.way} ${tag.bound}`;
      if (by > (worst.get(key)?.by ?? 0)) {
        worst.set(key, { ...tag, by });
      }
    }
    this.conflicts.push(...worst.values());
  }

  /** How low and high a point may be: a landing at its height (a free end at its deck's highest landing's), an approach over its ground or fill, a cut no deeper than its depth */
  #limits(k: string, node: HeightNode, anchor: number | undefined): [number, number] {
    const fixed = this.#fixed.get(k);
    if (node.kind === "deck") {
      const known = anchor !== undefined && Number.isFinite(anchor);
      const landing = this.#landings.has(k) ? (this.#landings.get(k) ?? (known ? anchor : node.ground)) : known ? -Infinity : node.ground;
      return fixed === undefined ? [landing, Infinity] : [fixed, fixed];
    }
    if (node.kind === "approach") {
      return [this.#low(k), Infinity];
    }
    return node.kind === "cut" ? [node.ground - node.depth, node.ground] : [node.ground, node.ground];
  }

  /** A point's lowest as its kind lets it: an approach's out of the hollow, a tunnel's at its portal's floor (or its room and roof under the ground) */
  #low(k: string): number {
    const node = this.nodes.get(k);
    const tunnel = this.#network.nodes.get(k);
    if (tunnel && node) {
      return tunnel.portal ?? node.ground - tunnel.depth;
    }
    return node?.kind === "approach" ? Math.max(node.ground, this.#fills.get(k) ?? -Infinity) : (node?.ground ?? 0);
  }

  /**
   * The grades between the points: a deck's no steeper than its users' or its landings' between them, an approach's
   * than the ground under it, or stairs for people, and missed past its users' grade only at GRADE_COST, a ramp's
   * likewise past TUNNEL_GRADE up to stairs' at a portal's cost (floors.ts), a cut's than its own or the ground's
   */
  #grades(decks: (k: string) => string): Bound[] {
    const steepest = new Map<string, number>();
    const landings = [...this.#landings, ...this.#told].flatMap(([k, h]) => (h === undefined ? [] : [{ k, h, p: this.nodes.get(k)?.p ?? [0, 0] }]));
    for (const a of landings) {
      for (const b of landings.filter((l) => l.k !== a.k && decks(l.k) === decks(a.k))) {
        steepest.set(decks(a.k), Math.max(steepest.get(decks(a.k)) ?? 0, Math.abs(a.h - b.h) / (Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]) || 1)));
      }
    }
    return this.edges.flatMap(({ a, b, length, kind, way, grade, soft }) => {
      // out of a tunnel at its own grade, not the ground's at the portal's wall
      const ground = this.#network.nodes.has(a) || this.#network.nodes.has(b) ? 0 : Math.abs(this.#low(a) - this.#low(b));
      const row = (cost: number, most: number): Bound => ({ cost, bound: "grade", k: a, terms: [[a, 1], [b, -1]], lower: -most, upper: most });
      if (kind === "deck") {
        return [row(GRADE_COST, Math.max(grade, steepest.get(decks(a)) ?? 0) * length)];
      }
      if (kind === "approach" || soft) {
        return [row(soft ? PORTAL_COST : GRADE_COST, Math.max(grade * length, ground)), ...(soft || userOf(way) === "people" ? [row(HARD_COST, Math.max(STAIRS_GRADE * length, ground))] : [])];
      }
      return [row(HARD_COST, Math.max(grade * length, ground))];
    });
  }

  /**
   * The bends along the lines through the points, each as much as MAX_BEND_M over BEND_SPAN_M lets it, where they
   * are off the ground with their neighbours (`strict`: on the ground a line is the ground, and where it meets it the
   * line's piece ends): a deck's
   * through its interior's and a junction's straightest pair of neighbours, never dipping; another line's through a
   * point with two steps, or along each way passing through a junction; not at a tunnel's floor (`floors`), which
   * bends as floors.ts lets it
   */
  #bends(floors: Set<string>, strict: Set<string>): Bound[] {
    const next = new Map<string, Edge[]>();
    this.edges.forEach((e) => [e.a, e.b].forEach((k) => pushTo(next, k, e)));
    const found: Bound[] = [];
    for (const [k, node] of this.nodes) {
      const edges = next.get(k) ?? [];
      if (node.kind === "held" || this.#landings.has(k) || floors.has(k) || (node.kind !== "deck" && !strict.has(k))) {
        continue;
      }
      const other = (e: Edge) => (e.a === k ? e.b : e.a);
      const ways = new Map<Way, Edge[]>();
      edges.forEach((e) => pushTo(ways, e.way, e));
      const lines =
        node.kind === "deck"
          ? [straightest(node.p, edges.filter((e) => e.kind === "deck").map(other), this.nodes)]
          : edges.length === 2
            ? [edges.map(other)]
            : [...ways.values()].filter((list) => list.length === 2).map((list) => list.map(other));
      // steps rise in steps, not on a curve
      const stepped = edges.some((e) => isRoad(e.way) && e.way.kind === "steps");
      // off the ground with its neighbours on the line: where it meets the ground, the line ends there
      const off = (q: string) => strict.has(q) || floors.has(q) || this.nodes.get(q)?.kind === "deck";
      for (const through of lines.filter((l) => l.length === 2 && !stepped && (node.kind === "deck" || l.every(off)))) {
        const keys = [through[0], k, through[1]];
        for (const { terms, allowed } of bends(keys.map((q) => this.nodes.get(q)?.p ?? node.p), keys)) {
          const deck = node.kind === "deck";
          found.push({ cost: BEND_COST, bound: "bend", k, terms, lower: deck ? -Infinity : -allowed, upper: allowed });
          if (deck) {
            // the deck has no ground under it: never dipping is what holds it up between its landings
            found.push({ cost: HARD_COST, bound: "dip", k, terms, lower: 0, upper: Infinity });
          }
        }
      }
    }
    return found;
  }

  /**
   * The room under the decks over the ways, and under a railway's its users' least, hard: a tramway's over the
   * lowest its bed goes down to under a deck, MAX_DEPTH_M under the ground (trackbeds.ts), as it is in no cut
   */
  #rooms(): Bound[] {
    return this.#under.flatMap(({ way, at, ground, deck: [a, b, t], room }) => {
      const on = this.#terms(way, at);
      const terms: [string, number][] = [[a, 1 - t], [b, t], ...on.map(([q, v]): [string, number] => [q, -v])];
      const base = on.length > 0 ? 0 : ground;
      const row = (cost: number, least: number, under = 0): Bound => ({ cost, bound: "room", k: a, terms, lower: least + DECK_THICKNESS_M + base - under, upper: Infinity });
      const user = userOf(way);
      return user === "trams" ? [row(TRAM_ROOM_COST, room), row(HARD_COST, LEAST_CLEARANCE_M.trams, MAX_DEPTH_M)] : [row(ROOM_COST, room), ...(isRoad(way) ? [] : [row(HARD_COST, LEAST_CLEARANCE_M[user])])];
    });
  }

  /** A way's height `at` along it as its stations' (the two around it, by how near), none where it has none there */
  #terms(way: Way, at: number): [string, number][] {
    const stationsOf = this.#stations(way);
    const i = stationsOf.findIndex(([d]) => d >= at - 1e-9);
    if (i < 0 || (i === 0 && stationsOf[0][0] > at + 1e-9)) {
      return [];
    }
    const [[d1, k1], [d0, k0]] = [stationsOf[i], stationsOf[Math.max(0, i - 1)]];
    const t = d1 > d0 ? (at - d0) / (d1 - d0) : 1;
    return t >= 1 - 1e-9 ? [[k1, 1]] : [[k0, 1 - t], [k1, t]];
  }

  /** Sets a span's deck, keeping the points its line had and those its heights' shape needs */
  setDeck(span: Way, kept: Set<string> = new Set()): void {
    const keys = this.#deckKeys.get(span) ?? [];
    const heights = span.line.map((p, i) => this.heights.get(keys[i]) ?? this.groundAt(p) ?? 0);
    const profile = distancesAlong(span.line).map((d, i): Point => [d, heights[i]]);
    const keep = new Set(profile.filter((_, i) => kept.has(pointKey(span.line[i]))));
    const shaped = new Set(simplifyLine(profile, RESOLUTION_M / 2, (q) => keep.has(q)));
    const indices = profile.flatMap((q, i) => (shaped.has(q) ? [i] : []));
    span.line = indices.map((i) => span.line[i]);
    span.deck = indices.map((i) => heights[i]);
  }

  /**
   * A way split where its heights leave the ground: its stretches over the ground approaches with decks, those under it
   * cuts with floors (a road's room under a deck the least its users' and the deck leave), each with its line's points
   * and those its heights' shape needs. Returns the stretches but the first, which the way keeps.
   */
  split(way: Way): Way[] {
    const along = this.#along(way);
    const level = this.#stations(way).map(([d, k]) => {
      const ground = this.nodes.get(k)?.ground ?? 0;
      const h = this.heights.get(k) ?? ground;
      return { d, h, side: h > ground + ON_GROUND_M ? 1 : h < ground - ON_GROUND_M ? -1 : 0 };
    });
    // the runs off the ground, each with the stations at the ground on either side
    const runs: { from: number; to: number; side: number }[] = [];
    level.forEach(({ side }, i) => {
      const last = runs[runs.length - 1];
      if (side !== 0 && last?.side === side && last.to >= i - 1) {
        last.to = Math.min(i + 1, level.length - 1);
      } else if (side !== 0) {
        runs.push({ from: Math.max(0, i - 1), to: Math.min(i + 1, level.length - 1), side });
      }
    });
    if (runs.length === 0) {
      return [];
    }
    const base = { ...way };
    const pieces: Way[] = [];
    let from = 0;
    for (const { from: start, to: j, side } of runs) {
      const i = level.findIndex(({ d }, x) => x >= start && d >= from);
      if (i < 0 || i >= j) {
        continue;
      }
      pieces.push({ ...base, line: stretch(way.line, along, from, level[i].d) });
      const profile = level.slice(i, j + 1).map(({ d, h }): Point => [d, h]);
      const kept = new Set(profile.filter(([d]) => along.some((x) => Math.abs(x - d) < 1e-9)));
      const shaped = simplifyLine(profile, RESOLUTION_M / 2, (q) => kept.has(q));
      const line = shaped.map(([d]) => pointAt(way.line, along, d));
      const heights = shaped.map(([, h]) => h);
      pieces.push(side > 0 ? { ...base, line, deck: heights } : this.#cutPiece(way, { ...base, line, floor: heights }, [level[i].d, level[j].d]));
      side > 0 ? this.raised++ : this.cut++;
      from = level[j].d;
    }
    pieces.push({ ...base, line: stretch(way.line, along, from, along[along.length - 1]) });
    const [head, ...rest] = pieces.filter((p) => p.line.length >= 2);
    Object.assign(way, head);
    return rest;
  }

  /** A stretch in a cut: its floor, and under a deck a road's room the least its users' and the deck leave */
  #cutPiece(way: Way, piece: Way, [from, to]: [number, number]): Way {
    const lows = (this.#underOf.get(way) ?? [])
      .filter(({ at }) => at >= from - 1e-6 && at <= to + 1e-6)
      .map(({ at, deck: [a, b, t], ground }) => (1 - t) * (this.heights.get(a) ?? 0) + t * (this.heights.get(b) ?? 0) - DECK_THICKNESS_M - (this.#heightOf(way, at) ?? ground));
    return isRoad(piece) && lows.length > 0 ? { ...piece, room: Math.min(MIN_CLEARANCE_M[userOf(way)], ...lows) } : piece;
  }

  #heightOf(way: Way, at: number): number | undefined {
    const terms = this.#terms(way, at);
    return terms.length > 0 ? terms.reduce((sum, [k, v]) => sum + v * (this.heights.get(k) ?? 0), 0) : undefined;
  }
}

/** Ways that rise out of a tunnel as stairs do */
function rising(way: Way): boolean {
  return isRoad(way) && (way.kind === "steps" || way.kind === "corridor");
}

/** Whether a line goes on at its end k onto the one other way there (others), which ends there too and `may` take */
function joint(way: Way, others: Way[], k: string, may: (way: Way) => boolean): boolean {
  const [o] = others;
  const ends = (w: Way) => pointKey(w.line[0]) === k || pointKey(w.line[w.line.length - 1]) === k;
  return others.length === 1 && o !== way && may(o) && ends(o) && ends(way);
}

/** Intervals joined where they overlap, in order */
function joined(intervals: [number, number][]): [number, number][] {
  const found: [number, number][] = [];
  for (const [from, to] of [...intervals].sort((x, y) => x[0] - y[0])) {
    const last = found[found.length - 1];
    if (last && from <= last[1]) {
      last[1] = Math.max(last[1], to);
    } else {
      found.push([from, to]);
    }
  }
  return found;
}

/** Of the neighbours of a point, the two going on from it the straightest */
function straightest(p: Point, neighbours: string[], nodes: Map<string, HeightNode>): string[] {
  if (neighbours.length <= 2) {
    return neighbours;
  }
  const out = neighbours.map((k) => {
    const q = nodes.get(k)?.p ?? p;
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return { k, d: [(q[0] - p[0]) / length, (q[1] - p[1]) / length] };
  });
  const pairs = out.flatMap((a, i) => out.slice(i + 1).map((b) => ({ pair: [a.k, b.k], turn: a.d[0] * b.d[0] + a.d[1] * b.d[1] })));
  return pairs.sort((x, y) => x.turn - y.turn)[0].pair;
}

/** The part of a line from `from` to `to` meters along it (along: its points' distances) */
function stretch(line: Point[], along: number[], from: number, to: number): Point[] {
  const points = [pointAt(line, along, from), ...line.filter((_, i) => along[i] > from + 1e-9 && along[i] < to - 1e-9), pointAt(line, along, to)];
  return points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 1e-6);
}
