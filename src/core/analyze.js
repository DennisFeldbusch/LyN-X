const { OP_BUDGET, TOTAL_BUDGET } = require("./shared");

module.exports = {

/**
 * Create all combinations of concatenating elements from left and right arrays
 * Limits results to maxCombos to avoid explosion
 *
 * Enhancement: Prioritize concrete values over placeholders
 * When both left and right have concrete values, those combinations come first.
 */
cartesianConcat(left, right) {
    const result = [];
    const seen = new Set();   // O(1) dedup — replaces result.includes() (was O(max^2): THE corpus hot path)
    const max = this.maxCombos || 8000;

    if (!left || left.length === 0) left = [""];
    if (!right || right.length === 0) right = [""];
    // Over budget: skip the product (some resolvers loop cartesianConcat via reduce, with no resolver
    // entry between calls to re-check), returning a truncated LHS so pathological files bail here too.
    if (OP_BUDGET && this._ops > OP_BUDGET) { this._budgetHit = true; return left.slice(0, max); }

    // Helper to detect placeholder values
    const isPlaceholder = (val) => typeof val === "string" && (val.startsWith("{VAR:") || val.startsWith("{CALL:"));
    const add = (l, r) => {
        // Charge the work budget PER COMBINATION considered — cartesian growth is the real per-file
        // cost, and the resolvers only check this._ops at their entries (too coarse to catch it here),
        // so counting resolver calls alone let obfuscated bundles run for minutes. Now they bail.
        this._ops = (this._ops || 0) + 1;
        const combined = String(l || "") + String(r || "");
        if (!seen.has(combined)) { seen.add(combined); result.push(combined); }
    };

    // Categorize values
    const leftConcrete = left.filter(v => !isPlaceholder(v));
    const rightConcrete = right.filter(v => !isPlaceholder(v));

    // Priority 1: If both sides have concrete values, combine those first
    if (leftConcrete.length > 0 && rightConcrete.length > 0) {
        for (let l of leftConcrete) {
            if (result.length >= max) break;
            for (let r of rightConcrete) {
                if (result.length >= max) break;
                add(l, r);
            }
        }
    }

    // Priority 2: Full cartesian product for remaining combinations
    if (result.length < max) {
        for (let l of left) {
            if (result.length >= max) break;
            for (let r of right) {
                if (result.length >= max) break;
                add(l, r);
            }
        }
    }

    return result.slice(0, max);
}
,

recordResolvedSinkValues(entry, overrides) {
    const { node, sinkInfo, scope } = entry;
    
    // Skip event handler marker entries - their sinks are already extracted via walk()
    if (sinkInfo && sinkInfo.isEventHandler) {
        return;
    }

    // Whole-file ceiling reached: stop resolving further sinks (partial file result).
    if (TOTAL_BUDGET && (this._totalOps || 0) > TOTAL_BUDGET) { this._budgetHit = true; return; }
    // Per-sink budget: reset the op counter so this sink gets a FULL budget regardless of how much
    // earlier (possibly deep/explosive) sinks consumed — a shallow sink after a deep one still resolves.
    this._ops = 0;

    const arg = this.getSinkArgumentNode(node, sinkInfo, scope, node.start || 0);
    const pos = node.start || 0;
    const runtimeEnv = this.getRuntimeEnvForNodeChain(node);
    const values = this.resolveExpression(arg, scope, pos, overrides || new Map(), runtimeEnv);
    this._totalOps = (this._totalOps || 0) + (this._ops || 0);   // accumulate toward the whole-file ceiling
    values.forEach(val => {
        if (!val) return;
        
        // Filter out excluded URLs
        if (this.isExcludedUrl(val)) {
            return;
        }
        
        // Filter out excluded call results  
        if (val.startsWith("{EXCLUDED_CALL:")) {
            return;
        }
        
        const loc = node.loc && node.loc.start ? node.loc.start : null;
        const line = loc ? loc.line : 0;
        const col = loc ? loc.column + 1 : 0;                 // 1-based char position of the sink
        this.results.add(`${line}|${col}|${sinkInfo.name}|${val}`);
    });
}
,

isExcludedUrl(url) {
    // Check against excluded URL patterns
    const EXCLUDED_PATTERNS = [
        /^blob:\/\/$/i,
        /^null$/i,
        /^undefined$/i,
    ];
    
    for (const pattern of EXCLUDED_PATTERNS) {
        if (pattern.test(url)) {
            return true;
        }
    }
    return false;
}
,

getSortedResultRows() {
    const rows = [...this.results]
        .map(entry => {
            const parts = entry.split("|");
            // format: line|col|sink|url  (url may itself contain "|", so rejoin the remainder)
            return { line: Number(parts[0]), col: Number(parts[1]), sink: parts[2], url: parts.slice(3).join("|") };
        })
        .sort((a, b) => a.line - b.line || a.col - b.col || a.sink.localeCompare(b.sink) || a.url.localeCompare(b.url));
    
    // Fallback URL substitution is disabled for now - showing unresolved URLs is more informative
    // than substituting them with potentially wrong extracted URLs
    return this.deduplicateFinalResults(rows);
}
,

deduplicateFinalResults(rows) {
    // Build a map of base URLs (without query params) that exist
    const baseUrlExists = new Map(); // key: normalized url key, value: index of first occurrence
    
    rows.forEach((row, idx) => {
        if (typeof row.url !== "string") return;
        
        // Don't deduplicate {URL_CALL:...} results - these are important indicators
        if (row.url.startsWith("{URL_CALL:")) {
            baseUrlExists.set(`${row.line}|${row.sink}|URL_RESULT`, idx);
            return;
        }
        
        const qIndex = row.url.indexOf("?");
        if (qIndex > -1) {
            const base = row.url.substring(0, qIndex);
            const key = `${row.line}|${row.sink}|${base}`;
            if (!baseUrlExists.has(key)) {
                baseUrlExists.set(key, idx);
            }
        } else {
            // Store base URLs too
            const key = `${row.line}|${row.sink}|${row.url}`;
            if (!baseUrlExists.has(key)) {
                baseUrlExists.set(key, idx);
            }
        }
    });
    
    // Filter out query variants where the base exists
    return rows.filter((row, idx) => {
        if (typeof row.url !== "string") return true;
        
        // Keep {URL_CALL:...} results
        if (row.url.startsWith("{URL_CALL:")) {
            return true;
        }
        
        const qIndex = row.url.indexOf("?");
        if (qIndex > -1 && row.url.substring(qIndex).match(/^\?\{VAR:/)) {
            const base = row.url.substring(0, qIndex);
            const baseKey = `${row.line}|${row.sink}|${base}`;
            // Remove if base URL exists (keep only the base)
            return !baseUrlExists.has(baseKey);
        }
        return true;
    });
}
,

analyze(options = {}) {
    const { printTable = true } = options;
    if (printTable) {
        console.log(`\n${"LINE".padEnd(6)} | SINK | URL`);
        console.log("-".repeat(100));
    }
    this.index();

    const sinksByFunction = this.getSinksByFunction();
    const callsByFunction = this.getCallsByFunction();

    this.resolveFunctionCallsInterprocedurally(this.functionCalls, sinksByFunction, callsByFunction);

    this.sinks.forEach(entry => this.recordResolvedSinkValues(entry, new Map()));

    const rows = this.getSortedResultRows();

    // Resolve {VAR:name} placeholders from member assignments (e.g., {VAR:l.p} -> "/client/")
    rows.forEach(row => {
        row.url = this.resolveVariablePlaceholders(row.url);
    });

    // Prepend domain to relative URLs if domain is configured
    if (this.domain) {
        rows.forEach(row => {
            row.url = this.prependDomainToUrl(row.url);
        });
    }

    if (printTable) {
        rows.forEach(row => {
            console.log(`${String(row.line).padEnd(6)} | ${row.sink.padEnd(8)} | ${row.url}`);
        });
    }

    return rows;
},

/**
 * Resolve {VAR:name} placeholders in URLs using tracked member assignments.
 * First tries exact match (e.g., {VAR:l.p} -> memberAssignments["l.p"])
 * Then tries property-only match (e.g., {VAR:l.p} -> memberAssignments[".p"])
 * This handles different variable names across builds (l vs b vs a, etc.)
 */
resolveVariablePlaceholders(url) {
    if (!url || typeof url !== "string" || !this.memberAssignments) {
        return url;
    }
    
    let result = url;
    const varPattern = /\{VAR:([^}]+)\}/g;
    let match;
    
    // Find all {VAR:name} patterns in the URL
    while ((match = varPattern.exec(url)) !== null) {
        const varName = match[1];
        let resolved = null;
        
        // This is a POST-HOC, scope-less pass over the final URL string, so it can only safely draw on
        // assignments to program-scope GLOBALS — an outer read may legitimately reference those, but
        // never a function/IIFE-local object (which would be a cross-scope false positive, e.g. an
        // IIFE-internal `config.url` bleeding into an unrelated `foo.url`).
        const globalsOf = (key) => (this.memberAssignments.get(key) || []).filter((a) => a.global);

        // Try exact match first (e.g., "l.p")
        const exact = globalsOf(varName);
        if (exact.length > 0 && exact[exact.length - 1].value) {
            resolved = exact[exact.length - 1].value;
        }

        // If no exact match and this is a member expression (contains a dot),
        // try property-only match (e.g., ".p") to handle variable name variations
        if (!resolved && varName.includes(".")) {
            const propPart = "." + varName.split(".").pop(); // e.g., "l.p" -> ".p"
            const general = globalsOf(propPart);
            if (general.length > 0) {
                // Prefer non-general assignments, fall back to general ones
                const latest = general.find((a) => !a.isGeneral) || general[general.length - 1];
                if (latest && latest.value) {
                    resolved = latest.value;
                }
            }
        }
        
        if (resolved) {
            result = result.replace(`{VAR:${varName}}`, resolved);
        }
    }
    
    return result;
},


/**
 * Prepend domain to relative URLs and resolve {VAR:...} patterns.
 * Handles:
 * - /path -> domain/path (when --domain is set)
 * - {VAR:l.p}path -> (extracted value)path (when l.p found in webpack config)
 * - https://other.com/path -> unchanged (already absolute)
 * - {VAR:unknownVar}path -> unchanged (can't resolve)
 */
prependDomainToUrl(url) {
    if (!url || typeof url !== "string") {
        return url;
    }
    
    // Check if URL has unresolved variables
    const varMatch = url.match(/\{VAR:([^}]+)\}/);
    if (varMatch) {
        const varName = varMatch[1];
        // Try to resolve from extracted webpack config
        if (this.varDomains && this.varDomains.has(varName)) {
            const resolvedValue = this.varDomains.get(varName);
            return url.replace(`{VAR:${varName}}`, resolvedValue);
        }
        // If we have domain and the variable is followed by a path, try to use domain
        if (this.domain && varMatch.index === 0) {
            // URL starts with {VAR:...}, can't reliably use domain
            return url;
        }
        // Can't resolve this variable
        return url;
    }
    
    // Handle protocol-relative URLs (//example.com/path -> https://example.com/path)
    if (/^\/\//.test(url)) {
        return "https:" + url;
    }
    
    // Skip absolute URLs (with protocol)
    if (/^https?:\/\//.test(url)) {
        return url;
    }
    
    // Skip data: and other special URLs
    if (/^[a-z]+:/.test(url)) {
        return url;
    }
    
    // Prepend domain to relative URLs (starting with /)
    if (this.domain && url.startsWith("/")) {
        // Ensure domain doesn't end with / and url starts with /
        const cleanDomain = this.domain.endsWith("/") ? this.domain.slice(0, -1) : this.domain;
        return cleanDomain + url;
    }
    
    return url;
},

};
