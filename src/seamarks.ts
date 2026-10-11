// Lighthouses, lights, beacons and buoys (man_made=lighthouse, seamark:type=*), with their lights' colours and
// rhythms. A light's rhythm is its seamark:light:sequence when tagged, else worked out from its character (Fl, Q,
// Iso, Oc, ...), group and period as the IALA abbreviations describe them.
import type { Point } from "./geometry.ts";

export type SeamarkKind = "lighthouse" | "light" | "beacon" | "buoy";

/** A colour of a sectored light: seen from bearings `from` .. `to` (degrees clockwise from north, from the water toward the light) */
export interface LightSector {
  colour: string;
  from: number;
  to: number;
}

export interface Light {
  /** colour=* of the light in lower case (white, red, green, yellow, ...), the first of a list */
  colour: string;
  /** Seconds lit and dark in turn over its period, lit first: lit, dark, lit, dark, ...; empty: a fixed light */
  phases: number[];
  /** Meters above the water, when OSM tells */
  height?: number;
  /** A sectored light's colours by bearing; unset: the same all round */
  sectors?: LightSector[];
}

export interface Seamark {
  osm: string;
  kind: SeamarkKind;
  /**
   * The rest of seamark:type in lower case: a light's major | minor | ..., a beacon's or buoy's cardinal | lateral |
   * special_purpose | isolated_danger | safe_water | ...; unset for a lighthouse without one
   */
  type?: string;
  /** seamark:<type>:category in lower case: a cardinal's north | east | south | west, a lateral's port | starboard, ... */
  category?: string;
  /** Meters east and north of the origin: the node, or the middle of the way */
  point: Point;
  /** name=*, else seamark:name=* */
  name?: string;
  /** The structure's height (height=*), m */
  height?: number;
  /** A beacon's or buoy's colours in lower case, top first (seamark:<type>:colour) */
  colours?: string[];
  /** seamark:<type>:colour_pattern in lower case: horizontal | vertical | ... */
  pattern?: string;
  /** seamark:<type>:shape in lower case: pillar | spar | conical | can | stake | tower | ... */
  shape?: string;
  /** seamark:topmark:shape in lower case: "2 cones up", cylinder, ... */
  topmark?: string;
  light?: Light;
  /** Drawn as a building too (building=*): only its light is its own */
  building?: boolean;
}

/** Seconds a flash or a quick light's flash lasts, and between the flashes of a group */
const FLASH_S = 0.5;
const LONG_FLASH_S = 2;
const GROUP_GAP_S = 1;
/** An occulting light's eclipse, and between the eclipses of a group */
const ECLIPSE_S = 1;
/** Flashes a minute of quick, very quick and ultra quick lights */
const QUICK_PER_MINUTE: Record<string, number> = { Q: 60, VQ: 120, UQ: 240 };
/** The dark after an interrupted quick light's group, when its period does not tell */
const INTERRUPTION_S = 4;
/** Periods (s) of the characters whose period is not tagged */
const DEFAULT_PERIODS: Record<string, number> = { Fl: 5, LFl: 8, Iso: 4, Oc: 5, Mo: 8 };

/** The seamark of an element, or undefined when it is none of a lighthouse, a light, a beacon or a buoy */
export function parseSeamark(tags: Record<string, string>, osm: string, point: Point): Seamark | undefined {
  const seamarkType = tags["seamark:type"]?.trim().toLowerCase();
  let kind: SeamarkKind | undefined;
  let type: string | undefined;
  if (tags.man_made === "lighthouse") {
    kind = "lighthouse";
    type = seamarkType?.startsWith("light_") ? seamarkType.slice("light_".length) : undefined;
  } else if (seamarkType?.startsWith("light_") || seamarkType === "light") {
    kind = "light";
    type = seamarkType === "light" ? undefined : seamarkType.slice("light_".length);
  } else if (seamarkType?.startsWith("beacon_") || seamarkType?.startsWith("buoy_")) {
    kind = seamarkType.startsWith("beacon_") ? "beacon" : "buoy";
    type = seamarkType.slice(kind.length + 1);
  }
  if (!kind) {
    return undefined;
  }
  const own = (key: string) => (seamarkType ? lower(tags[`seamark:${seamarkType}:${key}`]) : undefined);
  const colours = own("colour")?.split(";").map((c) => c.trim()).filter((c) => c !== "");
  const height = positive(tags.height);
  const name = tags.name?.trim() || tags["seamark:name"]?.trim();
  const light = parseLight(tags);
  return {
    osm,
    kind,
    ...(type && { type }),
    ...(own("category") && { category: own("category") }),
    point,
    ...(name && { name }),
    ...(height !== undefined && { height }),
    ...(colours && colours.length > 0 && { colours }),
    ...(own("colour_pattern") && { pattern: own("colour_pattern") }),
    ...(own("shape") && { shape: own("shape") }),
    ...(lower(tags["seamark:topmark:shape"]) && { topmark: lower(tags["seamark:topmark:shape"]) }),
    ...(light && { light }),
    ...(tags.building && tags.building !== "no" && { building: true }),
  };
}

