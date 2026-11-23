// Bridge deck heights, and the heights of the ways the decks raise or cut under them, as one linear program for each
// group of them that touch (lp.ts), their bounds missed only by priority, at the least cost (HARD_COST and on), and
// each miss told with its way and place. The elevation model is bare ground, so a deck runs over the hump under it
// from its landings, bending one way only; the model smooths the cut under a bridge into a wider hollow, so a landing
// is taken where its approach stops rising steeply, and steps up to a deck tell its height there (RISER_M a step).
// Every point of a deck's lines (STEP_M apart), of the ways leading off it within APPROACH_REACH_M along them, and of
// the ways under the decks within a cut's reach of them is a height (a point the ways share is one):
// - hard: a cut's and a way's grade between its points, by its users or the ground's where steeper (an approach's as
//   steep as stairs for people), a deck never dipping, a cut no deeper than MAX_DEPTH_M, and under a deck a railway's
//   least room (a tramway's over the lowest its bed goes down to there, trackbeds.ts);
// - the room under the decks, the way's or bridge's that OSM tells, else the users', and over a cut the surfaces of
//   the ways beside it in its room at its height; the heights steps tell; then the bends, along the lines through the
//   points (a deck's at a junction through its straightest pair, the others held at junctions), as the ground's or
//   the curve's that bends MAX_BEND_M over BEND_SPAN_M (a railway's deck's hard); then the users' grade on the
//   approaches and the decks (a deck's as steep as its landings are between them);
// - and each meter a deck or an approach is raised or a way cut, by the length it stands for (a train's TRACK_COST
//   times), so that the decks keep to the line between their landings, the ways to the ground and the cuts shallow.
// The heights are those of the ways on the ground: past the reach the ways keep to it, as they do where a way of other
// users meets an approach, where a way of another kind or layer meets a cut, or a way ends in one, and where OSM tells
// the room over a way (measured from it). A railway's deck keeps to its landings, and a way out of a tunnel to the
// ramp the tunnel's floor gives it (floors.ts). A way's stretch over the ground becomes an approach with a deck, one
// under it a cut with a floor. A boardwalk lies on the ground instead: its deck follows it.
import { BEND_SPAN_M, bends, HARD_COST, MAX_BEND_M, ROOM_COST } from "./floors.ts";
import { DeckIndex, MAX_DEPTH_M } from "./deckIndex.ts";
import { densify, distancesAlong, grownRect, indexOwnBoxes, MinHeap, nearestOnLine, pointAt, pointKey, pushTo, RESOLUTION_M, simplifyLine, type Point } from "./geometry.ts";
import { SoftProgram, type SolveLp } from "./lp.ts";
import { bounds, type Rail, type Road } from "./osm.ts";
import { inTunnel, isBridge, offStructures } from "./profile.ts";
import { DECK_THICKNESS_M, GRADE, isRoad, LEAST_CLEARANCE_M, MIN_CLEARANCE_M, ROOM_SIDE_M, STAIRS_GRADE, TRAM_CUT_CLEARANCE_M, userOf, widthOf, type Way } from "./ways.ts";

/** The approach is walked this often, and at most this far from the bridge's end (m), raised no farther along the ways */
const APPROACH_STEP_M = 2;
export const APPROACH_REACH_M = 24;
/** The ground has stopped rising steeply where it rises less than this in a step (m) */
const APPROACH_RISE_M = 0.2;
/** The hollow's bottom may reach on this far from the bridge's end before the ground starts rising (m) */
const APPROACH_LEVEL_M = 6;
/** A step's rise (m) */
const RISER_M = 0.16;
/** A deck's crest is rounded over a curve of this radius (m) */
const CREST_RADIUS_M = 400;
/** Steps lift a way above the ground that is no bridge only where they tell it more than this over the ground (m) */
const LIFT_M = 0.5;
/** A boardwalk's deck is this far (m) over the ground, level over a dip narrower than BOARDWALK_SPAN_M */
const BOARDWALK_OVER_M = 0.3;
const BOARDWALK_SPAN_M = 6;
/** The ground under a boardwalk is looked at this often (m), and its deck gets a point where it bends more than BOARDWALK_STRAIGHT_M */
const BOARDWALK_STEP_M = 2;
const BOARDWALK_STRAIGHT_M = 0.05;
/** The ways' heights are solved this often along them (m) */
const STEP_M = 2;
/**
 * The costs after the hard bounds and the room (floors.ts), a meter: a bend past the ground's or the curve's, an
 * approach steeper than its users' grade, and each meter a deck or an approach is over the ground (or a deck over the
 * line between its landings) or a way down in a cut, a meter along: raising a deck dearer than a cut under it, and a
 * railway's TRACK_COST times a road's
 */
const BEND_COST = 1e2;
const GRADE_COST = 10;
const RAISE_COST = 0.1;
const CUT_COST = 0.01;
const TRACK_COST = 10;
/**
 * A tram's room under a deck, a meter of it missed: dearer than a cut, cheaper than raising the deck, as its bed goes
 * down under the deck where no cut gives it the room (trackbeds.ts), as deep as MAX_DEPTH_M
 */
const TRAM_ROOM_COST = 0.5;

type HeightAt = (e: number, n: number) => number | undefined;
/** A way's height this near its ground (m) is the ground's: as near as the solver keeps a bound */
const ON_GROUND_M = 1e-3;

/** A height's bound missed: on which way, where most and by how much (m) */
export interface DeckConflict {
  way: string;
  bound: "grade" | "dip" | "room" | "steps" | "bend";
  at: Point;
  by: number;
}

/** What the heights' solving did, for the log */
export interface DecksSolved {
  /** The points of decks steps told the heights of, the stretches of ways raised as approaches and lowered into cuts */
  told: number;
  approaches: number;
  cuts: number;
  conflicts: DeckConflict[];
}

