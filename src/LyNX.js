const acorn = require("acorn");
const fs = require("fs");

const indexing = require("./core/indexing");
const runtime = require("./core/runtime");
const callgraph = require("./core/callgraph");
const resolve = require("./core/resolve");
const analyze = require("./core/analyze");

class LyNX {
    constructor(input) {
        // Accept a file path (string) or in-memory source ({ code }) — the latter is used for
        // the concatenated HTML script bundle, so the analysis flow itself is untouched.
        this.code = typeof input === "string" ? fs.readFileSync(input, "utf8") : input.code;
        this.ast = this.parseCode(this.code);
        this.results = new Set();
        this.maxCombos = 8000;
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

Object.assign(
    LyNX.prototype,
    indexing,
    runtime,
    callgraph,
    resolve,
    analyze
);

module.exports = LyNX;
