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
