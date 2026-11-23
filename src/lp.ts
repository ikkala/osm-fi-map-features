// Linear programs, solved with HiGHS (highs.dev, MIT) compiled to WebAssembly: deterministic, one thread.
import { createRequire } from "node:module";
import type { Highs } from "highs";
import { pushTo } from "./geometry.ts";

// its CommonJS build: the types read the package as CommonJS
const loadHighs: () => Promise<Highs> = createRequire(import.meta.url)("highs");

/** Minimise the sum of cost·x, each x within its bounds, each row's sum of its terms (column → coefficient) within its */
export interface LinearProgram {
  cost: number[];
  lower: number[];
  upper: number[];
  rows: { terms: Map<number, number>; lower: number; upper: number }[];
}

/** The columns' values at the optimum, or undefined where there is none (infeasible, unbounded) */
export type SolveLp = (program: LinearProgram) => Float64Array | undefined;

let loading: Promise<SolveLp> | undefined;

/** The solver, its WebAssembly loaded once */
export function loadLp(): Promise<SolveLp> {
  loading ??= loadHighs().then((highs) => ({ cost, lower, upper, rows }) => {
    const starts = [0];
    const terms = rows.flatMap((r) => {
      starts.push(starts[starts.length - 1] + r.terms.size);
      return [...r.terms];
    });
    const matrix = { format: "csr" as const, numRows: rows.length, numCols: cost.length, starts, indices: terms.map(([c]) => c), values: terms.map(([, v]) => v) };
    const model = { numCols: cost.length, numRows: rows.length, colCost: cost, colLower: lower, colUpper: upper, rowLower: rows.map((r) => r.lower), rowUpper: rows.map((r) => r.upper), matrix };
    return highs.withModel(model, (m) => {
      m.options.set({ output_flag: false });
      m.run();
      return m.getModelStatus() === highs.constants.modelStatus.optimal ? m.getSolution().colValue : undefined;
    });
  });
  return loading;
}

/** A bound on a sum of named columns' values (name → factor), missed at `cost` a unit, its miss told as `tag` */
export interface NamedRow<T> {
  cost: number;
  terms: [string, number][];
  lower: number;
  upper: number;
  tag: T;
}

/**
 * Rows over named columns whose bounds may be missed, each by a slack of its own at its row's cost, solved as one
 * program for each group of columns the rows join: a group with no optimum (unbounded, or its columns' bounds
 * crossed) gets no values
 */
export class NamedPrograms<T> {
  readonly #columns = new Map<string, [cost: number, lower: number, upper: number]>();
  readonly #rows: NamedRow<T>[] = [];

  /** A column at a cost a unit within its bounds, replacing one of that name */
  column(name: string, cost: number, lower: number, upper: number): void {
    this.#columns.set(name, [cost, lower, upper]);
  }

  has(name: string): boolean {
    return this.#columns.has(name);
  }

  /** lower <= the terms' sum <= upper, over columns that are there by the time it is solved */
  soft(row: NamedRow<T>): void {
    this.#rows.push(row);
  }

  /**
   * The columns' values, and the rows missed by at least `least`, by how much, by group, with `extra` rows (over the
   * same columns as rows already there), in each group of columns or only those with a column `only` takes
   */
  solve(lp: SolveLp, least: number, extra: NamedRow<T>[] = [], only: (name: string) => boolean = () => true): { values: Map<string, number>; missed: Map<string, { tag: T; by: number }[]> } {
    const all = [...this.#rows, ...extra].filter((r) => r.terms.length > 0 && (r.lower > -Infinity || r.upper < Infinity));
    const group = groupsOf(all.flatMap((r) => r.terms.map(([name]): [string, string] => [r.terms[0][0], name])));
    const names = new Map<string, string[]>();
    const rows = new Map<string, NamedRow<T>[]>();
    this.#columns.forEach((_, name) => pushTo(names, group(name), name));
    all.forEach((r) => pushTo(rows, group(r.terms[0][0]), r));
    const values = new Map<string, number>();
    const missed = new Map<string, { tag: T; by: number }[]>();
    for (const [root, list] of [...names].filter(([, list]) => list.some(only))) {
      const index = new Map(list.map((name, i) => [name, i]));
      const program: LinearProgram = { cost: [], lower: [], upper: [], rows: [] };
      const column = (cost: number, lower: number, upper: number) => {
        program.lower.push(lower);
        program.upper.push(upper);
        return program.cost.push(cost) - 1;
      };
      list.forEach((name) => column(...(this.#columns.get(name) ?? [0, 0, 0])));
      const slacks = (rows.get(root) ?? []).map(({ cost, terms, lower, upper, tag }) => {
        const slack = column(cost, 0, Infinity);
        const sum = new Map<number, number>();
        for (const [name, v] of terms) {
          const c = index.get(name) ?? unknown(name);
          sum.set(c, (sum.get(c) ?? 0) + v);
        }
        program.rows.push(...(upper < Infinity ? [{ terms: new Map([...sum, [slack, -1]]), lower: -Infinity, upper }] : []));
        program.rows.push(...(lower > -Infinity ? [{ terms: new Map([...sum, [slack, 1]]), lower, upper: Infinity }] : []));
        return { slack, tag };
      });
      const x = lp(program);
      list.forEach((name, i) => x && values.set(name, x[i]));
      missed.set(root, x ? slacks.filter(({ slack }) => x[slack] >= least).map(({ slack, tag }) => ({ tag, by: x[slack] })) : []);
    }
    return { values, missed };
  }
}

/** The groups that pairs of names join: each name's group's root */
export function groupsOf(pairs: [string, string][]): (name: string) => string {
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


function unknown(name: string): never {
  throw new Error(`a row over ${name}, which has no column`);
}
