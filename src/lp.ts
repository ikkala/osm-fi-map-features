// Linear programs, solved with HiGHS (highs.dev, MIT) compiled to WebAssembly: deterministic, one thread.
import { createRequire } from "node:module";
import type { Highs } from "highs";

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

/** A bound on a sum of columns' values (column → factor), missed at `cost` a unit, its miss told as `tag` */
export interface SoftRow<T> {
  cost: number;
  terms: Iterable<[number, number]>;
  lower: number;
  upper: number;
  tag: T;
}

/** A linear program whose rows' bounds may be missed, each by a slack of its own at its row's cost */
export class SoftProgram<T> {
  readonly #program: LinearProgram = { cost: [], lower: [], upper: [], rows: [] };
  readonly #slacks: { column: number; tag: T }[] = [];

  /** A column at a cost a unit within its bounds: its index */
  column(cost: number, lower: number, upper: number): number {
    this.#program.lower.push(lower);
    this.#program.upper.push(upper);
    return this.#program.cost.push(cost) - 1;
  }

  /** lower <= the terms' sum <= upper, missed by the slack's value at the row's cost */
  soft({ cost, terms, lower, upper, tag }: SoftRow<T>): void {
    if (lower === -Infinity && upper === Infinity) {
      return;
    }
    const slack = this.column(cost, 0, Infinity);
    this.#slacks.push({ column: slack, tag });
    const sum = new Map<number, number>();
    for (const [c, v] of terms) {
      sum.set(c, (sum.get(c) ?? 0) + v);
    }
    if (upper < Infinity) {
      this.#program.rows.push({ terms: new Map([...sum, [slack, -1]]), lower: -Infinity, upper });
    }
    if (lower > -Infinity) {
      this.#program.rows.push({ terms: new Map([...sum, [slack, 1]]), lower, upper: Infinity });
    }
  }

  /** The columns' values at the optimum and the rows missed by at least `least`, by how much; undefined where there is none */
  solve(lp: SolveLp, least: number): { x: Float64Array; missed: { tag: T; by: number }[] } | undefined {
    const x = lp(this.#program);
    return x && { x, missed: this.#slacks.filter(({ column }) => x[column] >= least).map(({ column, tag }) => ({ tag, by: x[column] })) };
  }
}
