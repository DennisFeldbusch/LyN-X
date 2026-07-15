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

// INDEXING-phase budget, counted in AST-node VISITS (a different unit from the resolver's _ops). The index
// walk runs BEFORE any resolution and was previously ungoverned, so a pathological file could burn the whole
// wall-clock there and emit nothing. When this cap is hit the walk stops on a PARTIALLY-indexed tree and the
// sinks found so far are still resolved (partial file result), instead of hanging. Env-overridable via
// LYNX_INDEX_BUDGET; 0 disables. Default is generous — ~30x the node count of the largest real bundles seen —
// so it only trips on runaway growth, not on legitimately large files.
const INDEX_BUDGET = process.env.LYNX_INDEX_BUDGET !== undefined ? +process.env.LYNX_INDEX_BUDGET : 15000000;

// Cap on the number of distinct value combinations a single expression may fan out to (this.maxCombos).
// Bounds the cartesian blow-up of conditionals/concatenations; excess combos are truncated. The one
// resolver tuning knob that isn't a budget — kept here so all limits live in one place.
const MAX_COMBOS = 8000;

// Candidate-string length limits, shared by cartesianConcat (analyze.js) and deduplicateAndCap (resolve.js).
// MAX_VALUE_LEN: past this a string is a runaway concat, not a URL — dropped. LEN_CHARGE_FLOOR: above this,
// string ops charge the op-budget proportional to length (build + Set-hash + StringEqual scale with length),
// so long-string fan-out trips the budget promptly; below it every value charges 1, leaving normal
// short-URL files unaffected.
const MAX_VALUE_LEN = 8192;
const LEN_CHARGE_FLOOR = 512;

// Collect the argument node of every ReturnStatement in a function body, WITHOUT descending into nested
// functions (their returns aren't this function's). Pure pre-order AST walk. Callers handle the
// arrow-with-expression-body case (() => x) separately, since that has no ReturnStatement.
//
// A function's return set is STATIC, so the result is MEMOIZED per body node — interproc resolves the same
// function many times (once per distinct call-override combo), and re-scanning a large body each time was
// the interproc hot path on big bundles. The scan also only descends into real AST children (objects with a
// string `.type`, or arrays of them), skipping acorn's `loc`/`start`/`end` location metadata — those hold no
// ReturnStatements and, being shared across nodes in some bundles, ballooned the walk.
const _returnsCache = new WeakMap();
function collectReturns(node) {
    if (node && typeof node === "object" && _returnsCache.has(node)) return _returnsCache.get(node);
    const returns = [];
    const scan = (n) => {
        if (!n || typeof n !== "object") return;
        if (n.type === "ReturnStatement") { returns.push(n.argument); return; }
        if (n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") return;
        for (const key in n) {
            if (key === "parent" || key === "loc") continue;
            const child = n[key];
            if (Array.isArray(child)) { for (const c of child) if (c && typeof c.type === "string") scan(c); }
            else if (child && typeof child.type === "string") scan(child);
        }
    };
    scan(node);
    if (node && typeof node === "object") _returnsCache.set(node, returns);
    return returns;
}

module.exports = { OP_BUDGET, TOTAL_BUDGET, INDEX_BUDGET, MAX_COMBOS, MAX_VALUE_LEN, LEN_CHARGE_FLOOR, collectReturns };
