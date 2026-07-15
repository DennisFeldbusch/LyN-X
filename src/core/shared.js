"use strict";
// Cross-cutting helpers shared by the resolver mixins (resolve.js / runtime.js).

// PER-SINK resolver work budget: caps resolve operations (via this._ops) for ONE sink so a deep or
// combinatorially-explosive sink bails to partial (templated) results instead of hanging — AND, crucially,
// without starving the other sinks (this._ops is reset per sink in recordResolvedSinkValues). Deterministic
// (op count, not wall-clock, so results are machine-independent). Env-overridable via LYNX_OP_BUDGET; 0 disables.
const OP_BUDGET = process.env.LYNX_OP_BUDGET !== undefined ? +process.env.LYNX_OP_BUDGET : 2000000;

// Whole-file ceiling on cumulative resolve operations across ALL sinks (this._totalOps). Backstops the
// per-sink budget so a file with thousands of expensive sinks can't run unbounded: once crossed, the
// remaining sinks are skipped (partial file result). Env-overridable via LYNX_TOTAL_BUDGET; 0 disables.
const TOTAL_BUDGET = process.env.LYNX_TOTAL_BUDGET !== undefined ? +process.env.LYNX_TOTAL_BUDGET : 20000000;

// Cap on the number of distinct value combinations a single expression may fan out to (this.maxCombos).
// Bounds the cartesian blow-up of conditionals/concatenations; excess combos are truncated. The one
// resolver tuning knob that isn't a budget — kept here so all limits live in one place.
const MAX_COMBOS = 8000;

// Collect the argument node of every ReturnStatement in a function body, WITHOUT descending into nested
// functions (their returns aren't this function's). Pure pre-order AST walk. Callers handle the
// arrow-with-expression-body case (() => x) separately, since that has no ReturnStatement.
function collectReturns(node) {
    const returns = [];
    const scan = (n) => {
        if (!n || typeof n !== "object") return;
        if (n.type === "ReturnStatement") { returns.push(n.argument); return; }
        if (n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") return;
        for (const key in n) {
            if (key === "parent") continue;
            const child = n[key];
            if (Array.isArray(child)) child.forEach(c => scan(c));
            else scan(child);
        }
    };
    scan(node);
    return returns;
}

module.exports = { OP_BUDGET, TOTAL_BUDGET, MAX_COMBOS, collectReturns };