/** The light of seamark:light:* (or of its numbered lights seamark:light:<n>:*), when it has a colour */
export function parseLight(tags: Record<string, string>): Light | undefined {
  const numbered = new Set<number>();
  for (const key of Object.keys(tags)) {
    const match = /^seamark:light:(\d+):/.exec(key);
    if (match) {
      numbered.add(Number(match[1]));
    }
  }
  const prefixes = numbered.size > 0 ? [...numbered].sort((a, b) => a - b).map((n) => `seamark:light:${n}:`) : ["seamark:light:"];
  const lights = prefixes.flatMap((prefix) => {
    const colour = lower(tags[`${prefix}colour`])?.split(";")[0].trim();
    return colour ? [{ prefix, colour }] : [];
  });
  if (lights.length === 0) {
    return undefined;
  }
  const first = lights[0].prefix;
  const sectors = lights.flatMap(({ prefix, colour }) => {
    const from = number(tags[`${prefix}sector_start`]);
    const to = number(tags[`${prefix}sector_end`]);
    return from !== undefined && to !== undefined ? [{ colour, from: from % 360, to: to % 360 }] : [];
  });
  const height = positive(tags[`${first}height`]);
  return {
    colour: lights[0].colour,
    phases: lightPhases(tags[`${first}character`], number(tags[`${first}group`]), number(tags[`${first}period`]), tags[`${first}sequence`]),
    ...(height !== undefined && { height }),
    // a light lit all round in one of its directions has no sectors
    ...(sectors.length === lights.length && { sectors }),
  };
}

/**
 * Seconds lit and dark in turn over a light's period, lit first; empty for a fixed light. A sequence such as
 * "0.2+(0.8)+0.2+(2.8)" (lit seconds, dark ones in brackets) wins; else the character (F, Fl, LFl, Q, VQ, UQ, IQ,
 * IVQ, IUQ, Iso, Oc, Mo, with "Al." and a group in brackets allowed) with its group and period.
 */
export function lightPhases(character: string | undefined, group?: number, period?: number, sequence?: string): number[] {
  const fromSequence = sequence ? sequencePhases(sequence, period) : undefined;
  if (fromSequence) {
    return fromSequence;
  }
  const match = /^(?:Al\.)?\s*([A-Za-z]+)\s*(?:\((\d+)(?:\+\d+)*\))?/.exec(character?.trim() ?? "");
  const code = match ? match[1] : "F";
  const flashes = Math.max(1, Math.round(match?.[2] ? Number(match[2]) : (group ?? 1)));
  const quick = /^(I?)(Q|VQ|UQ)$/.exec(code);
  if (quick) {
    const half = 30 / QUICK_PER_MINUTE[quick[2]];
    const interrupted = quick[1] === "I" || flashes > 1 || period !== undefined;
    if (!interrupted) {
      return [half, half];
    }
    const lit = Array.from({ length: flashes }, () => [half, half]).flat();
    const total = period ?? flashes * 2 * half + INTERRUPTION_S;
    lit[lit.length - 1] = Math.max(half, total - (flashes * 2 - 1) * half);
    return lit;
  }
  const length = period ?? DEFAULT_PERIODS[code];
  if (code === "Iso" && length) {
    return [length / 2, length / 2];
  }
  if (code === "Oc" && length) {
    // the long light, then the group's eclipses with short lights between them
    const phases = [Math.max(ECLIPSE_S, length - (2 * flashes - 1) * ECLIPSE_S), ECLIPSE_S];
    for (let i = 1; i < flashes; i++) {
      phases.push(ECLIPSE_S, ECLIPSE_S);
    }
    return phases;
  }
  if ((code === "Fl" || code === "LFl" || code === "Mo") && length) {
    const flash = code === "LFl" ? LONG_FLASH_S : FLASH_S;
    const phases = Array.from({ length: flashes }, () => [flash, GROUP_GAP_S]).flat();
    phases[phases.length - 1] = Math.max(GROUP_GAP_S, length - flashes * flash - (flashes - 1) * GROUP_GAP_S);
    return phases;
  }
  return [];
}

/** Phases of a sequence, lit first, the last dark stretched to the period; undefined when it cannot be read */
function sequencePhases(sequence: string, period: number | undefined): number[] | undefined {
  const phases: number[] = [];
  let lit = true;
  let first: boolean | undefined;
  for (const token of sequence.split("+")) {
    const match = /^\s*(\()?\s*(\d+(?:[.,]\d+)?)\s*\)?\s*$/.exec(token);
    if (!match) {
      return undefined;
    }
    const isLit = match[1] === undefined;
    const seconds = Number(match[2].replace(",", "."));
    first ??= isLit;
    if (phases.length > 0 && isLit === lit) {
      phases[phases.length - 1] += seconds;
    } else {
      phases.push(seconds);
      lit = isLit;
    }
  }
  if (phases.length === 0) {
    return undefined;
  }
  // a sequence starting dark goes round to start lit
  if (first === false) {
    const dark = phases.shift() ?? 0;
    if (phases.length % 2 === 0) {
      phases[phases.length - 1] += dark;
    } else {
      phases.push(dark);
    }
  }
  if (phases.length % 2 === 1) {
    phases.push(0);
  }
  const total = phases.reduce((sum, s) => sum + s, 0);
  if (period !== undefined && period > total) {
    phases[phases.length - 1] += period - total;
  }
  return phases.length === 2 && phases[1] === 0 ? [] : phases;
}

function lower(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || undefined;
}

function number(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value.split(";")[0].trim().replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

function positive(value: string | undefined): number | undefined {
  const n = number(value?.replace(/\s*m$/, ""));
  return n !== undefined && n > 0 ? n : undefined;
}
