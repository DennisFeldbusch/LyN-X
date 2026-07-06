const acorn = require("acorn");
const fs = require("fs");

const indexing = require("./core/indexing");
const runtime = require("./core/runtime");
const callgraph = require("./core/callgraph");
const resolve = require("./core/resolve");
const analyze = require("./core/analyze");

class LyNX {
    constructor(filePath) {
        this.code = fs.readFileSync(filePath, "utf8");
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
        
        // Extract all URL-like string literals from the code for fallback resolution
        this.urlLiterals = this.extractUrlLiterals();
        
        // Auto-extract webpack runtime configuration from minified code
        this.extractWebpackConfig();
    }

    extractUrlLiterals() {
        const urls = new Set();
        
        // Filesystem paths that are NOT web URLs
        const NOT_WEB_PATHS = [
            /^\/dev\//,
            /^\/home\//,
            /^\/tmp\//,
            /^\/proc\//,
            /^\/var\//,
            /^\/etc\//,
            /^\/usr\//,
            /^\/bin\//,
            /^\/sbin\//,
            /^\/lib\//,
            /^\/sys\//,
        ];
        
        const walk = (node) => {
            if (!node || typeof node !== "object") return;
            
            // Look for string literals that are likely URLs or paths
            if (node.type === "Literal" && typeof node.value === "string") {
                const val = node.value;
                
                // Check if it's a filesystem path (not a web URL)
                const isFilesystemPath = NOT_WEB_PATHS.some(pattern => pattern.test(val));
                if (isFilesystemPath) {
                    // Skip filesystem paths
                } 
                // Paths starting with / that are likely web resources
                else if (val.startsWith("/") && val.length > 2 && !val.includes("(") && !val.includes(")")) {
                    urls.add(val);
                }
                // Full URLs (http/https)
                else if (/^https?:\/\/[\w\-._~:/?#[\]@!$&'()*+,;=%]+$/.test(val)) {
                    urls.add(val);
                }
                // Protocol-relative URLs
                else if (/^\/\/[\w\-._~:/?#[\]@!$&'()*+,;=%]+$/.test(val)) {
                    urls.add(val);
                }
                // UUIDs (might be used in URLs)
                else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)) {
                    urls.add(val);
                }
            }
            
            // Recurse into all properties
            for (const key in node) {
                if (key === "parent" || key === "loc" || key === "range") continue;
                const child = node[key];
                if (Array.isArray(child)) child.forEach(c => walk(c));
                else if (typeof child === "object") walk(child);
            }
        };
        
        walk(this.ast);
        return urls;
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
