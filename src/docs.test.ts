// The README says nothing that goes stale as the code changes (CLAUDE.md, "Docs"): no count of the code's own things
// ("the five modules"), no constant's value beside its name, and no constant or setting named that the code does not
// have (one renamed or gone). It names the constant, or says it in words that stay true when it is tuned. Each line of
// ALLOWED lets one finding pass, with why.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Findings let pass: "<doc>: <what was found>", and why */
const ALLOWED = new Map<string, string>([]);

/** The code the docs may name: what the repository has but its docs and what is made */
const CODE_DIRS = ["src", "scripts"];
const CODE_FILES = ["package.json"];
const SKIP = new Set(["node_modules", "dist", "coverage", ".cache"]);
const CODE_EXTENSIONS = /\.(ts|js|mjs|sh|yml|yaml|json|example)$/;

const NUMBER_WORDS = "two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|a dozen";
/** The code's own things, a count of which goes stale */
const CODE_THINGS =
  "rules|specs|tests|modules|scripts|images|remotes|endpoints|options|layers|styles|constants|settings|checks|workers|commands|tables|fields|kinds|classes|menus|containers|services|modes";
const COUNT = new RegExp(`\\b(?:\\d+|${NUMBER_WORDS})\\s+(?:[a-z'-]+\\s+){0,2}?(?:${CODE_THINGS})\\b`, "gi");
const SO_FAR = /\b(?:\d+|two|three|four|five|six|seven|eight|nine|ten)\b[^.]{0,30}\bso far\b/gi;
/** A constant's or a setting's name: capitals with an underscore */
const UPPER = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
/** A constant given a number: NAME = 12, Table.Name = 1.5, { Name = 3, ... } */
const ASSIGNED = /(?:^|[\s{,.(])([A-Za-z_]\w*)\s*(?::\s*[\w.<>]+\s*)?=\s*(-?\d+(?:\.\d+)?)\s*(?=[,;)}\n]|--|\/\/)/gm;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) walk(file, out);
    else if (CODE_EXTENSIONS.test(name) && !name.endsWith(".md")) out.push(file);
  }
}

function codeFiles(): string[] {
  const files: string[] = [];
  for (const dir of CODE_DIRS) walk(path.join(ROOT, dir), files);
  for (const file of CODE_FILES) files.push(path.join(ROOT, file));
  return files.filter((file) => file !== import.meta.filename);
}

function docs(): string[] {
  return readdirSync(ROOT).filter((name) => name.endsWith(".md")).sort();
}

/** The doc's prose, a line at a time: without code blocks and `code` */
function prose(text: string): string[] {
  let fenced = false;
  return text.split("\n").map((line) => {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      return "";
    }
    return fenced ? "" : line.replace(/`[^`]*`/g, "``");
  });
}

/** Counts of the code's own things in a doc's prose */
export function counts(text: string): string[] {
  const found: string[] = [];
  for (const line of prose(text)) {
    const body = line.replace(/^\s*(?:\d+\.|[-*])\s+/, "");
    for (const match of body.matchAll(COUNT)) found.push(match[0]);
    for (const match of body.matchAll(SO_FAR)) found.push(match[0]);
  }
  return found;
}

/** Constants' and settings' names in a doc's `code` that the code does not have */
export function unknownNames(text: string, words: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const span of text.matchAll(/`([^`\n]+)`/g)) {
    for (const match of (span[1] ?? "").matchAll(UPPER)) {
      const after = (span[1] ?? "").slice((match.index ?? 0) + match[0].length);
      if (!words.has(match[0]) && !after.startsWith("<") && !after.startsWith("_<")) found.push(match[0]);
    }
  }
  return found;
}

/** Constants named in a doc's `code` with their value beside them, in the same line (0 and 1 are too common to tell) */
export function valuesBeside(text: string, values: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    const numbers = new Set(line.replace(/`[^`]*`/g, " ").match(/(?<![\w.:-])-?\d+(?:\.\d+)?(?![\w.]?\d)/g) ?? []);
    for (const span of line.matchAll(/`([^`\n]+)`/g)) {
      const name = (span[1] ?? "").split(/[.:']/).pop() ?? "";
      if (!/^[A-Z]/.test(name)) continue;
      for (const value of values.get(name) ?? []) {
        if (value !== "0" && value !== "1" && numbers.has(value)) found.push(`${name} = ${value}`);
      }
    }
  }
  return found;
}

function codeIndex(): { words: Set<string>; values: Map<string, Set<string>> } {
  const words = new Set<string>();
  const values = new Map<string, Set<string>>();
  for (const file of codeFiles()) {
    const text = readFileSync(file, "utf8");
    for (const word of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) words.add(word);
    for (const match of text.matchAll(ASSIGNED)) {
      const [, name, value] = match;
      if (name === undefined || value === undefined || !/^[A-Z]/.test(name)) continue;
      values.set(name, (values.get(name) ?? new Set()).add(value));
    }
  }
  return { words, values };
}

test("a count of the code's things is found, a count of the world's is not", () => {
  assert.deepEqual(counts("The rules are five so far: `passage`, ...\nthe three test images\n"), ["five so far", "three test images"]);
  assert.deepEqual(counts("1. Tag the model.\n- two lakes and 24 steps down\n```\nsix rules\n```\n"), []);
});

test("a name the code does not have is found, a template is not", () => {
  const words = new Set(["MOTION_DELAY"]);
  assert.deepEqual(unknownNames("played back `RENDER_DELAY` behind, `MOTION_DELAY`, `PUSH_URL_<TARGET>`", words), ["RENDER_DELAY"]);
});

test("a constant's value beside its name is found", () => {
  const values = new Map([["DELAY", new Set(["16"])]]);
  assert.deepEqual(valuesBeside("drawn `Motion.DELAY` (16 s) behind", values), ["DELAY = 16"]);
  assert.deepEqual(valuesBeside("drawn `Motion.DELAY` behind, 16 tiles", values), ["DELAY = 16"]);
  assert.deepEqual(valuesBeside("drawn `Motion.DELAY` behind", values), []);
});

test("the docs hold no count of the code's things nor its constants' values, and name only what the code has", () => {
  const { words, values } = codeIndex();
  const found: string[] = [];
  const allowedSeen = new Set<string>();
  for (const doc of docs()) {
    const text = readFileSync(path.join(ROOT, doc), "utf8");
    for (const finding of [...counts(text), ...unknownNames(text, words), ...valuesBeside(text, values)]) {
      const key = `${doc}: ${finding}`;
      if (ALLOWED.has(key)) allowedSeen.add(key);
      else found.push(key);
    }
  }
  assert.deepEqual(found, [], "say these in words that stay true, or name the constant (ALLOWED lets one pass, with why)");
  assert.deepEqual([...ALLOWED.keys()].filter((key) => !allowedSeen.has(key)), [], "ALLOWED lets pass what is no longer found");
});