/** A point whose height is solved: a deck's, an approach's, a cut's, or one held at the ground (or at a host deck) */
interface HeightNode {
  p: Point;
  kind: "deck" | "approach" | "cut" | "held";
  ground: number;
  /** The lowest it may be: a landing's and an approach's ground with the hollow under the bridge filled */
  low: number;
  /** The length of way it stands for (m), and whether a railway's */
  weight: number;
  rail: boolean;
  train: boolean;
  /** The way told of its misses */
  osm: string;
}

interface Edge {
  a: string;
  b: string;
  length: number;
  kind: HeightNode["kind"];
  way: Way;
}

/** A bound on a sum of heights (their points' keys and factors), missed at its cost a meter, told at k */
interface Bound {
  cost: number;
  bound: DeckConflict["bound"];
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
 * Sets the decks of the roads' and railways' bridges, and splits off them, pushed onto them, the ways' stretches
 * raised as approaches (`deck`) and lowered into cuts under the decks (`floor`, and a road's `room` there), solved by
 * lp. heightAt takes meters east / north. An end that no line leads on from but ways indoors do (indoors) goes into a
 * building, at whatever floor: it takes no height from the ground, so the deck runs level from its other landings. A
 * line through a building (through) from one bridge's end to another's carries the span on through it, getting a deck
 * as the bridges do. So does a line above the ground that is no bridge (layer over 0: stairs on a structure, a landing)
 * where steps up to an end of it tell a height more than LIFT_M over the ground there, no line on the ground meets
 * them, and its other end is a dead end or meets a line on the ground no lower than that (stairs down from a street to
 * where a spiral goes on down, a landing at a door): a dead end takes no height from the ground, and the lines meeting
 * such a line are not raised as approaches. A span's end on a boardwalk takes its deck's height there.
 */
export function solveDecks(
  roads: Road[],
  rails: Rail[],
  heightAt: HeightAt,
  lp: SolveLp,
  indoors: (p: Point) => boolean = () => false,
  through: (road: Road) => boolean = () => false,
): DecksSolved {
  const ways: Way[] = [...roads, ...rails];
  const boardwalks = roads.filter((l) => isBridge(l) && l.boardwalk === true && !inTunnel(l) && l.floor === undefined && l.line.length >= 2);
  // a boardwalk in a tunnel or ramping down to one goes as a bridge: its line keeps its points
  roads.filter((l) => l.boardwalk === true && !boardwalks.includes(l)).forEach((l) => delete l.boardwalk);
  boardwalks.forEach((b) => setBoardwalkDeck(b, heightAt));
  const atPoint = new Map<string, Way[]>();
  ways.forEach((w) => new Set(w.line.map(pointKey)).forEach((k) => pushTo(atPoint, k, w)));
  const { spans, toldAt, telling, lifting } = spansOf(ways, atPoint, heightAt, through);
  const original = new Map(spans.map((w) => [w, new Set(w.line.map(pointKey))]));
  spans.forEach((s) => (s.line = densify(s.line, STEP_M)));
  const model = new HeightModel(heightAt);
  const told = model.addDecks(spans, toldAt, original);
  const ends = landings(spans, atPoint, heightAt, indoors, lifting, telling, boardwalks);
  model.addApproaches(ends, atPoint, telling);
  model.addCuts(underWays(ways, spans, model, atPoint), atPoint);
  model.build(atPoint);
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
  return { told, approaches: model.raised, cuts: model.cut, conflicts: model.conflicts };
}

/**
 * The lines spanning: the bridges but boardwalks, the lines carried through buildings between bridges' ends, and the
 * lines above the ground that steps lift; the heights steps up to a point tell (from the ground at their other end, a
 * riser a step), the steps telling them, and the lifted lines
 */
function spansOf(ways: Way[], atPoint: Map<string, Way[]>, heightAt: HeightAt, through: (road: Road) => boolean) {
  const spanning = (l: Way) => isBridge(l) && !(isRoad(l) && l.boardwalk === true) && l.line.length >= 2;
  const ends = (l: Way) => [l.line[0], l.line[l.line.length - 1]];
  const bridgeEnds = new Set(ways.filter(spanning).flatMap((l) => ends(l).map(pointKey)));
  const carried = ways.filter((l) => isRoad(l) && !isBridge(l) && l.line.length >= 2 && through(l) && ends(l).every((p) => bridgeEnds.has(pointKey(p))));
  const steps = roads(ways).filter((l) => !isBridge(l) && (l.stepCount ?? 0) > 0 && l.incline !== undefined && l.line.length >= 2);
  const telling = new Set<Way>(steps);
  const stepped = new Map<string, { h: number; by: Way }[]>();
  for (const l of steps) {
    const [start, end] = ends(l);
    const rise = (l.incline === "up" ? 1 : -1) * (l.stepCount ?? 0) * RISER_M;
    for (const [at, from, up] of [[end, start, rise], [start, end, -rise]] as const) {
      const ground = heightAt(...from);
      if (ground !== undefined) {
        pushTo(stepped, pointKey(at), { h: ground + up, by: l });
      }
    }
  }
  const toldAt = (p: Point, except?: Way) => {
    const heights = (stepped.get(pointKey(p)) ?? []).filter((t) => t.by !== except).map((t) => t.h);
    return heights.length > 0 ? Math.max(...heights) : undefined;
  };
  const others = (l: Way, p: Point) => (atPoint.get(pointKey(p)) ?? []).filter((o) => o !== l);
  const onGround = (o: Way) => !isBridge(o) && !inTunnel(o) && o.layer <= 0;
  // whether steps up to p lift l there, its other end at r
  const lifted = (l: Way, p: Point, r: Point) => {
    const [h, ground, below] = [toldAt(p, l), heightAt(...p), heightAt(...r)];
    const beyond = others(l, r);
    return (
      h !== undefined &&
      ground !== undefined &&
      h > ground + LIFT_M &&
      others(l, p).every((o) => !isBridge(o) && (o.layer > 0 || telling.has(o))) &&
      (beyond.length === 0 || (beyond.some(onGround) && below !== undefined && h <= below + LIFT_M))
    );
  };
  const lifting = new Set(
    ways.filter((l) => !isBridge(l) && !carried.includes(l) && !inTunnel(l) && l.layer > 0 && l.line.length >= 2 && (lifted(l, l.line[0], l.line[l.line.length - 1]) || lifted(l, l.line[l.line.length - 1], l.line[0]))),
  );
  return { spans: [...ways.filter(spanning), ...carried, ...lifting], toldAt, telling, lifting };
}

function roads(ways: Way[]): Road[] {
  return ways.filter(isRoad);
}

/**
 * The spans' landings: where a line ends that no other span goes on from, or a way on the ground meets them (not steps
 * telling a height), each with its height (the ground's, or up the ways leading on where the hollow under the bridge
 * reaches past it, or the boardwalk's it ends on; none for a free end: into a building, or a lifted line's dead end)
 * and the ways leading on, which the lifted lines raise none of, with how far each is raised out of the hollow
 */
function landings(spans: Way[], atPoint: Map<string, Way[]>, heightAt: HeightAt, indoors: (p: Point) => boolean, lifting: Set<Way>, telling: Set<Way>, boardwalks: Road[]): Landing[] {
  const spanned = new Set(spans);
  const found = new Map<string, Landing>();
  for (const span of spans) {
    for (const p of [span.line[0], span.line[span.line.length - 1]]) {
      const there = atPoint.get(pointKey(p)) ?? [];
      const leading = there.filter((o) => !spanned.has(o));
      const onwards = there.filter((o) => spanned.has(o) && o !== span);
      if (found.has(pointKey(p)) || (onwards.length > 0 && leading.every((o) => telling.has(o)))) {
        continue;
      }
      const lifts = there.some((o) => lifting.has(o));
      const free = (indoors(p) && leading.length === 0) || (lifts && leading.length === 0);
      const host = boardwalks.find((b) => b.deck && leading.includes(b));
      const approaches = lifts ? [] : leading.filter(approachable(telling)).map((line) => approach(line, p, heightAt));
      const heights = [free ? undefined : heightAt(...p), ...approaches.map((a) => a.top)].filter((h) => h !== undefined);
      const height = host?.deck ? deckAt(host.line, host.deck, p) : heights.length > 0 ? Math.max(...heights) : undefined;
      found.set(pointKey(p), { p, height, approaches, host: host !== undefined, inner: false });
    }
    // the ways leading off a span from its inner points are its approaches too, which hang from its deck there
    for (const p of span.line.slice(1, -1)) {
      const leading = (atPoint.get(pointKey(p)) ?? []).filter((o) => !spanned.has(o) && approachable(telling)(o));
      if (!found.has(pointKey(p)) && leading.length > 0 && !lifting.has(span)) {
        found.set(pointKey(p), { p, height: undefined, approaches: leading.map((line) => approach(line, p, heightAt)), host: false, inner: true });
      }
    }
  }
  return [...found.values()];
}

interface Landing {
  p: Point;
  height: number | undefined;
  approaches: Approach[];
  /** On a boardwalk's deck, which it keeps to */
  host: boolean;
  /** At a span's inner point: no landing, its deck the span's */
  inner: boolean;
}

/** Whether a way may be raised as an approach: on the ground, no steps telling a height */
function approachable(telling: Set<Way>): (way: Way) => boolean {
  return (way) => offStructures(way) && !telling.has(way) && way.line.length >= 2;
}

/**
 * The points where the ways pass under the decks, every STEP_M along them and at their points (not the ways meeting a
 * deck, which lead on from it), with the deck's segment over each and the room: the way's or the bridge's OSM tells,
 * else its users' (a tram's under its overhead line)
 */
function underWays(ways: Way[], spans: Way[], model: HeightModel, atPoint: Map<string, Way[]>): Under[] {
  const index = new DeckIndex(spans);
  const spanned = new Set(spans);
  const found: Under[] = [];
  for (const way of ways.filter((w) => offStructures(w) && !spanned.has(w) && w.line.length >= 2 && !rampOut(w, atPoint))) {
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

/** Whether a way leads out of a tunnel, which ramps down to its portal (tunnels.ts' rampsOut), under a deck too */
function rampOut(way: Way, atPoint: Map<string, Way[]>): boolean {
  return way.line.some((p) => (atPoint.get(pointKey(p)) ?? []).some(inTunnel));
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
  /** Each way's stations in the program: distance along it → its point's key */
  readonly regions = new Map<Way, Map<number, string>>();
  readonly heights = new Map<string, number>();
  readonly conflicts: DeckConflict[] = [];
  readonly #under: Under[] = [];
  readonly #underOf = new Map<Way, Under[]>();
  /** The landings' heights (none: a free end's), those kept to a host's deck, and the approaches' lowest out of the hollows */
  readonly #landings = new Map<string, number | undefined>();
  readonly #fixed = new Map<string, number>();
  readonly #told = new Map<string, number>();
  readonly #fills = new Map<string, number>();
  readonly #hollows = new Map<Way, (Approach & { height: number | undefined })[]>();
  readonly #alongs = new Map<Way, number[]>();
  readonly #deckKeys = new Map<Way, string[]>();
  readonly #sorted = new Map<Way, [number, string][]>();
  readonly #stretches = new Map<Way, { from: number; to: number; kind: "approach" | "cut"; held: (k: string) => boolean; deadEnds: boolean }[]>();
  readonly #grounds = new Map<string, number | undefined>();
  readonly #heightAt: HeightAt;
  raised = 0;
  cut = 0;

  constructor(heightAt: HeightAt) {
    this.#heightAt = heightAt;
  }

  groundAt(p: Point): number | undefined {
    const k = pointKey(p);
    return this.#grounds.has(k) ? this.#grounds.get(k) : this.#grounds.set(k, this.#heightAt(...p)).get(k);
  }

  /** A point of a way, of a kind (the higher of NODE_RANK where several ways' meet), its key: a point added to its line the way's own */
  node(p: Point, kind: HeightNode["kind"], way: Way, own: boolean, low?: number): string {
    const k = own ? pointKey(p) : `${pointKey(p)}|${way.osm}`;
    const ground = this.groundAt(p) ?? low ?? 0;
    const there = this.nodes.get(k);
    if (!there || NODE_RANK[kind] > NODE_RANK[there.kind]) {
      this.nodes.set(k, { p, kind, ground, low: Math.max(low ?? ground, there?.low ?? -Infinity), weight: there?.weight ?? 0, rail: !isRoad(way), train: userOf(way) === "trains", osm: way.osm });
    } else if (low !== undefined) {
      there.low = Math.max(there.low, low);
    }
    return k;
  }

  /** A stretch of a way from one point to the next, of a kind */
  edge(way: Way, a: string, b: string, length: number, kind: HeightNode["kind"]): void {
    this.edges.push({ a, b, length, kind, way });
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

  /** The landings' heights, and the ways leading on from them within APPROACH_REACH_M (of their users, past a way of other users held at the ground), out of the hollows under the bridges first */
  addApproaches(landings: Landing[], atPoint: Map<string, Way[]>, telling: Set<Way>): void {
    for (const { p, height: ground, approaches, host, inner } of landings) {
      const k = pointKey(p);
      if (inner) {
        continue;
      }
      // steps up to it tell its height
      const height = this.#told.get(k) ?? ground;
      this.#landings.set(k, height);
      // on a boardwalk, or with no way to raise as an approach, it keeps its height
      // a railway's deck stays on its landings: its line keeps its gentle grade far past the approaches, and its tracks side by side would part
      if ((host || approaches.length === 0 || this.nodes.get(k)?.rail) && height !== undefined) {
        this.#fixed.set(k, height);
      }
      approaches.forEach((a) => pushTo(this.#hollows, a.line, { ...a, height }));
    }
    const may = approachable(telling);
    for (const user of new Set(landings.flatMap((l) => l.approaches.map((a) => userOf(a.line))))) {
      const sources = landings.flatMap((l) => l.approaches.filter((a) => userOf(a.line) === user));
      const own = (w: Way) => may(w) && userOf(w) === user;
      this.#region("approach", this.#reach(sources.map((a) => ({ way: a.line, at: a.at })), APPROACH_REACH_M, own, atPoint), (k) => (atPoint.get(k) ?? []).some((o) => !own(o)), false);
    }
  }

  /** The ways under the decks, within a cut's reach along those of their kind and layer: the room under the decks over them */
  addCuts(under: Under[], atPoint: Map<string, Way[]>): void {
    const group = (w: Way) => `${userOf(w)}|${w.layer}`;
    const cut = under.filter((u) => !u.told);
    for (const key of new Set(cut.map((u) => group(u.way)))) {
      const sources = cut.filter((u) => group(u.way) === key);
      // a way with the room under it told keeps to the ground
      const own = (w: Way) => offStructures(w) && group(w) === key && w.clearance === undefined && !rampOut(w, atPoint);
      const reach = MAX_DEPTH_M / GRADE[userOf(sources[0].way)] + BEND_SPAN_M;
      this.#region("cut", this.#reach(sources.map((u) => ({ way: u.way, at: u.at })), reach, own, atPoint), (k) => (atPoint.get(k) ?? []).some((o) => !own(o)), true);
    }
    this.#under.push(...under);
    under.forEach((u) => pushTo(this.#underOf, u.way, u));
  }

  /** The stretches of the ways `may` takes within reach of the sources along them: each way's [from, to] (m along it) */
  #reach(sources: { way: Way; at: number }[], reach: number, may: (way: Way) => boolean, atPoint: Map<string, Way[]>): Map<Way, [number, number][]> {
    const anchors = new Map<Way, { at: number; d: number }[]>();
    const best = new Map<string, number>();
    const heap = new MinHeap<string>();
    const reachTo = (k: string, d: number) => {
      if (d < reach && d < (best.get(k) ?? Infinity)) {
        best.set(k, d);
        heap.push(k, d);
      }
    };
    for (const { way, at } of sources) {
      pushTo(anchors, way, { at, d: 0 });
      this.#along(way).forEach((x, i) => reachTo(pointKey(way.line[i]), Math.abs(x - at)));
    }
    for (let top = heap.pop(); top; top = heap.pop()) {
      if (top.value > (best.get(top.item) ?? Infinity)) {
        continue;
      }
      for (const way of (atPoint.get(top.item) ?? []).filter(may)) {
        const along = this.#along(way);
        way.line.forEach((p, i) => {
          if (pointKey(p) === top.item) {
            pushTo(anchors, way, { at: along[i], d: top.value });
            [i - 1, i + 1].filter((j) => j >= 0 && j < along.length).forEach((j) => reachTo(pointKey(way.line[j]), top.value + Math.abs(along[j] - along[i])));
          }
        });
      }
    }
    return new Map(
      [...anchors].map(([way, list]) => {
        const length = this.#along(way)[way.line.length - 1];
        return [way, merged(list.map(({ at, d }): [number, number] => [Math.max(0, at - (reach - d)), Math.min(length, at + (reach - d))]))];
      }),
    );
  }

  /** Stretches of ways of a kind, held at the ground where `held`, and (deadEnds) at a way's end no other meets */
  #region(kind: "approach" | "cut", stretches: Map<Way, [number, number][]>, held: (k: string) => boolean, deadEnds: boolean): void {
    for (const [way, list] of stretches) {
      list.forEach(([from, to]) => pushTo(this.#stretches, way, { from, to, kind, held, deadEnds }));
    }
  }

  /**
   * The stations and steps of the ways' stretches, those of several kinds on a way joined (an approach's where they
   * overlap), held at the ground at their ends inside a way
   */
  build(atPoint: Map<string, Way[]>): void {
    for (const [way, list] of this.#stretches) {
      const along = this.#along(way);
      const length = along[along.length - 1];
      const own = new Map<number, string>();
      this.regions.set(way, own);
      const covering = (d: number) => list.filter((s) => s.from <= d + 1e-6 && s.to >= d - 1e-6).sort((x, y) => NODE_RANK[y.kind] - NODE_RANK[x.kind])[0];
      for (const [from, to] of merged(list.map((s): [number, number] => [s.from, s.to]))) {
        const ds = stations(from, to, [...along, ...this.#fillEnds(way)]);
        const keys = ds.map((d, i) => {
          const p = pointAt(way.line, along, d);
          const k = pointKey(p);
          const by = covering(d);
          const end = (d > 1e-6 && d < length - 1e-6 && (i === 0 || i === ds.length - 1)) || (by?.deadEnds && (atPoint.get(k) ?? []).length === 1 && (d < 1e-6 || d > length - 1e-6));
          return this.node(p, end || !by || by.held(k) ? "held" : by.kind, way, along.includes(d));
        });
        ds.forEach((d, i) => {
          own.set(d, keys[i]);
          const fill = this.#fill(way, d);
          if (fill !== undefined) {
            this.#fills.set(keys[i], Math.max(fill, this.#fills.get(keys[i]) ?? -Infinity));
          }
        });
        keys.slice(1).forEach((k, i) => this.edge(way, keys[i], k, ds[i + 1] - ds[i], covering((ds[i] + ds[i + 1]) / 2)?.kind ?? "cut"));
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
   * The ways beside the cuts, their surfaces in a cut's room (its width and ROOM_SIDE_M either side), share its height
   * there: they go down with it, or hold it at theirs
   */
  addBesides(ways: Way[]): void {
    const near = ways.filter((w) => offStructures(w) && w.line.length >= 2);
    const index = indexOwnBoxes(near.map((w) => grownRect(bounds(w.line), widthOf(w) / 2)));
    for (const [way, own] of this.regions) {
      const reach = widthOf(way) / 2 + ROOM_SIDE_M;
      const keys = new Set(way.line.map(pointKey));
      for (const k of own.values()) {
        const node = this.nodes.get(k);
        if (node?.kind !== "cut") {
          continue;
        }
        const p = node.p;
        // not where they meet: a way crossing it, or leading on from it
        const meets = (other: Way) => other.line.some((q) => keys.has(pointKey(q)) && Math.hypot(q[0] - p[0], q[1] - p[1]) < reach + widthOf(other));
        for (const other of index(grownRect(bounds([p]), reach)).map((i) => near[i]).filter((o) => o !== way && !meets(o))) {
          const { point, distance, segment } = nearestOnLine(other.line, p);
          const terms = this.#terms(other, this.#along(other)[segment] + Math.hypot(point[0] - other.line[segment][0], point[1] - other.line[segment][1]));
          const ground = this.groundAt(point);
          if (distance < reach + widthOf(other) / 2 && (terms.length > 0 || ground !== undefined)) {
            const level = terms.length > 0 ? 0 : (ground ?? 0);
            this.bounds.push({ cost: ROOM_COST, bound: "room", k, terms: [[k, 1], ...terms.map(([q, v]): [string, number] => [q, -v])], lower: level, upper: level });
          }
        }
      }
    }
  }

  /** A span's point's key */
  deckKey(span: Way, i: number): string {
    return this.#deckKeys.get(span)?.[i] ?? pointKey(span.line[i]);
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
    const decks = groupsOf(this.edges.filter((e) => e.kind === "deck").map((e) => [e.a, e.b]));
    const anchors = new Map<string, number>();
    for (const [k, h] of [...this.#landings, ...this.#told]) {
      const root = decks(k);
      anchors.set(root, Math.max(h ?? -Infinity, anchors.get(root) ?? -Infinity));
    }
    const bounds = [...this.bounds, ...this.#grades(decks), ...this.#bends(), ...this.#rooms()];
    const groups = groupsOf([...this.edges.map((e): [string, string] => [e.a, e.b]), ...bounds.flatMap((b) => b.terms.map(([q]): [string, string] => [b.k, q]))]);
    const keysOf = new Map<string, string[]>();
    const rowsOf = new Map<string, Bound[]>();
    this.nodes.forEach((_, k) => pushTo(keysOf, groups(k), k));
    bounds.forEach((b) => pushTo(rowsOf, groups(b.k), b));
    const missed = new Map<string, DeckConflict>();
    for (const [group, keys] of keysOf) {
      const rows = rowsOf.get(group) ?? [];
      const index = new Map(keys.map((k, i) => [k, i]));
      const program = new SoftProgram<{ k: string; bound: DeckConflict["bound"] }>();
      for (const k of keys) {
        const node = this.nodes.get(k);
        const [low, high] = node ? this.#limits(k, node, anchors.get(decks(k))) : [0, 0];
        program.column((node?.weight ?? 0) * (node?.train ? TRACK_COST : 1) * (node?.kind === "cut" ? -CUT_COST : node?.kind === "held" ? 0 : RAISE_COST), low, high);
      }
      rows.forEach(({ cost, bound, k, terms, lower, upper }) => program.soft({ cost, lower, upper, tag: { k, bound }, terms: terms.map(([q, v]): [number, number] => [index.get(q) ?? -1, v]) }));
      const solved = program.solve(lp, RESOLUTION_M / 2);
      keys.forEach((k, i) => solved && this.heights.set(k, solved.x[i]));
      for (const { tag: { k, bound }, by } of solved?.missed ?? []) {
        const way = this.nodes.get(k)?.osm ?? k;
        if (by > (missed.get(`${way} ${bound}`)?.by ?? 0)) {
          missed.set(`${way} ${bound}`, { way, bound, at: this.nodes.get(k)?.p ?? [0, 0], by });
        }
      }
    }
    this.conflicts.push(...missed.values());
  }

  /** How low and high a point may be: a landing at its height (a free end at its deck's highest landing's), an approach over its ground or fill, a cut no deeper than MAX_DEPTH_M */
  #limits(k: string, node: HeightNode, anchor: number | undefined): [number, number] {
    const fixed = this.#fixed.get(k);
    if (node.kind === "deck") {
      const known = anchor !== undefined && Number.isFinite(anchor);
      const landing = this.#landings.has(k) ? (this.#landings.get(k) ?? (known ? anchor : node.ground)) : known ? -Infinity : node.ground;
      return fixed === undefined ? [landing, Infinity] : [fixed, fixed];
    }
    if (node.kind === "approach") {
      return [Math.max(node.ground, this.#fills.get(k) ?? -Infinity), Infinity];
    }
    return node.kind === "cut" ? [node.ground - MAX_DEPTH_M, node.ground] : [node.ground, node.ground];
  }

  /** A point's lowest as its kind lets it: an approach's out of the hollow */
  #low(k: string): number {
    const node = this.nodes.get(k);
    return node?.kind === "approach" ? Math.max(node.ground, this.#fills.get(k) ?? -Infinity) : (node?.ground ?? 0);
  }

  /**
   * The grades between the points: a deck's no steeper than its users' or its landings' between them, an approach's
   * than the ground under it, or stairs for people, and missed past its users' grade only at GRADE_COST, a cut's than
   * its users' (stairs') or the ground's
   */
  #grades(decks: (k: string) => string): Bound[] {
    const steepest = new Map<string, number>();
    const landings = [...this.#landings, ...this.#told].flatMap(([k, h]) => (h === undefined ? [] : [{ k, h, p: this.nodes.get(k)?.p ?? [0, 0] }]));
    for (const a of landings) {
      for (const b of landings.filter((l) => l.k !== a.k && decks(l.k) === decks(a.k))) {
        steepest.set(decks(a.k), Math.max(steepest.get(decks(a.k)) ?? 0, Math.abs(a.h - b.h) / (Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]) || 1)));
      }
    }
    return this.edges.flatMap(({ a, b, length, kind, way }) => {
      const grade = isRoad(way) && way.kind === "steps" && kind === "cut" ? STAIRS_GRADE : GRADE[userOf(way)];
      const ground = Math.abs(this.#low(a) - this.#low(b));
      const row = (cost: number, most: number): Bound => ({ cost, bound: "grade", k: a, terms: [[a, 1], [b, -1]], lower: -most, upper: most });
      if (kind === "deck") {
        return [row(GRADE_COST, Math.max(grade, steepest.get(decks(a)) ?? 0) * length)];
      }
      if (kind === "approach") {
        return [row(GRADE_COST, Math.max(grade * length, ground)), ...(userOf(way) === "people" ? [row(HARD_COST, Math.max(STAIRS_GRADE * length, ground))] : [])];
      }
      return [row(HARD_COST, Math.max(grade * length, ground))];
    });
  }

  /**
   * The bends along the lines through the points: a deck's through its interior's and a junction's straightest pair
   * of neighbours, never dipping, an approach's and a cut's where two of its kind meet (held at junctions), each as
   * much as the ground's or MAX_BEND_M over BEND_SPAN_M lets it
   */
  #bends(): Bound[] {
    const next = new Map<string, Edge[]>();
    this.edges.forEach((e) => [e.a, e.b].forEach((k) => pushTo(next, k, e)));
    const found: Bound[] = [];
    for (const [k, node] of this.nodes) {
      const edges = next.get(k) ?? [];
      // a deck's through its own steps, the ways leading off it aside
      const own = edges.filter((e) => e.kind === node.kind);
      const through = node.kind === "held" || this.#landings.has(k) || (node.kind !== "deck" && own.length < edges.length) ? [] : straightest(node.p, own.map((e) => (e.a === k ? e.b : e.a)), this.nodes);
      if (through.length !== 2 || (node.kind !== "deck" && edges.length !== 2)) {
        continue;
      }
      const keys = [through[0], k, through[1]];
      const points = keys.map((q) => this.nodes.get(q)?.p ?? node.p);
      for (const { terms, allowed } of bends(points, keys)) {
        const ground = node.kind === "deck" ? 0 : terms.reduce((sum, [q, v]) => sum + v * this.#low(q), 0);
        const cost = node.kind === "deck" && node.rail ? HARD_COST : BEND_COST;
        found.push({ cost, bound: "bend", k, terms, lower: node.kind === "deck" ? -Infinity : Math.min(0, ground) - allowed, upper: Math.max(0, ground) + allowed });
        if (node.kind === "deck") {
          found.push({ cost: HARD_COST, bound: "dip", k, terms, lower: 0, upper: Infinity });
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
   * cuts with floors (a road's room there the least its users' and the decks over it leave), each with its line's
   * points and those its heights' shape needs. Returns the stretches but the first, which the way keeps.
   */
  split(way: Way): Way[] {
    const along = this.#along(way);
    const stationsOf = this.#stations(way);
    const level = stationsOf.map(([d, k]) => {
      const ground = this.groundAt(pointAt(way.line, along, d)) ?? 0;
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
      const run = level.slice(i, j + 1);
      const profile = run.map(({ d, h }): Point => [d, h]);
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

  /** A stretch in a cut: its floor, and a road's room the least its users' and the decks over it leave */
  #cutPiece(way: Way, piece: Way, [from, to]: [number, number]): Way {
    if (!isRoad(piece)) {
      return piece;
    }
    const lows = (this.#underOf.get(way) ?? []).map(({ at, deck: [a, b, t], ground }) => ({ at, left: (1 - t) * (this.heights.get(a) ?? 0) + t * (this.heights.get(b) ?? 0) - DECK_THICKNESS_M - (this.#heightOf(way, at) ?? ground) }));
    const room = Math.min(MIN_CLEARANCE_M[userOf(way)], ...lows.filter(({ at }) => at >= from - 1e-6 && at <= to + 1e-6).map(({ left }) => left));
    return { ...piece, room };
  }

  #heightOf(way: Way, at: number): number | undefined {
    const terms = this.#terms(way, at);
    return terms.length > 0 ? terms.reduce((sum, [k, v]) => sum + v * (this.heights.get(k) ?? 0), 0) : undefined;
  }
}

/** Intervals joined where they overlap, in order */
function merged(intervals: [number, number][]): [number, number][] {
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

/** The groups that pairs of keys join: each key's group's first key */
function groupsOf(pairs: [string, string][]): (k: string) => string {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let root = k;
    for (let up = parent.get(root); up !== undefined && up !== root; up = parent.get(root)) {
      root = up;
    }
    for (let at = k; at !== root; ) {
      const up = parent.get(at) ?? root;
      parent.set(at, root);
      at = up;
    }
    return root;
  };
  pairs.forEach(([a, b]) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) {
      parent.set(ra, rb);
    }
  });
  return find;
}

/** The part of a line from `from` to `to` meters along it (along: its points' distances) */
function stretch(line: Point[], along: number[], from: number, to: number): Point[] {
  const points = [pointAt(line, along, from), ...line.filter((_, i) => along[i] > from + 1e-9 && along[i] < to - 1e-9), pointAt(line, along, to)];
  return points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 1e-6);
}

/**
 * A boardwalk's deck: BOARDWALK_OVER_M over the ground, which it follows but over dips narrower than
 * BOARDWALK_SPAN_M (the lowest of the highest grounds of the stretches that long around each point), its line
 * getting points where the deck bends. A boardwalk with no ground under it gets none.
 */
function setBoardwalkDeck(boardwalk: { line: Point[]; deck?: number[] }, heightAt: HeightAt): void {
  // the ground every step along the line, its points among them
  const samples: { p: Point; d: number; point: boolean }[] = [];
  let d = 0;
  boardwalk.line.forEach((p, i) => {
    if (i > 0) {
      const q = boardwalk.line[i - 1];
      const length = Math.hypot(p[0] - q[0], p[1] - q[1]);
      const steps = Math.ceil(length / BOARDWALK_STEP_M);
      for (let k = 1; k < steps; k++) {
        samples.push({ p: [q[0] + ((p[0] - q[0]) * k) / steps, q[1] + ((p[1] - q[1]) * k) / steps], d: d + (length * k) / steps, point: false });
      }
      d += length;
    }
    samples.push({ p, d, point: true });
  });
  const measured = samples.map((s) => heightAt(...s.p));
  if (measured.every((h) => h === undefined)) {
    return;
  }
  // where the model has no ground, the nearest sample's
  const ground = measured.map((h, i) => {
    if (h !== undefined) {
      return h;
    }
    const nearest = measured.flatMap((m, j) => (m === undefined ? [] : [{ m, far: Math.abs(samples[j].d - samples[i].d) }])).sort((a, b) => a.far - b.far)[0];
    return nearest.m;
  });
  // the highest ground of the stretch from a sample on (or back) BOARDWALK_SPAN_M, within the boardwalk
  const highest = (from: number, to: number) => Math.max(...ground.filter((_, j) => samples[j].d >= from - 1e-9 && samples[j].d <= to + 1e-9));
  const deck = samples.map(({ d: at }) => {
    const starts = samples.filter((s) => s.d >= at - BOARDWALK_SPAN_M - 1e-9 && s.d <= at + 1e-9).map((s) => s.d);
    const ends = samples.filter((s) => s.d >= at - 1e-9 && s.d <= at + BOARDWALK_SPAN_M + 1e-9).map((s) => s.d);
    return Math.min(...starts.map((s) => highest(s, s + BOARDWALK_SPAN_M)), ...ends.map((e) => highest(e - BOARDWALK_SPAN_M, e))) + BOARDWALK_OVER_M;
  });
  // the line's points, and between them the samples where the deck bends away from a straight line
  const kept = new Set(samples.flatMap((s, i) => (s.point ? [i] : [])));
  const keep = (a: number, b: number) => {
    let worst = -1;
    let most = BOARDWALK_STRAIGHT_M;
    for (let i = a + 1; i < b; i++) {
      const t = (samples[i].d - samples[a].d) / (samples[b].d - samples[a].d);
      const off = Math.abs(deck[i] - (deck[a] + (deck[b] - deck[a]) * t));
      if (off > most) {
        [worst, most] = [i, off];
      }
    }
    if (worst >= 0) {
      kept.add(worst);
      keep(a, worst);
      keep(worst, b);
    }
  };
  const points = [...kept].sort((a, b) => a - b);
  for (let i = 0; i + 1 < points.length; i++) {
    keep(points[i], points[i + 1]);
  }
  const indices = [...kept].sort((a, b) => a - b);
  boardwalk.line = indices.map((i) => samples[i].p);
  boardwalk.deck = indices.map((i) => Math.round(deck[i] * 100) / 100);
}

/** The upper hull of heights by distance: the lowest line above them all that bends one way only */
export function upperHull(points: { d: number; h: number }[]): { d: number; h: number }[] {
  const sorted = [...points].sort((p, q) => p.d - q.d || q.h - p.h);
  const hull: { d: number; h: number }[] = [];
  for (const p of sorted) {
    if (hull.length > 0 && hull[hull.length - 1].d === p.d) {
      continue;
    }
    // drop the last point while it lies on or under the line from the one before it to p
    while (hull.length >= 2) {
      const [o, q] = [hull[hull.length - 2], hull[hull.length - 1]];
      if ((q.d - o.d) * (p.h - o.h) - (q.h - o.h) * (p.d - o.d) < 0) {
        break;
      }
      hull.pop();
    }
    hull.push(p);
  }
  return hull;
}

export interface Crest {
  /** Where the curve starts and its length along the span (m), the height and grade there, and the change of grade */
  from: number;
  length: number;
  height: number;
  grade: number;
  change: number;
}

/** The curves rounding a profile's crests: CREST_RADIUS_M, no longer than the stretches on either side */
export function crests(profile: { d: number; h: number }[]): Crest[] {
  const curves: Crest[] = [];
  for (let i = 1; i + 1 < profile.length; i++) {
    const [p, q, r] = [profile[i - 1], profile[i], profile[i + 1]];
    const [before, after] = [(q.h - p.h) / (q.d - p.d), (r.h - q.h) / (r.d - q.d)];
    const change = before - after;
    const length = Math.min(CREST_RADIUS_M * change, q.d - p.d, r.d - q.d);
    if (change > 0 && length > 0) {
      curves.push({ from: q.d - length / 2, length, height: q.h - (before * length) / 2, grade: before, change });
    }
  }
  return curves;
}

/** The height d along a profile, on its crests' curves where they are */
export function rounded(profile: { d: number; h: number }[], curves: Crest[], d: number): number {
  const curve = curves.find((c) => d >= c.from && d <= c.from + c.length);
  if (!curve) {
    return along(profile, d);
  }
  const x = d - curve.from;
  return curve.height + curve.grade * x - (curve.change * x * x) / (2 * curve.length);
}

/** The height d along a profile of points by distance, straight between them and level past its ends */
function along(profile: { d: number; h: number }[], d: number): number {
  if (d <= profile[0].d) {
    return profile[0].h;
  }
  for (let i = 1; i < profile.length; i++) {
    if (d <= profile[i].d) {
      const [p, q] = [profile[i - 1], profile[i]];
      return p.h + ((q.h - p.h) * (d - p.d)) / (q.d - p.d || 1);
    }
  }
  return profile[profile.length - 1].h;
}


interface Approach {
  line: Way;
  /** How far along the line its landing is, and which way along it the approach goes from there (0: both, from its middle) */
  at: number;
  toward: 1 | -1 | 0;
  /** Meters from the bridge's end to where the ground stops rising steeply (0: it does not rise), and the ground there */
  length: number;
  top: number | undefined;
}

/** Walks a line leading on from a bridge's end at p up to where the ground stops rising steeply (not from its middle) */
function approach(line: Way, p: Point, heightAt: HeightAt): Approach {
  const along = distancesAlong(line.line);
  const i = line.line.findIndex((q) => pointKey(q) === pointKey(p));
  const toward = i === 0 ? 1 : i === line.line.length - 1 ? -1 : 0;
  const points = toward > 0 ? line.line : [...line.line].reverse();
  let length = 0;
  let top = heightAt(...p);
  for (let d = APPROACH_STEP_M; d <= APPROACH_REACH_M && toward !== 0; d += APPROACH_STEP_M) {
    const q = pointAlong(points, d);
    const h = q && heightAt(...q);
    if (h === undefined || top === undefined) {
      break;
    }
    if (h - top < APPROACH_RISE_M) {
      if (length > 0 || d >= APPROACH_LEVEL_M) {
        break;
      }
      continue;
    }
    length = d;
    top = h;
  }
  return { line, at: along[Math.max(0, i)], toward, length, top };
}
/** The point d meters along a line from its start, or undefined past its end */
export function pointAlong(points: Point[], d: number): Point | undefined {
  let left = d;
  for (let i = 1; i < points.length; i++) {
    const [a, c] = [points[i - 1], points[i]];
    const step = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (left <= step) {
      const k = step > 0 ? left / step : 0;
      return [a[0] + (c[0] - a[0]) * k, a[1] + (c[1] - a[1]) * k];
    }
    left -= step;
  }
  return undefined;
}

/** The deck height at a point on (or next to) a line with deck heights: from the nearest segment. */
export function deckAt(line: Point[], deck: number[], p: Point): number {
  let best = Infinity;
  let height = deck[0];
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i];
    const dx = line[i + 1][0] - ax;
    const dy = line[i + 1][1] - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq > 0 ? Math.min(Math.max(((p[0] - ax) * dx + (p[1] - ay) * dy) / lengthSq, 0), 1) : 0;
    const distance = Math.hypot(ax + dx * t - p[0], ay + dy * t - p[1]);
    if (distance < best) {
      best = distance;
      height = deck[i] + (deck[i + 1] - deck[i]) * t;
    }
  }
  return height;
}
