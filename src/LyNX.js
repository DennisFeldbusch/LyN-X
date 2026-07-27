const acorn = require("acorn");
const fs = require("fs");

const indexing = require("./core/indexing");
const runtime = require("./core/runtime");
const callgraph = require("./core/callgraph");
const resolve = require("./core/resolve");
const analyze = require("./core/analyze");
const { OP_BUDGET, TOTAL_BUDGET, INDEX_BUDGET, MAX_COMBOS } = require("./core/shared");

class LyNX {
    constructor(input) {
        // Accept a file path (string) or in-memory source ({ code }) — the latter is used for
        // the concatenated HTML script bundle, so the analysis flow itself is untouched.
        this.code = typeof input === "string" ? fs.readFileSync(input, "utf8") : input.code;
        this.ast = this.parseCode(this.code);
        this.results = new Set();
        // RESEARCH-ONLY construction-arity tracking (env LYNX_TRACK_ARITY=1; off by default so it never runs
        // in the shipped tool). When on, _arity maps each built string -> how many source fragments were
        // concatenated to form it (a leaf literal/placeholder = 1, `a+b` = arity(a)+arity(b)); exposed as an
        // `arity` field on --json rows. Captures construction depth EVEN when everything resolves to literals
        // (which the final string can't reveal) — motivating a reconstruction-capable tool.
        this.trackArity = process.env.LYNX_TRACK_ARITY === "1";
        this._arity = this.trackArity ? new Map() : null;
        this.maxCombos = MAX_COMBOS;
        // Per-run work budgets (see core/shared.js). Instance-level so a caller (e.g. the CLI's
        // --op-budget/--index-budget flags) can raise or disable them per file; default to the shared
        // env-aware constants. opBudget = per-sink resolver cap; totalBudget = whole-file resolver cap;
        // indexBudget = AST-node-visit cap for the indexing walk.
        this.opBudget = OP_BUDGET;
        this.totalBudget = TOTAL_BUDGET;
        this.indexBudget = INDEX_BUDGET;
        this.scopeId = 0;
        this.scopeMap = new WeakMap();
        this.fnScopeMap = new WeakMap();
        this.parentMap = new WeakMap();
        this.methodDefs = new Map();
        this.memberDefs = new Map();
        this.functionCalls = [];
        this.elementKinds = new Map();
        this.elementUrls = new Map();
        this.sinks = [];
        this.runtimeEnvCache = new WeakMap();
        this.iifeAliases = new Map(); // Maps IIFE param names to global identifiers (e.g., i -> "document")
        this.resolvingFunctionReturns = new Set();
        this.resolvingIdentifiers = new Set();
        this.domain = null; // Base domain to prepend to relative URLs (set by CLI or programmatically)
        this.varDomains = new Map(); // Map of variable names to their resolved domain values
        this.memberAssignments = new Map(); // Track literal assignments like l.p = "/client/"
        
        // Auto-extract webpack runtime configuration from minified code
        this.extractWebpackConfig();
    }

    parseCode(code) {
        const options = { ecmaVersion: "latest", locations: true };
        try {
            return acorn.parse(code, options);
        } catch (err) {
            if (err && err.message && err.message.includes("sourceType: module")) {
                return acorn.parse(code, { ...options, sourceType: "module" });
            }
            throw err;
        }
    }

    /**
     * Extract webpack runtime configuration from minified code.
     * Looks for patterns like:
     *   l.p = "/path/"
     *   __webpack_require__.p = "/path/"
     *   l.u = function that builds chunk names
     * This helps resolve {VAR:l.p} patterns automatically.
     */
    extractWebpackConfig() {
        // Pattern 1: l.p="/path/" or similar variable assignments
        const pathPattern = /([a-z])\.p\s*=\s*"([^"]*)"/g;
        let match;
        while ((match = pathPattern.exec(this.code)) !== null) {
            const varName = match[1];
            const pathValue = match[2];
            if (pathValue) {
                this.varDomains.set(`${varName}.p`, pathValue);
            }
        }

        // Pattern 2: __webpack_require__.p="path/"
        const webpackPattern = /__webpack_require__\.p\s*=\s*"([^"]*)"/g;
        while ((match = webpackPattern.exec(this.code)) !== null) {
            const pathValue = match[1];
            if (pathValue) {
                this.varDomains.set("__webpack_require__.p", pathValue);
            }
        }

        // Pattern 3: Common variable initializations for other patterns
        // l={p:"/path/", ...} or similar
        const objPattern = /([a-z])\s*=\s*\{p:\s*"([^"]*)"/g;
        while ((match = objPattern.exec(this.code)) !== null) {
            const varName = match[1];
            const pathValue = match[2];
            if (pathValue) {
                this.varDomains.set(`${varName}.p`, pathValue);
            }
        }
    }

}

// The analyzer's methods are composed by mixing five core modules onto the prototype. This is order-
// sensitive: if two modules export the same method name, the LATER one silently wins (e.g. analyze's
// cartesianConcat is meant to override any earlier definition). A silent collision is otherwise a
// debugging trap, so assert that the only overrides are intentional and surface any accidental ones.
const MIXINS = { indexing, runtime, callgraph, resolve, analyze };
const INTENTIONAL_OVERRIDES = new Set([]); // add "name" here if a later module is meant to shadow an earlier one
(function assertNoMixinCollisions() {
    const owner = new Map();
    for (const [modName, mod] of Object.entries(MIXINS)) {
        for (const key of Object.keys(mod)) {
            if (owner.has(key) && !INTENTIONAL_OVERRIDES.has(key)) {
                console.warn(`[LyNX] mixin collision: "${key}" defined in both ${owner.get(key)} and ${modName} ` +
                    `— ${modName} wins. Rename one, or add "${key}" to INTENTIONAL_OVERRIDES.`);
            }
            owner.set(key, modName);
        }
    }
})();

Object.assign(
    LyNX.prototype,
    indexing,
    runtime,
    callgraph,
    resolve,
    analyze
);

module.exports = LyNX;
