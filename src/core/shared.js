"use strict";
// Cross-cutting helpers shared by the resolver mixins (resolve.js / runtime.js).

// Global per-file resolver work budget: caps TOTAL resolve operations (via this._ops) so pathological
// files bail to partial results instead of hanging. Deterministic (op count, not wall-clock, so results
// are machine-independent). Env-overridable via LYNX_OP_BUDGET; 0 disables.
const OP_BUDGET = process.env.LYNX_OP_BUDGET !== undefined ? +process.env.LYNX_OP_BUDGET : 2000000;

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

module.exports = { OP_BUDGET, collectReturns };
