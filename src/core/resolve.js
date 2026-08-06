// Debug flag for tracing variable resolution
const DEBUG_VAR = process.env.DEBUG_VAR === '1';

// The per-sink resolver budget is this.opBudget (set from core/shared.js in the LyNX ctor, CLI-overridable);
// collectReturns is shared with runtime.js. LEN_CHARGE_FLOOR gates the length surcharge in deduplicateAndCap.
const { collectReturns, LEN_CHARGE_FLOOR, ARITY_CAP } = require("./shared");

// Known functions that return URLs or URL-like values
const URL_RETURNING_FUNCTIONS = {
    'buildUri': true,
    'getUri': true,
    'createSharedWorkerV2BundleUrl': true,
    'createSharedWorkerBundleUrl': true,
    'createSharedWorkerV2BundleUrlExperimental': true,
    'createSharedWorkerV4BundleUrl': true,
    'toString': true,
};

// Functions that should be ignored in URL sinks (serialization, logging, etc.)
const EXCLUDED_SINK_FUNCTIONS = {
    'JSON.stringify': true,
    'console.log': true,
    'console.error': true,
    'console.warn': true,
    'console.info': true,
};

// Pattern: if URL looks like 'blob://', it's likely a test pattern, not a real URL
const EXCLUDED_URL_PATTERNS = [
    /^blob:\/\/$/i,
    /^null$/i,
    /^undefined$/i,
];

module.exports = {

// Dedupe a value list and cap it at this.maxCombos — the standard terminator for expression fan-out
// (concatenations/conditionals). Used everywhere a resolver returns a bounded set of candidate strings.
// Charges the op-budget by INPUT SIZE: building a Set over N strings is O(N) hashing/compares, and that
// string-dedup is the interproc hot path (a StringEqual-dominated profile). Counting only resolver-call
// entries undercounted it by orders of magnitude, so one argument resolution could run for ~40s under the
// per-sink ceiling before bailing. Charging per element makes the budget catch data-volume blowups.
deduplicateAndCap(values) {
    if (!values || !values.length) return [];
    // Charge by data volume: count PLUS a length surcharge for long strings, since building the Set is
    // O(sum of lengths) of hashing/StringEqual — the 894KB-bundle hot path was thousands of ~KB strings
    // deduped here, which a flat per-element charge undercounted. Below LEN_CHARGE_FLOOR every value costs
    // 1 (normal short URLs unaffected). Once the budget is spent, skip the Set entirely and return a plain
    // truncation — the expensive dedup is exactly what we must not do past budget.
    let charge = values.length;
    for (const v of values) if (typeof v === "string" && v.length > LEN_CHARGE_FLOOR) charge += v.length >> 6;
    this._ops = (this._ops || 0) + charge;
    if (this.opBudget && this._ops > this.opBudget) { this._budgetHit = true; return values.slice(0, this.maxCombos); }
    return [...new Set(values)].slice(0, this.maxCombos);
},

/**
 * Build an enhanced variable chain by tracing assignments
 * e.g., t = r.currentScript -> builds "r.currentScript"
 * and potentially "window.document.currentScript" if r can also be traced
 * Limits to maxDepth to avoid infinite recursion
 */
buildVariableChain(name, scope, pos, maxDepth = 2, visited = new Set()) {
    if (maxDepth <= 0 || visited.has(name)) {
        return name;
    }
    visited.add(name);
    
    const found = this.findLatestDef(scope, name, pos);
    if (!found || !found.def || !found.def.node) {
        return name;
    }
    
    const node = found.def.node;
    
    // If assigned to a MemberExpression like r.currentScript
    if (node.type === "MemberExpression") {
        const baseChain = this.buildVariableChain(this.getName(node.object), found.scope, pos, maxDepth - 1, visited);
        const prop = node.property.type === "Identifier" ? node.property.name : String(node.property.value || "");
        return `${baseChain}.${prop}`;
    }
    
    // If assigned to an Identifier, recurse
    if (node.type === "Identifier") {
        return this.buildVariableChain(node.name, found.scope, pos, maxDepth - 1, visited);
    }
    
    // If it's a Literal (string or number), return as-is
    if (node.type === "Literal") {
        return String(node.value);
    }
    
    // Otherwise return the original name
    return name;
}
,

resolveIdentifier(name, scope, pos, overrides, runtimeEnv) {
    const scopeId = scope && typeof scope.id !== "undefined" ? scope.id : "global";
    const guardKey = `${scopeId}|${name}|${pos || 0}`;
    if (!this.resolvingIdentifiers) this.resolvingIdentifiers = new Set();
    if (this.resolvingIdentifiers.has(guardKey)) {
        if (DEBUG_VAR) console.error(`[RESOLVE] CYCLE: ${name} (scope ${scopeId})`);
        return [`{VAR:${name}}`];
    }
    this.resolvingIdentifiers.add(guardKey);
    try {
    // CRITICAL: Check overrides FIRST, before any other resolution
    // This ensures function parameter substitution always takes precedence
    if (overrides && overrides.has(name)) {
        const overrideValues = overrides.get(name);
        if (DEBUG_VAR) console.error(`[RESOLVE] OVERRIDE: ${name} = ${overrideValues.join(", ")}`);
        return overrideValues;
    }
    
    // Check if this is a member assignment like l.p that was tracked during indexing
    const memberAssignmentValues = this.resolveMemberAssignment(name, scope, pos, overrides, runtimeEnv);
    if (memberAssignmentValues && memberAssignmentValues.length > 0) {
        if (DEBUG_VAR) console.error(`[RESOLVE] MEMBER_ASSIGN: ${name} = ${memberAssignmentValues.join(", ")}`);
        return memberAssignmentValues;
    }
    
    if (scope && scope.paramNames && scope.paramNames.has(name)) {
        // Params are substituted via overrides (checked above); an unbound one is {VAR:name} — UNLESS the
        // runtime env bound it (an arr.forEach(u => ...) / .map element param, or a param reassigned in the
        // body), in which case fall through to the runtimeEnv block below to use those values.
        if (!(runtimeEnv && runtimeEnv.values.has(name))) {
            if (DEBUG_VAR) console.error(`[RESOLVE] PARAM: ${name} (scope ${scopeId})`);
            return [`{VAR:${name}}`];
        }
    }
    if (runtimeEnv && runtimeEnv.values.has(name)) {
        const vals = [...runtimeEnv.values.get(name)];
        const nonEmpty = vals.filter(v => v !== "");
        const concrete = nonEmpty.filter(v => v !== `{VAR:${name}}`);
        // If runtimeEnv values contain unresolved {CALL:} or {FUNC:} placeholders,
        // fall through to findLatestDef which can do proper static resolution
        if (concrete.length > 0 && !concrete.some(v => /\{(CALL|FUNC):/.test(v))) {
            // When overrides are active, skip runtimeEnv values that contain {VAR:X}
            // placeholders for any overridden param — static resolution will substitute them
            if (overrides && overrides.size > 0) {
                const hasOverridableVar = concrete.some(v =>
                    typeof v === "string" && [...overrides.keys()].some(k => v.includes(`{VAR:${k}}`))
                );
                if (hasOverridableVar) {
                    // Fall through to static resolution which will apply overrides
                } else {
                    if (DEBUG_VAR) console.error(`[RESOLVE] RUNTIME_ENV: ${name} = ${concrete.join(", ")}`);
                    return [...new Set(nonEmpty)];
                }
            } else {
                if (DEBUG_VAR) console.error(`[RESOLVE] RUNTIME_ENV: ${name} = ${concrete.join(", ")}`);
                return [...new Set(nonEmpty)];
            }
        }
    }
    const found = this.findLatestDef(scope, name, pos);
    if (!found || !found.def || !found.def.node) {
        if (DEBUG_VAR) console.error(`[RESOLVE] NOT_FOUND: ${name} (scope ${scopeId})`);
        // Build enhanced variable chain instead of just returning {VAR:name}
        const chain = this.buildVariableChain(name, scope, pos);
        return [`{VAR:${chain}}`];
    }
    const node = found.def.node;
    if (DEBUG_VAR) console.error(`[RESOLVE] FOUND: ${name} as ${node.type} (scope ${found.scope.id})`);
    if (node.type === "AssignmentExpression" && node.operator === "+=") {
        const prev = this.findPrevDef(scope, name, found.def.pos);
        const leftVals = prev && prev.def && prev.def.node
            ? this.resolveExpression(prev.def.node, prev.scope, prev.def.pos, overrides, runtimeEnv)
            : [`{VAR:${name}}`];
        const rightVals = this.resolveExpression(node.right, found.scope, node.start || pos, overrides, runtimeEnv);
        return this.cartesianConcat(leftVals, rightVals);
    }
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
        return [`{VAR:${name}}`];
    }
    return this.resolveExpression(node, found.scope, found.def.pos, overrides, runtimeEnv);
    } finally {
        this.resolvingIdentifiers.delete(guardKey);
    }
}
,

resolveMemberAssignment(name, scope, pos, overrides, runtimeEnv) {
    if (!this.memberAssignments || !this.memberAssignments.has(name)) {
        return null;
    }
    const assignments = this.memberAssignments.get(name);
    if (!assignments || assignments.length === 0) {
        return null;
    }
    // Scope filter: only honor an assignment whose base variable binds to the SAME declaration the
    // read's base variable binds to (so an IIFE-internal `s.params.url = …` never resolves an outer
    // read of `s.params.url`). Records without scope metadata are accepted (back-compat).
    const readBase = String(name).split(".")[0];
    const rScopeId = this.bindingScopeId(scope, readBase, pos);
    const compatible = assignments.filter((a) => {
        if (!a.base) return true;
        return this.bindingScopeId(a.scope || scope, a.base, a.pos != null ? a.pos : pos) === rScopeId;
    });
    if (compatible.length === 0) {
        return null;
    }
    const latest = compatible[compatible.length - 1];
    if (latest.value) {
        return [latest.value];
    }
    if (latest.node) {
        return this.resolveExpression(latest.node, latest.scope || scope, latest.pos != null ? latest.pos : pos, overrides, runtimeEnv);
    }
    return null;
}
,

// id of the scope where `base` binds when read from `scope` (null if free/undeclared) — used to
// decide whether a member assignment and a member read touch the SAME object binding.
bindingScopeId(scope, base, pos) {
    const found = this.findLatestDef(scope, base, pos);
    return found ? found.scope.id : null;
}
,


resolveTemplateLiteral(node, scope, pos, overrides, runtimeEnv) {
    const parts = [];
    node.quasis.forEach((q, idx) => {
        parts.push([q.value.cooked || ""]);
        if (node.expressions[idx]) {
            parts.push(this.resolveExpression(node.expressions[idx], scope, pos, overrides, runtimeEnv));
        }
    });
    return parts.reduce((acc, part) => this.cartesianConcat(acc, part), [""]);
}
,

resolveObjectEntriesFromNode(node, scope, pos, overrides, runtimeEnv) {
    if (!node) return [];
    if (node.type === "ObjectExpression") {
        return node.properties
            .filter(prop => prop && prop.key)
            .map(prop => {
                const key = prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value || "");
                return { key, valueNode: prop.value };
            })
            .filter(entry => entry.key);
    }
    if (node.type === "Identifier") {
        const found = this.findLatestDef(scope, node.name, pos);
        if (found && found.def && found.def.node) {
            if (found.def.node.type === "ObjectExpression") {
                return this.resolveObjectEntriesFromNode(found.def.node, found.scope, found.def.pos, overrides, runtimeEnv);
            }
            if (found.def.node.type === "AssignmentExpression" && found.def.node.right) {
                return this.resolveObjectEntriesFromNode(found.def.node.right, found.scope, found.def.pos, overrides, runtimeEnv);
            }
            if (found.def.node.type === "MemberExpression") {
                return this.resolveObjectEntriesFromNode(found.def.node, found.scope, found.def.pos, overrides, runtimeEnv);
            }
        }
    }
    if (node.type === "AssignmentExpression" && node.right) {
        return this.resolveObjectEntriesFromNode(node.right, scope, pos, overrides, runtimeEnv);
    }
    if (node.type === "MemberExpression") {
        const objectInfo = this._findObjectExprNode(node, scope, pos);
        if (objectInfo && objectInfo.objectNode) {
            return this.resolveObjectEntriesFromNode(objectInfo.objectNode, objectInfo.defScope, objectInfo.defPos, overrides, runtimeEnv);
        }
    }
    return [];
}

/**
 * Resolve a non-computed MemberExpression by tracing object to its ObjectExpression definition.
 * Handles nested access like config.api.base by recursively resolving the object chain.
 * Returns resolved values array or null if not resolvable.
 */,

resolveDeepObjectProperty(node, scope, pos, overrides, runtimeEnv) {
    if (!node || node.type !== "MemberExpression" || node.computed) {
        if (DEBUG_VAR && node) console.error(`[DEEP_OBJ] Invalid node for deep property resolution: ${node.type}`);
        return null;
    }
    const propName = node.property && node.property.type === "Identifier" ? node.property.name : null;
    if (!propName) {
        if (DEBUG_VAR) console.error(`[DEEP_OBJ] No property name found`);
        return null;
    }

    if (DEBUG_VAR) console.error(`[DEEP_OBJ] Resolving property: ${propName} on member expression`);
    // Find the ObjectExpression node for the object part
    const objNode = this._findObjectExprNode(node.object, scope, pos);
    if (!objNode) {
        if (DEBUG_VAR) console.error(`[DEEP_OBJ] Could not find object node for property: ${propName}`);
        return null;
    }

    const { objectNode, defScope, defPos } = objNode;
    const entries = this.resolveObjectEntriesFromNode(objectNode, defScope, defPos, overrides, runtimeEnv);
    if (DEBUG_VAR) console.error(`[DEEP_OBJ] Found ${entries.length} entries in object for property: ${propName}`);
    for (const entry of entries) {
        if (entry.key === propName) {
            if (DEBUG_VAR) console.error(`[DEEP_OBJ] Found matching entry for property: ${propName}`);
            const result = this.resolveExpression(entry.valueNode, defScope, defPos, overrides, runtimeEnv);
            if (DEBUG_VAR) console.error(`[DEEP_OBJ] Resolved property ${propName} to: ${typeof result === 'string' ? result.substring(0, 50) : 'object'}`);
            return result;
        }
    }
    if (DEBUG_VAR) console.error(`[DEEP_OBJ] Property not found in object entries: ${propName}`);
    return null;
}

/**
 * Trace an expression back to its ObjectExpression AST node.
 * Handles Identifier (variable lookup) and nested MemberExpression (obj.prop where prop is an object).
 */,

_findObjectExprNode(node, scope, pos) {
    if (!node) {
        if (DEBUG_VAR) console.error(`[OBJECT] No node provided`);
        return null;
    }
    // Depth guard (mirrors resolveExpression): alias/member chains in obfuscated or cyclic code can
    // drive this self-recursion past the JS stack. Degrade to null (unresolved) past the cap.
    this._foenDepth = (this._foenDepth || 0) + 1;
    if (this._foenDepth > 200) { this._foenDepth--; return null; }
    this._ops = (this._ops || 0) + 1;
    if (this.opBudget && this._ops > this.opBudget) { this._budgetHit = true; this._foenDepth--; return null; }   // per-sink budget bail
    try {
    if (node.type === "ObjectExpression") {
        if (DEBUG_VAR) console.error(`[OBJECT] Direct ObjectExpression found`);
        return { objectNode: node, defScope: scope, defPos: pos };
    }
    // A call that RETURNS an object literal: `g.urls = build(opts); g.urls.events` — trace into the callee's
    // return so member access reaches the returned object's properties (and their `||`/`?:` defaults). Bounded
    // by the _foenDepth cap above and the op-budget; falls through to null if the return isn't object-shaped.
    if (node.type === "CallExpression") {
        const fnNode = this.resolveCalledFunctionNode({ node, scope });
        if (!fnNode) return null;
        // The returned object literal is the SAME AST node for every call site (param bindings are applied
        // later, when property values are resolved), so memoize per function: collectReturns + the recursive
        // trace run at most ONCE per function, bounding total work to O(file) instead of O(call-sites × body).
        // The in-progress set cuts cyclic returns (f -> g() -> f()) that the depth cap alone would let re-walk.
        if (!this._fnRetObjMemo) { this._fnRetObjMemo = new Map(); this._fnRetObjInProgress = new Set(); }
        if (this._fnRetObjMemo.has(fnNode)) return this._fnRetObjMemo.get(fnNode);
        if (this._fnRetObjInProgress.has(fnNode)) return null;                 // cycle -> unresolved
        this._fnRetObjInProgress.add(fnNode);
        const fnScope = this.fnScopeMap.get(fnNode) || scope;
        // Charge the op-budget for the (otherwise uncharged) collectReturns body walk, proportional to the
        // function's source span (~1 op / 64 chars). With the memo this is paid once per function, but the
        // charge also bounds the un-memoized worst case: a deep/cyclic chain trips _budgetHit and bails.
        this._ops = (this._ops || 0) + 1 + (Math.max(0, (fnNode.end || 0) - (fnNode.start || 0)) >> 6);
        if (this.opBudget && this._ops > this.opBudget) { this._budgetHit = true; this._fnRetObjInProgress.delete(fnNode); return null; }
        const returns = [];
        if (fnNode.type === "ArrowFunctionExpression" && fnNode.body && fnNode.body.type !== "BlockStatement") returns.push(fnNode.body);
        else returns.push(...collectReturns(fnNode.body || fnNode));
        let result = null;
        for (const ret of returns) {
            if (this._budgetHit) break;
            const oi = this._findObjectExprNode(ret, fnScope, ret && ret.start ? ret.start : pos);
            if (oi) { result = oi; break; }
        }
        this._fnRetObjInProgress.delete(fnNode);
        if (!this._budgetHit) this._fnRetObjMemo.set(fnNode, result);          // don't cache a budget-bail null (retryable per-sink)
        return result;
    }
    if (node.type === "ThisExpression") {
        if (DEBUG_VAR) console.error(`[OBJECT] ThisExpression - looking for class definition`);
        // For 'this', we'd need to find the class/constructor context
        // For now, return null - will handle this pattern in future improvements
        return null;
    }
    if (node.type === "Identifier") {
        if (DEBUG_VAR) console.error(`[OBJECT] Looking up Identifier: ${node.name}`);
        const found = this.findLatestDef(scope, node.name, pos);
        if (!found || !found.def) {
            if (DEBUG_VAR) console.error(`[OBJECT] No definition found for Identifier: ${node.name}`);
            return null;
        }
        
        // If definition is directly an ObjectExpression, return it
        if (found.def.node && found.def.node.type === "ObjectExpression") {
            if (DEBUG_VAR) console.error(`[OBJECT] Found ObjectExpression for Identifier: ${node.name}`);
            return { objectNode: found.def.node, defScope: found.scope, defPos: found.def.pos };
        }
        
        // If definition is an assignment, look at the right-hand side
        if (found.def.node && found.def.node.type === "VariableDeclarator" && found.def.node.init) {
            if (DEBUG_VAR) console.error(`[OBJECT] Found VariableDeclarator for ${node.name}, checking init`);
            const initType = found.def.node.init.type;
            if (initType === "ObjectExpression") {
                return { objectNode: found.def.node.init, defScope: found.scope, defPos: found.def.pos };
            }
            if (initType === "Identifier" || initType === "CallExpression" || initType === "MemberExpression") {
                // Recurse: aliased var, a call returning an object, or another object's property.
                return this._findObjectExprNode(found.def.node.init, found.scope, found.def.pos);
            }
        }
        
        // If definition is assignment like "x = {...}", look at the right side
        if (found.def.node && found.def.node.type === "AssignmentExpression" && found.def.node.right) {
            if (DEBUG_VAR) console.error(`[OBJECT] Found AssignmentExpression for ${node.name}, checking RHS`);
            const rhsType = found.def.node.right.type;
            if (rhsType === "ObjectExpression") {
                return { objectNode: found.def.node.right, defScope: found.scope, defPos: found.def.pos };
            }
            if (rhsType === "Identifier" || rhsType === "CallExpression" || rhsType === "MemberExpression") {
                return this._findObjectExprNode(found.def.node.right, found.scope, found.def.pos);
            }
        }
        
        // The def may be stored as the init/rhs node DIRECTLY (e.g. `const cfg = build(...)` -> def.node is the
        // CallExpression itself, not a VariableDeclarator). Recurse so a call returning an object, or an aliased
        // member, resolves — this closes the 2-level `cfg = build(); cfg.events` case.
        if (found.def.node && (found.def.node.type === "CallExpression" || found.def.node.type === "MemberExpression")) {
            return this._findObjectExprNode(found.def.node, found.scope, found.def.pos);
        }
        if (DEBUG_VAR) console.error(`[OBJECT] Definition node type not ObjectExpression: ${found.def.node ? found.def.node.type : 'unknown'}`);
        return null;
    }
    if (node.type === "MemberExpression" && !node.computed) {
        const propName = node.property && node.property.type === "Identifier" ? node.property.name : null;
        if (!propName) {
            if (DEBUG_VAR) console.error(`[OBJECT] MemberExpression with no property name`);
            return null;
        }
        if (DEBUG_VAR) console.error(`[OBJECT] Looking up MemberExpression property: ${propName}`);
        const parent = this._findObjectExprNode(node.object, scope, pos);
        if (!parent) {
            if (DEBUG_VAR) console.error(`[OBJECT] Parent object not found for property: ${propName}`);
            return null;
        }
        const entries = this.resolveObjectEntriesFromNode(parent.objectNode, parent.defScope, parent.defPos);
        for (const entry of entries) {
            if (entry.key === propName && entry.valueNode) {
                if (entry.valueNode.type === "ObjectExpression") {
                    if (DEBUG_VAR) console.error(`[OBJECT] Found ObjectExpression property: ${propName}`);
                    return { objectNode: entry.valueNode, defScope: parent.defScope, defPos: parent.defPos };
                }
                const resolved = this._findObjectExprNode(entry.valueNode, parent.defScope, parent.defPos);
                if (resolved) {
                    if (DEBUG_VAR) console.error(`[OBJECT] Followed aliased property: ${propName}`);
                    return resolved;
                }
            }
        }
        if (DEBUG_VAR) console.error(`[OBJECT] No ObjectExpression property found: ${propName}`);
        return null;
    }
    if (DEBUG_VAR) console.error(`[OBJECT] Node type not handled: ${node.type}`);
    return null;
    } finally { this._foenDepth--; }
}
,

resolveMemberFromObjectMap(node, scope, pos, overrides, runtimeEnv) {
    if (!node || node.type !== "MemberExpression" || !node.computed) {
        if (DEBUG_VAR && node) console.error(`[OBJ_MAP] Invalid node for object map: ${node.type}, computed=${node && node.computed}`);
        return null;
    }
    let entries = this.resolveObjectEntriesFromNode(node.object, scope, pos, overrides, runtimeEnv);
    // The initializer literal is not the whole object: also merge entries the binding accrues via obj[k]=v
    // assignment sequences, Object.assign, and object spread, so an imperatively-built or merged map becomes
    // enumerable for the widening below. Sound (each entry is a possible endpoint); contained to this site.
    const built = this.collectBuilderEntries(node.object, scope, pos, overrides, runtimeEnv);
    if (built.length) entries = entries.concat(built);
    if (!entries.length) {
        if (DEBUG_VAR) console.error(`[OBJ_MAP] No entries found in object`);
        return null;
    }
    if (DEBUG_VAR) console.error(`[OBJ_MAP] Found ${entries.length} entries in object`);
    const keyValues = this.resolveExpression(node.property, scope, pos, overrides, runtimeEnv);
    if (DEBUG_VAR) console.error(`[OBJ_MAP] Property resolved to keys: ${JSON.stringify(keyValues.map(k => typeof k === 'string' ? k.substring(0, 40) : k))}`);
    const resolved = [];
    keyValues.forEach(key => {
        entries.forEach(entry => {
            if (entry.key === key) {
                if (DEBUG_VAR) console.error(`[OBJ_MAP] Matched key: ${key}`);
                this.resolveExpression(entry.valueNode, scope, pos, overrides, runtimeEnv)
                    .forEach(val => resolved.push(val));
            }
        });
    });
    // Opaque key (any {VAR:}/{CALL:}/{URL_CALL:} placeholder) that matched no entry -> widen to the union of
    // ALL values. Each is a possible endpoint (sound over-approximation); was previously {VAR:}-only, which
    // missed obj[fn()] / obj[cond?a:b] etc.
    if (resolved.length === 0 && keyValues.some(val => typeof val === "string" && /^\{[A-Z_]+:/.test(val))) {
        if (DEBUG_VAR) console.error(`[OBJ_MAP] Key is unresolved, returning all values`);
        entries.forEach(entry => {
            this.resolveExpression(entry.valueNode, scope, pos, overrides, runtimeEnv)
                .forEach(val => resolved.push(val));
        });
    }
    // If still no results and we have partial keys, try fuzzy matching for common patterns
    if (resolved.length === 0 && keyValues.length > 0) {
        const keyStr = keyValues[0];
        if (typeof keyStr === "string" && keyStr.length > 0) {
            if (DEBUG_VAR) console.error(`[OBJ_MAP] Trying fuzzy match for key: ${keyStr.substring(0, 40)}`);
            // Try to match entries where the key is a substring or contains the key
            entries.forEach(entry => {
                if (entry.key.includes(keyStr) || keyStr.includes(entry.key)) {
                    this.resolveExpression(entry.valueNode, scope, pos, overrides, runtimeEnv)
                        .forEach(val => resolved.push(val));
                }
            });
        }
    }
    if (DEBUG_VAR) console.error(`[OBJ_MAP] Final result: ${resolved.length} values resolved`);
    return resolved.length ? [...new Set(resolved)] : null;
}
,

// Gather {key, valueNode} entries a map binding accrues BEYOND its initializer literal — the flow-merged
// object model. Three sources, all sound for literal contributors:
//   (1) obj[k]=v / obj.k=v assignment sequences  (indexed in this.memberAssignments; computed-dynamic writes
//       are recorded under the bare "obj." key, see indexing.js)
//   (2) Object.assign(tgt, {..}, {..})           (merge each object-literal arg)
//   (3) object spread  {...a, ...b, k:v}         (merge the spread arguments' entries)
// Only the identifier-object case is handled (the overwhelmingly common shape); returns [] otherwise.
collectBuilderEntries(objNode, scope, pos, overrides, runtimeEnv, _depth) {
    if (!objNode || (_depth || 0) > 4) return [];
    const out = [];
    // (1) imperative property assignments, scope-filtered like resolveMemberAssignment
    if (objNode.type === "Identifier" && this.memberAssignments) {
        const name = objNode.name;
        const rScopeId = this.bindingScopeId(scope, name, pos);
        let synth = 0;
        for (const [key, recs] of this.memberAssignments) {
            if (key.length < name.length + 1 || key.slice(0, name.length + 1) !== name + ".") continue;
            const prop = key.slice(name.length + 1);       // "" for computed-dynamic obj[expr]=v
            for (const rec of recs) {
                if (rec.base && this.bindingScopeId(rec.scope || scope, rec.base, rec.pos != null ? rec.pos : pos) !== rScopeId) continue;
                const valueNode = rec.node || (rec.value != null ? { type: "Literal", value: rec.value } : null);
                if (!valueNode) continue;
                out.push({ key: prop || (" b" + synth++), valueNode });
            }
        }
    }
    // (2)+(3) trace the binding's initializer to Object.assign / spread and merge contributors
    let valNode = objNode;
    if (objNode.type === "Identifier") {
        const found = this.findLatestDef(scope, objNode.name, pos);
        const dn = found && found.def && found.def.node;
        if (dn) valNode = dn.type === "VariableDeclarator" ? dn.init
            : dn.type === "AssignmentExpression" ? dn.right : dn;
    }
    if (valNode && valNode.type === "CallExpression" && valNode.callee &&
        valNode.callee.type === "MemberExpression" && this.getName(valNode.callee) === "Object.assign") {
        for (const arg of valNode.arguments || []) {
            this.resolveObjectEntriesFromNode(arg, scope, pos, overrides, runtimeEnv).forEach(e => out.push(e));
            this.collectBuilderEntries(arg, scope, pos, overrides, runtimeEnv, (_depth || 0) + 1).forEach(e => out.push(e));
        }
    }
    if (valNode && valNode.type === "ObjectExpression") {
        for (const prop of valNode.properties || []) {
            if (prop && prop.type === "SpreadElement" && prop.argument) {
                this.resolveObjectEntriesFromNode(prop.argument, scope, pos, overrides, runtimeEnv).forEach(e => out.push(e));
                this.collectBuilderEntries(prop.argument, scope, pos, overrides, runtimeEnv, (_depth || 0) + 1).forEach(e => out.push(e));
            }
        }
    }
    return out;
}
,

resolveArrayElementsFromNode(node, scope, pos, overrides, runtimeEnv) {
    if (!node) return [];
    if (node.type === "ArrayExpression") {
        return (node.elements || []).filter(Boolean).map(el => this.resolveExpression(el, scope, pos, overrides, runtimeEnv));
    }
    if (node.type === "Identifier") {
        const found = this.findLatestDef(scope, node.name, pos);
        if (found && found.def && found.def.node && found.def.node.type === "ArrayExpression") {
            return this.resolveArrayElementsFromNode(found.def.node, found.scope, found.def.pos, overrides, runtimeEnv);
        }
    }
    return [];
}
,

// Computed array/list access `arr[i]` where `arr` is (or resolves to) an array literal. A concrete index
// yields that element; an OPAQUE index widens to the BOUNDED union of every entry. This is a sound
// over-approximation for URL extraction: each entry is an endpoint the script may load, so we emit the whole
// set rather than a bare {VAR:i} placeholder — recovering manifest/chunk-list/route-table lookups that regex
// greps as literals but backward taint otherwise loses at the indexing step. (Object-literal maps `obj[k]`
// are handled by resolveMemberFromObjectMap, which already widens on an unresolved key.) Bounded by maxCombos
// (capped) so a large data array can't explode output; non-URL entries are dropped later at emission.
resolveComputedArrayWiden(node, scope, pos, overrides, runtimeEnv) {
    if (!node || node.type !== "MemberExpression" || !node.computed) return null;
    const elemLists = this.resolveArrayElementsFromNode(node.object, scope, pos, overrides, runtimeEnv);
    if (!elemLists.length) return null;                        // not an array literal (objects handled elsewhere)
    // Concrete integer index -> that element only (precise, no widening).
    const idxVals = this.resolveExpression(node.property, scope, pos, overrides, runtimeEnv);
    const concrete = [];
    for (const iv of idxVals) {
        const n = typeof iv === "number" ? iv
            : (typeof iv === "string" && /^\d+$/.test(iv.trim()) ? parseInt(iv, 10) : null);
        if (n != null && n >= 0 && n < elemLists.length && elemLists[n]) elemLists[n].forEach(v => concrete.push(v));
    }
    if (concrete.length) return this.deduplicateAndCap(concrete);
    // Opaque index -> bounded widening over ALL entries.
    const cap = Math.min(this.maxCombos || 8000, 512);
    const out = [];
    for (const evs of elemLists) {
        for (const v of evs) { out.push(v); if (out.length >= cap) break; }
        if (out.length >= cap) break;
    }
    return out.length ? this.deduplicateAndCap(out) : null;
}
,

getObjectPropertyValueNode(node, propertyName, scope, pos) {
    if (!node || !propertyName) return null;
    const objectInfo = this._findObjectExprNode(node, scope, pos);
    if (!objectInfo) return null;
    const entries = this.resolveObjectEntriesFromNode(objectInfo.objectNode, objectInfo.defScope, objectInfo.defPos, new Map(), null);
    const entry = entries.find(candidate => candidate.key === propertyName);
    return entry ? entry.valueNode : null;
}
,

getSinkArgumentNode(node, sinkInfo, scope, pos) {
    if (!sinkInfo || !node) return null;
    if (sinkInfo.urlNode) return sinkInfo.urlNode;

    const arg = node.arguments && node.arguments[sinkInfo.urlArgIndex];
    if (!arg) return null;

    if (sinkInfo.name === "$.ajax") {
        const urlNode = this.getObjectPropertyValueNode(arg, "url", scope, pos);
        if (urlNode) return urlNode;
    }

    return arg;
}
,

buildQueryStrings(entries) {
    if (!entries || entries.length === 0) return [""];
    // Semantic collapse: a maximal RUN of query params with an identical (keys, values) signature is the
    // tool eagerly enumerating a repeated `&k=v` pattern — e.g. N copies of `&lbid=(getAttr()|null)` — whose
    // cartesian product blows up to 2^N genuinely-distinct strings that exact-string dedup can't merge.
    // Repeated identical params add no endpoint structure, so fold each run to ONE entry. Distinct repeated
    // keys (`?id=1&id=2`) have different value signatures and survive.
    if (entries.length > 2) {
        const sig = (e) => JSON.stringify([e.keyValues, e.valueValues]);
        const folded = []; let prev = null;
        for (const e of entries) { const s = sig(e); if (s === prev) continue; prev = s; folded.push(e); }
        entries = folded;
    }
    const cap = this.maxCombos || 8000;
    let combos = [""];
    entries.forEach(entry => {
        if (this._budgetHit) return;
        // Bound the intermediates: pairs = keyValues × valueValues, and next = combos × pairs. A param
        // whose key/value resolved to many candidates makes either explode, and the old code built the
        // FULL product before capping — seconds of wasted string work per sink. Cap both at `cap` (the
        // result is deduped/capped to maxCombos anyway) so a single call stays O(cap), not O(product).
        const pairs = [], pairAr = [];
        for (const k of entry.keyValues) {
            if (pairs.length >= cap) break;
            for (const v of entry.valueValues) {
                if (pairs.length >= cap) break;
                pairs.push(`${k}=${v}`);
                if (this._arity) pairAr.push(this._arity.get(v) || 1);   // this param counts pieces(v)
            }
        }
        const next = [];
        for (const prefix of combos) {
            if (next.length >= cap) break;
            for (let pi = 0; pi < pairs.length; pi++) {
                if (next.length >= cap) break;
                const s = prefix ? `${prefix}&${pairs[pi]}` : pairs[pi];
                if (this._arity) {
                    const a = Math.min(ARITY_CAP, (prefix ? (this._arity.get(prefix) || 1) : 0) + pairAr[pi]);
                    if (a > (this._arity.get(s) || 0)) this._arity.set(s, a);
                }
                next.push(s);
            }
        }
        combos = this.deduplicateAndCap(next);
    });
    return combos.length ? combos : [""];
}

/**
 * Walk an AST subtree looking for computed MemberExpressions like {k:v,...}[paramName].
 * Returns an array of string keys from any ObjectExpression objects found. 
 */,

extractObjectMapKeys(node, paramName) {
    const keys = new Set();
    const walk = (n) => {
        if (!n || typeof n !== "object") return;
        if (n.type === "MemberExpression" && n.computed &&
            n.property && n.property.type === "Identifier" && n.property.name === paramName &&
            n.object && n.object.type === "ObjectExpression") {
            (n.object.properties || []).forEach(prop => {
                if (prop && prop.key) {
                    const key = prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value || "");
                    if (key) keys.add(key);
                }
            });
            return; // don't recurse into the object itself
        }
        for (const k in n) {
            if (k === "parent") continue;
            const child = n[k];
            if (Array.isArray(child)) child.forEach(c => walk(c));
            else walk(child);
        }
    };
    walk(node);
    return [...keys];
}
,

extractConditionalMap(node, paramName) {
    const returns = [];
    if (node && node.type === "ArrowFunctionExpression" && node.body && node.body.type !== "BlockStatement") {
        returns.push(node.body);
    } else {
        returns.push(...collectReturns(node));
    }
    if (returns.length !== 1) return null;
    let current = returns[0];
    const map = new Map();
    while (current && current.type === "ConditionalExpression") {
        const test = current.test;
        if (test && test.type === "BinaryExpression" && (test.operator === "===" || test.operator === "==")) {
            const leftIsParam = test.left.type === "Identifier" && test.left.name === paramName;
            const rightIsParam = test.right.type === "Identifier" && test.right.name === paramName;
            const leftIsLiteral = test.left.type === "Literal";
            const rightIsLiteral = test.right.type === "Literal";
            if (leftIsParam && rightIsLiteral) {
                map.set(String(test.right.value), current.consequent);
                current = current.alternate;
                continue;
            }
            if (rightIsParam && leftIsLiteral) {
                map.set(String(test.left.value), current.consequent);
                current = current.alternate;
                continue;
            }
        }
        break;
    }
    const defaultNode = current && current.type !== "ConditionalExpression" ? current : null;
    return map.size > 0 ? { map, defaultNode } : (defaultNode ? { map, defaultNode } : null);
}
,

resolveFunctionReturn(fnNode, scope, pos, argNodes, runtimeEnv) {
    if (!fnNode) return [""];
    const argSig = (argNodes || [])
        .map(arg => {
            if (!arg) return "null";
            const start = typeof arg.start === "number" ? arg.start : "na";
            return `${arg.type || "unknown"}@${start}`;
        })
        .join(",");
    const fnStart = typeof fnNode.start === "number" ? fnNode.start : "na";
    const guardKey = `${fnStart}|${pos || 0}|${argSig}`;
    // Memoize identical (fn, pos, arg-signature) resolutions: an exponential interprocedural fan-out
    // (f -> g() + g() -> ...) otherwise re-resolves the same call O(2^depth) times. Same key ⟹ same
    // deterministic result, so this is exact (not lossy) and collapses the fan-out to linear.
    if (!this._fnRetMemo) this._fnRetMemo = new Map();
    if (this._fnRetMemo.has(guardKey)) return [...this._fnRetMemo.get(guardKey)];
    if (!this.resolvingFunctionReturns) this.resolvingFunctionReturns = new Set();
    if (this.resolvingFunctionReturns.has(guardKey)) {
        return ["{CALL:recursive}"];
    }
    this.resolvingFunctionReturns.add(guardKey);
    try {
    const fnScope = this.fnScopeMap.get(fnNode) || scope;
    const overrides = new Map();
    const params = fnNode.params || [];
    params.forEach((param, idx) => {
        let paramName = "";
        let defaultNode = null;
        if (param.type === "Identifier") {
            paramName = param.name;
        } else if (param.type === "AssignmentPattern" && param.left && param.left.type === "Identifier") {
            paramName = param.left.name;
            defaultNode = param.right;
        } else {
            return;
        }
        const argNode = argNodes[idx];
        if (!argNode && defaultNode) {
            const values = this.resolveExpression(defaultNode, scope, pos, overrides, runtimeEnv);
            overrides.set(paramName, values);
        } else {
            const values = this.resolveExpression(argNode, scope, pos, overrides, runtimeEnv);
            overrides.set(paramName, values);
        }
    });

    if (params.length === 1) {
        const paramName = params[0].type === "Identifier" ? params[0].name 
            : (params[0].type === "AssignmentPattern" && params[0].left && params[0].left.type === "Identifier" ? params[0].left.name : "");
        const overrideValues = overrides.get(paramName) || [];
        const isPlaceholder = (val) => typeof val === "string" && val.startsWith("{VAR:");
        if (paramName && overrideValues.length === 1 && isPlaceholder(overrideValues[0])) {
            const condInfo = this.extractConditionalMap(fnNode, paramName);
            if (condInfo && (condInfo.map.size > 0 || condInfo.defaultNode)) {
                let expanded = [];
                // Cap growth: a conditional map with many keys (or keys resolving to large sets) would grow
                // `expanded` without bound and re-copy it on every concat (O(n²)); stop once past maxCombos
                // or the budget is spent, so this can't run away.
                condInfo.map.forEach((node, key) => {
                    if (this._budgetHit || expanded.length >= this.maxCombos) return;
                    const localOverrides = new Map(overrides);
                    localOverrides.set(paramName, [String(key)]);
                    expanded = expanded.concat(this.resolveExpression(node, fnScope, pos, localOverrides, runtimeEnv));
                });
                if (condInfo.defaultNode && !this._budgetHit && expanded.length < this.maxCombos) {
                    const objMapKeys = this.extractObjectMapKeys(condInfo.defaultNode, paramName);
                    if (objMapKeys.length > 0) {
                        objMapKeys.forEach(key => {
                            if (this._budgetHit || expanded.length >= this.maxCombos) return;
                            const localOverrides = new Map(overrides);
                            localOverrides.set(paramName, [String(key)]);
                            expanded = expanded.concat(this.resolveExpression(condInfo.defaultNode, fnScope, pos, localOverrides, runtimeEnv));
                        });
                    } else {
                        expanded = expanded.concat(this.resolveExpression(condInfo.defaultNode, fnScope, pos, overrides, runtimeEnv));
                    }
                }
                expanded = expanded.filter(val => val !== "");
                { const _r = expanded.length ? this.deduplicateAndCap(expanded) : [""]; this._fnRetMemo.set(guardKey, _r); return _r; }
            }
        }
    }

    const returns = [];
    if (fnNode && fnNode.type === "ArrowFunctionExpression" && fnNode.body && fnNode.body.type !== "BlockStatement") {
        returns.push(fnNode.body);
    }
    if (!returns.length) returns.push(...collectReturns(fnNode.body || fnNode));

    let results = [];
    returns.forEach(ret => {
        if (this._budgetHit || results.length >= this.maxCombos) return;   // stop accumulating once capped/over budget
        results = results.concat(this.resolveExpression(ret, fnScope, ret && ret.start ? ret.start : pos, overrides, runtimeEnv));
    });
    results = results.filter(val => val !== "");
    { const _r = results.length ? this.deduplicateAndCap(results) : [""]; this._fnRetMemo.set(guardKey, _r); return _r; }
    } finally {
        this.resolvingFunctionReturns.delete(guardKey);
    }
}
,

findMemberDefByPos(name, pos) {
    if (!this.memberDefs.has(name)) return null;
    const defs = this.memberDefs.get(name);
    // Find exact match first, then closest preceding
    const exact = defs.find(d => d.pos === pos);
    if (exact) return exact.node;
    return this.findLatestMemberDef(name, pos);
}
,

getMemberPropertyValue(memberExpr, scope, pos, overrides, runtimeEnv) {
    if (!memberExpr || memberExpr.type !== "MemberExpression") return "";
    return memberExpr.computed
        ? this.resolveExpression(memberExpr.property, scope, pos, overrides, runtimeEnv)[0]
        : this.getName(memberExpr.property);
}
,

/**
 * Resolve array transformation methods: .map(fn), .filter(fn), .reduce(fn, init), .flatMap(fn), etc.
 * Extracts callback results or array elements based on method semantics.
 */
resolveArrayMethod(node, scope, pos, overrides, runtimeEnv) {
    if (!node || !node.callee || node.callee.type !== "MemberExpression") return null;
    const methodName = this.getMemberPropertyValue(node.callee, scope, pos, overrides, runtimeEnv);
    
    // Array transformation methods
    const transformMethods = ["map", "flatMap", "filter", "reduce", "reduceRight", "find", "findIndex"];
    if (!transformMethods.includes(methodName)) return null;
    
    const callbackArg = node.arguments && node.arguments[0];
    if (!callbackArg) return null;
    
    // For map/flatMap/filter/find, analyze callback return values
    if (["map", "flatMap", "filter", "find"].includes(methodName)) {
        if (callbackArg.type === "FunctionExpression" || callbackArg.type === "ArrowFunctionExpression") {
            const callbackResults = this.resolveFunctionReturn(callbackArg, scope, pos, [], runtimeEnv);
            if (callbackResults && callbackResults.length > 0) {
                return callbackResults.filter(v => v !== "" && v !== "undefined");
            }
        }
        
        if (callbackArg.type === "Identifier") {
            const found = this.findLatestDef(scope, callbackArg.name, pos);
            if (found && found.def && found.def.node && 
                (found.def.node.type === "FunctionExpression" || 
                 found.def.node.type === "FunctionDeclaration" || 
                 found.def.node.type === "ArrowFunctionExpression")) {
                const callbackResults = this.resolveFunctionReturn(found.def.node, scope, pos, [], runtimeEnv);
                if (callbackResults && callbackResults.length > 0) {
                    return callbackResults.filter(v => v !== "" && v !== "undefined");
                }
            }
        }
    }
    
    // For reduce/reduceRight, analyze callback with initial value
    if (["reduce", "reduceRight"].includes(methodName)) {
        if (callbackArg.type === "FunctionExpression" || callbackArg.type === "ArrowFunctionExpression") {
            const initialValue = node.arguments && node.arguments[1];
            const args = initialValue ? [callbackArg, initialValue] : [callbackArg];
            const callbackResults = this.resolveFunctionReturn(callbackArg, scope, pos, args.slice(1), runtimeEnv);
            if (callbackResults && callbackResults.length > 0) {
                return callbackResults.filter(v => v !== "");
            }
        }
    }
    
    return null;
}
,

resolveFunctionFromMemberExpression(memberExpr, scope, pos, argNodes, overrides, runtimeEnv, lookupPos) {
    if (!memberExpr || memberExpr.type !== "MemberExpression") return null;

    const memberName = this.getName(memberExpr);
    if (!memberName) return null;

    const fnNode = this.findLatestMemberDef(memberName, lookupPos);
    if (fnNode) return this.resolveFunctionReturn(fnNode, scope, pos, argNodes || [], runtimeEnv);

    const propName = this.getMemberPropertyValue(memberExpr, scope, pos, overrides, runtimeEnv);
    const objName = this.getName(memberExpr.object);
    const fallbackFn = this.findLatestMemberDefByProp(propName, objName, lookupPos);
    if (fallbackFn) return this.resolveFunctionReturn(fallbackFn, scope, pos, argNodes || [], runtimeEnv);

    return null;
}
,

resolveCallExpression(node, scope, pos, overrides, runtimeEnv) {
    const calleeName = this.getName(node.callee);
    
    // Check if this is an excluded sink function (shouldn't appear as a URL)
    if (EXCLUDED_SINK_FUNCTIONS[calleeName]) {
        return [`{EXCLUDED_CALL:${calleeName}}`];
    }
    
    // For framework URL builder functions, extract the first string argument (the path)
    if (calleeName === "buildUri" || calleeName === "jsRouteBuilder") {
        const firstArg = node.arguments && node.arguments[0];
        if (firstArg && firstArg.type === "Literal" && typeof firstArg.value === "string") {
            // Return the path string directly
            return [firstArg.value];
        }
        // If first arg is not a literal, resolve it
        if (firstArg) {
            return this.resolveExpression(firstArg, scope, pos, overrides, runtimeEnv);
        }
    }
    
    // Handle known URL-returning functions - try to resolve them
    if (URL_RETURNING_FUNCTIONS[calleeName]) {
        // For these functions, try to follow their definition and extract the return value
        if (node.callee && node.callee.type === "Identifier") {
            const found = this.findLatestDef(scope, node.callee.name, pos);
            if (found && found.def && found.def.node &&
                (found.def.node.type === "FunctionDeclaration" || 
                 found.def.node.type === "FunctionExpression" || 
                 found.def.node.type === "ArrowFunctionExpression")) {
                const returnValues = this.resolveFunctionReturn(found.def.node, scope, pos, node.arguments || [], runtimeEnv);
                // Filter out placeholder results and return concrete values
                const concrete = returnValues.filter(v => v && !v.startsWith("{VAR:") && !v.startsWith("{CALL:"));
                if (concrete.length > 0) {
                    return concrete;
                }
                // If we got placeholders, still return them
                return returnValues;
            }
        }
        // Fallback: mark as URL call result
        return [`{URL_CALL:${calleeName}}`];
    }
    
    if (calleeName === "encodeURIComponent" || calleeName === "decodeURIComponent" || calleeName === "String") {
        const arg = node.arguments && node.arguments[0];
        return arg ? this.resolveExpression(arg, scope, pos, overrides, runtimeEnv) : [""];
    }
    // atob("...") / window.atob(...) — base64-decode concrete args (common skimmer exfil-host hiding that
    // regex cannot recover: a base64 blob is not a URL literal). Placeholders pass through unchanged.
    if (calleeName === "atob") {
        const arg = node.arguments && node.arguments[0];
        return arg ? this.decodeBase64Values(this.resolveExpression(arg, scope, pos, overrides, runtimeEnv)) : [""];
    }
    if (node.callee && node.callee.type === "Identifier") {
        const found = this.findLatestDef(scope, node.callee.name, pos);
        if (found && found.def && found.def.node &&
            (found.def.node.type === "FunctionDeclaration" || found.def.node.type === "FunctionExpression" || found.def.node.type === "ArrowFunctionExpression")) {
            return this.resolveFunctionReturn(found.def.node, scope, pos, node.arguments || [], runtimeEnv);
        }
        if (found && found.def && found.def.node && found.def.node.type === "MemberExpression") {
            const resolved = this.resolveFunctionFromMemberExpression(
                found.def.node,
                scope,
                pos,
                node.arguments || [],
                overrides,
                runtimeEnv,
                found.def.pos
            );
            if (resolved) return resolved;
        }
    }
    if (node.callee && node.callee.type === "MemberExpression") {
        const resolved = this.resolveFunctionFromMemberExpression(
            node.callee,
            scope,
            pos,
            node.arguments || [],
            overrides,
            runtimeEnv,
            pos
        );
        if (resolved) return resolved;
    }
    if (node.callee && node.callee.type === "MemberExpression" && node.callee.object.type === "ThisExpression") {
        const methodName = this.getMemberPropertyValue(node.callee, scope, pos, overrides, runtimeEnv);
        if (methodName && this.methodDefs.has(methodName)) {
            return this.resolveFunctionReturn(this.methodDefs.get(methodName), scope, pos, node.arguments || [], runtimeEnv);
        }
    }
    if (node.callee && node.callee.type === "MemberExpression") {
        const propName = this.getMemberPropertyValue(node.callee, scope, pos, overrides, runtimeEnv);
        const objName = this.getName(node.callee.object);

        // String.fromCharCode(104,116,...) -> the string. Folds char-code obfuscation (invisible to regex).
        if (propName === "fromCharCode") {
            const folded = this.foldFromCharCode(node.arguments || [], scope, pos, overrides, runtimeEnv);
            if (folded) return folded;
        }
        // window.atob(...) / self.atob(...) — base64-decode (identifier-form atob handled above).
        if (propName === "atob") {
            const arg = node.arguments && node.arguments[0];
            return arg ? this.decodeBase64Values(this.resolveExpression(arg, scope, pos, overrides, runtimeEnv)) : [""];
        }

        // Try resolving Promise chains (.then, .catch, .finally)
        const promiseChainResult = this.resolvePromiseChain(node, scope, pos, overrides, runtimeEnv);
        if (promiseChainResult && promiseChainResult.length > 0) {
            return promiseChainResult;
        }
        
        // Try resolving array methods (.map, .filter, .reduce, etc.)
        const arrayMethodResult = this.resolveArrayMethod(node, scope, pos, overrides, runtimeEnv);
        if (arrayMethodResult && arrayMethodResult.length > 0) {
            return arrayMethodResult;
        }
        
        if (propName === "toString") {
            if (runtimeEnv && objName && runtimeEnv.urlParams.has(objName)) {
                return this.buildQueryStrings(runtimeEnv.urlParams.get(objName));
            }
            const entries = this.resolveObjectEntriesFromNode(node.callee.object, scope, pos, overrides, runtimeEnv);
            if (objName && entries.length) {
                const params = entries.map(entry => ({
                    keyValues: [entry.key],
                    valueValues: this.resolveExpression(entry.valueNode, scope, pos, overrides, runtimeEnv)
                }));
                return this.buildQueryStrings(params);
            }
        }
        // String transforms: apply the method to CONCRETE receiver values (placeholders pass through
        // unchanged). Folds case/trim/slice obfuscation; falls back to passthrough if args aren't literal.
        const stringXform = /^(trim|trimStart|trimEnd|toLowerCase|toUpperCase|slice|substring|substr|normalize)$/;
        if (stringXform.test(propName)) {
            const base = this.resolveExpression(node.callee.object, scope, pos, overrides, runtimeEnv);
            const a0 = node.arguments && node.arguments[0], a1 = node.arguments && node.arguments[1];
            const n0 = a0 && a0.type === "Literal" && typeof a0.value === "number" ? a0.value : null;
            const n1 = a1 && a1.type === "Literal" && typeof a1.value === "number" ? a1.value : null;
            const needsArg = /^(slice|substring|substr)$/.test(propName);
            if (needsArg && n0 === null) return base;                 // non-literal index -> can't fold
            return base.map(v => {
                if (typeof v !== "string" || v.startsWith("{")) return v;
                switch (propName) {
                    case "toLowerCase": return v.toLowerCase();
                    case "toUpperCase": return v.toUpperCase();
                    case "trim": return v.trim();
                    case "trimStart": return v.trimStart();
                    case "trimEnd": return v.trimEnd();
                    case "normalize": return v.normalize();
                    case "slice": return n1 === null ? v.slice(n0) : v.slice(n0, n1);
                    case "substring": return n1 === null ? v.substring(n0) : v.substring(n0, n1);
                    case "substr": return n1 === null ? v.substr(n0) : v.substr(n0, n1);
                    default: return v;
                }
            });
        }
        // .replace(pattern, replacement) / .replaceAll(pattern, replacement). Pattern must be a literal
        // string (regex/dynamic patterns aren't folded). Replacement may be a literal (concrete fold) OR a
        // variable/expression — in which case we resolve it and substitute, so a `{token}` path param
        // (e.g. "/idx/{name}".replace("{name}", id)) becomes a templated `{VAR:id}` segment rather than
        // being left as literal `{name}` text (which downstream URL resolution would percent-encode).
        if ((propName === "replace" || propName === "replaceAll") && node.arguments && node.arguments.length >= 2) {
            const baseVals = this.resolveExpression(node.callee.object, scope, pos, overrides, runtimeEnv);
            const patternArg = node.arguments[0];
            const replArg = node.arguments[1];
            if (patternArg && patternArg.type === "Literal" && typeof patternArg.value === "string") {
                const replVals = (replArg && replArg.type === "Literal" && typeof replArg.value === "string")
                    ? [replArg.value]
                    : this.resolveExpression(replArg, scope, pos, overrides, runtimeEnv);
                const doRepl = (val, rep) => propName === "replaceAll"
                    ? val.split(patternArg.value).join(rep)
                    : val.replace(patternArg.value, rep);
                const out = [];
                for (const val of baseVals) {
                    if (typeof val !== "string") { out.push(val); continue; }
                    for (const rep of replVals) out.push(typeof rep === "string" ? doRepl(val, rep) : val);
                }
                return out.length ? this.deduplicateAndCap(out) : baseVals;
            }
            return baseVals;
        }
        if (propName === "concat") {
            const base = this.resolveExpression(node.callee.object, scope, pos, overrides, runtimeEnv);
            let result = base;
            (node.arguments || []).forEach(arg => {
                const argVals = this.resolveExpression(arg, scope, pos, overrides, runtimeEnv);
                result = this.cartesianConcat(result, argVals);
            });
            return result;
        }
        if (propName === "join") {
            const sepArg = node.arguments && node.arguments[0];
            const sep = sepArg ? this.strLit(sepArg) : ",";        // [].join() defaults to ","
            const obj = node.callee.object;
            if (sep !== null) {
                // ["h","t","t","p"].join("")  — array literal of resolvable elements
                if (obj.type === "ArrayExpression") {
                    return this.joinArrayElements(obj.elements, sep, scope, pos, overrides, runtimeEnv);
                }
                // parts.join("/") where `parts` is a variable bound to an array literal
                if (obj.type === "Identifier") {
                    const found = this.findLatestDef(scope, obj.name, pos);
                    if (found && found.def && found.def.node && found.def.node.type === "ArrayExpression") {
                        return this.joinArrayElements(found.def.node.elements, sep, scope, pos, overrides, runtimeEnv);
                    }
                }
                // x.split(A).reverse().join(B) / x.split(A).join(B) — char-array reassembly & reversal
                const chain = this.splitReverseJoinBase(obj, scope, pos, overrides, runtimeEnv);
                if (chain) {
                    const baseVals = this.resolveExpression(chain.base, scope, pos, overrides, runtimeEnv);
                    return baseVals.map(v => {
                        if (typeof v !== "string" || v.startsWith("{")) return v;
                        let parts = v.split(chain.splitSep);
                        if (chain.reversed) parts = parts.reverse();
                        return parts.join(sep);
                    });
                }
            }
            // fallback: prior behavior (elements already concatenated in the object value)
            return this.resolveExpression(node.callee.object, scope, pos, overrides, runtimeEnv);
        }
    }
    return [`{CALL:${calleeName || "anonymous"}}`];
}
,

// --- constant-folding helpers for common obfuscation builtins (operate only on CONCRETE values) ---

// base64-decode each concrete value (atob semantics: binary string); placeholders/{...} pass through.
decodeBase64Values(vals) {
    return (vals || []).map(v => {
        if (typeof v !== "string" || v.startsWith("{")) return v;
        try { return Buffer.from(v, "base64").toString("latin1"); } catch { return v; }
    });
}
,

// String.fromCharCode(...codes) when every arg resolves to a concrete number; else null (can't fold).
foldFromCharCode(argNodes, scope, pos, overrides, runtimeEnv) {
    const codes = [];
    for (const a of argNodes) {
        let n = null;
        if (a.type === "Literal" && typeof a.value === "number") n = a.value;
        else {
            const rv = this.resolveExpression(a, scope, pos, overrides, runtimeEnv).find(v => v && !v.startsWith("{"));
            if (rv != null && /^\d+$/.test(String(rv).trim())) n = parseInt(rv, 10);
        }
        if (n == null) return null;
        codes.push(n);
    }
    if (!codes.length) return null;
    try { return [String.fromCharCode(...codes)]; } catch { return null; }
}
,

// The string value of a string-literal node, else null (not a concrete string we can fold with).
strLit(node) {
    return node && node.type === "Literal" && typeof node.value === "string" ? node.value : null;
}
,

// Join an array literal's elements with sep, resolving each element (bounded cartesian across elements).
joinArrayElements(elements, sep, scope, pos, overrides, runtimeEnv) {
    let combos = null;
    for (const el of elements) {
        const vals = el ? this.resolveExpression(el, scope, pos, overrides, runtimeEnv) : [""];
        if (combos === null) { combos = vals.slice(0, this.maxCombos); continue; }
        const next = [];
        for (const c of combos) {
            for (const v of vals) { next.push(c + sep + v); if (next.length >= this.maxCombos) break; }
            if (next.length >= this.maxCombos) break;
        }
        combos = next;
    }
    return combos && combos.length ? combos : [""];
}
,

// Method name of a `<obj>.<method>(...)` call node, else null (handles computed properties too).
callMethodName(callNode, scope, pos, overrides, runtimeEnv) {
    if (!callNode || callNode.type !== "CallExpression" || !callNode.callee || callNode.callee.type !== "MemberExpression") return null;
    return this.getMemberPropertyValue(callNode.callee, scope, pos, overrides, runtimeEnv);
}
,

// Recognize `x.split(SEP)` optionally wrapped in `.reverse()`; returns {base, splitSep, reversed} or null.
splitReverseJoinBase(obj, scope, pos, overrides, runtimeEnv) {
    if (!obj || obj.type !== "CallExpression") return null;
    let reversed = false, inner = obj;
    if (this.callMethodName(obj, scope, pos, overrides, runtimeEnv) === "reverse" && (!obj.arguments || !obj.arguments.length)) {
        reversed = true;
        inner = obj.callee.object;
    }
    if (this.callMethodName(inner, scope, pos, overrides, runtimeEnv) !== "split") return null;
    const sepArg = inner.arguments && inner.arguments[0];
    const splitSep = this.strLit(sepArg);
    if (splitSep === null) return null;
    return { base: inner.callee.object, splitSep, reversed };
}
,

/**
 * Resolve Promise chains: promise.then(callback), promise.catch(callback), promise.finally(callback)
 * Extracts values from callback return statements and expressions
 */
resolvePromiseChain(node, scope, pos, overrides, runtimeEnv) {
    if (!node || node.type !== "CallExpression" || !node.callee || node.callee.type !== "MemberExpression") {
        return null;
    }
    
    const methodName = this.getMemberPropertyValue(node.callee, scope, pos, overrides, runtimeEnv);
    if (DEBUG_VAR) console.error(`[PROMISE] Checking method: ${methodName}`);
    if (!methodName || !["then", "catch", "finally"].includes(methodName)) {
        return null;
    }
    
    if (DEBUG_VAR) console.error(`[PROMISE] Found promise chain method: ${methodName}`);
    const values = [];
    
    // Get the callback function (first argument)
    const callback = node.arguments && node.arguments[0];
    if (!callback) return null;
    
    // Extract values from the callback body
    const callbackValues = this.extractFromCallback(callback, scope, pos, overrides, runtimeEnv);
    if (callbackValues && callbackValues.length > 0) {
        values.push(...callbackValues);
    }
    
    // For .finally, also return the promise values themselves
    if (methodName === "finally" && node.callee && node.callee.object) {
        const promiseValues = this.resolveExpression(
            node.callee.object,
            scope,
            pos,
            overrides,
            runtimeEnv
        );
        values.push(...promiseValues);
    }
    
    return values.length > 0 ? values : null;
}
,

/**
 * Extract values from a callback function (arrow function, function expression)
 * Handles arrow function bodies and function bodies
 */
extractFromCallback(callback, scope, pos, overrides, runtimeEnv) {
    if (!callback) return [];
    const values = [];
    
    // Arrow function: (x) => expression or (x) => { ... }
    if (callback.type === "ArrowFunctionExpression") {
        // Simple expression body: (x) => x.url
        if (callback.body && callback.body.type !== "BlockStatement") {
            const resolved = this.resolveExpression(
                callback.body,
                scope,
                pos,
                overrides,
                runtimeEnv
            );
            values.push(...resolved);
        }
        // Block body: (x) => { return x.url; }
        else if (callback.body && callback.body.type === "BlockStatement") {
            const bodyValues = this.extractFromFunctionBody(
                callback.body,
                scope,
                pos,
                overrides,
                runtimeEnv
            );
            values.push(...bodyValues);
        }
    }
    // Function expression: function(x) { return x.url; }
    else if (callback.type === "FunctionExpression") {
        const bodyValues = this.extractFromFunctionBody(
            callback.body,
            scope,
            pos,
            overrides,
            runtimeEnv
        );
        values.push(...bodyValues);
    }
    // Function declaration reference: (x) => myFunc(x) resolved elsewhere
    else if (callback.type === "Identifier") {
        const found = this.findLatestDef(scope, callback.name, pos);
        if (found && found.def && found.def.node) {
            const fnNode = found.def.node;
            if (fnNode.type === "FunctionExpression" || fnNode.type === "FunctionDeclaration" || fnNode.type === "ArrowFunctionExpression") {
                const fnValues = this.resolveFunctionReturn(fnNode, scope, pos, [], runtimeEnv);
                values.push(...fnValues);
            }
        }
    }
    
    return values;
}
,

/**
 * Extract values from a function body (BlockStatement)
 * Looks for return statements and variable assignments
 */
extractFromFunctionBody(body, scope, pos, overrides, runtimeEnv) {
    if (!body || !body.body || !Array.isArray(body.body)) return [];
    const values = [];
    
    // Walk statements looking for URLs
    for (const statement of body.body) {
        if (!statement) continue;
        
        // Handle return statements: return x.url;
        if (statement.type === "ReturnStatement" && statement.argument) {
            const resolved = this.resolveExpression(
                statement.argument,
                scope,
                pos,
                overrides,
                runtimeEnv
            );
            values.push(...resolved);
        }
        
        // Handle variable assignments in the body
        if (statement.type === "VariableDeclaration") {
            for (const decl of statement.declarations) {
                if (decl.init) {
                    const resolved = this.resolveExpression(
                        decl.init,
                        scope,
                        pos,
                        overrides,
                        runtimeEnv
                    );
                    values.push(...resolved);
                }
            }
        }
        
        // Handle expression statements (void URL construction)
        if (statement.type === "ExpressionStatement" && statement.expression) {
            const resolved = this.resolveExpression(
                statement.expression,
                scope,
                pos,
                overrides,
                runtimeEnv
            );
            // Only push if it looks like a URL (not a generic expression)
            if (resolved && resolved.length > 0) {
                const filtered = resolved.filter(v => 
                    typeof v === "string" && (
                        v.startsWith("http") ||
                        v.startsWith("/") ||
                        v.startsWith("//") ||
                        v.includes(".concat") ||
                        v.startsWith("{VAR:")
                    )
                );
                if (filtered.length > 0) values.push(...filtered);
            }
        }
    }
    
    return values;
}
,

// Depth-guarded entry: pathological/obfuscated code can drive the mutual recursion
// (resolveExpression <-> resolveCallExpression / resolveDeepObjectProperty) past the JS stack
// limit. Bail gracefully on this subexpression instead of crashing; other sinks still resolve.
resolveExpression(node, scope, pos, overrides, runtimeEnv) {
    this._resolveDepth = (this._resolveDepth || 0) + 1;
    this._ops = (this._ops || 0) + 1;
    try {
        if (this.opBudget && this._ops > this.opBudget) { this._budgetHit = true; return [""]; }   // per-sink budget bail -> PARTIAL results
        if (this._resolveDepth > 100) return [""];
        return this._resolveExpressionInner(node, scope, pos, overrides, runtimeEnv);
    } finally {
        this._resolveDepth--;
    }
}
,

_resolveExpressionInner(node, scope, pos, overrides, runtimeEnv) {
    if (!node) return [""];
    switch (node.type) {
        case "Literal": return [String(node.value)];
        case "Identifier": return this.resolveIdentifier(node.name, scope, pos, overrides, runtimeEnv);
        case "TemplateLiteral": return this.resolveTemplateLiteral(node, scope, pos, overrides, runtimeEnv);
        // Tagged template `tag`/x/${y}``: resolve the underlying template (node.quasi), treating the tag as
        // identity. Path-param encoders (Stainless's `path`/threads/${id}``, etc.) are effectively pass-through
        // for URL reconstruction — we want the templated path, not the encoded runtime value.
        case "TaggedTemplateExpression": return this.resolveTemplateLiteral(node.quasi, scope, pos, overrides, runtimeEnv);
        case "BinaryExpression": {
            if (node.operator !== "+") return [""];
            const left = this.resolveExpression(node.left, scope, pos, overrides, runtimeEnv);
            const right = this.resolveExpression(node.right, scope, pos, overrides, runtimeEnv);
            return this.cartesianConcat(left, right);
        }
        case "ConditionalExpression": {
            // Collect ALL branches from nested ternaries recursively
            const allBranches = [];
            const collectBranches = (expr) => {
                if (!expr) return;
                if (expr.type === "ConditionalExpression") {
                    // Recursively collect from nested ternary
                    collectBranches(expr.consequent);
                    collectBranches(expr.alternate);
                } else {
                    // Leaf branch - resolve it
                    const values = this.resolveExpression(expr, scope, pos, overrides, runtimeEnv);
                    allBranches.push(...values);
                }
            };
            collectBranches(node.consequent);
            collectBranches(node.alternate);
            // Keep "" branches: a ternary like `cond ? "-uat" : ""` inside a concatenation has a REAL
            // empty branch (here the prod host `cale.advance.net` vs UAT `cale-uat.advance.net`). Pruning
            // it here drops a constructible host (soundness bug). Bare empty results are still dropped at
            // emission (analyze.js: `if (!val) return`), so this only affects concat context.
            return this.deduplicateAndCap(allBranches);
        }
        case "LogicalExpression": {
            const left = this.resolveExpression(node.left, scope, pos, overrides, runtimeEnv);
            const right = this.resolveExpression(node.right, scope, pos, overrides, runtimeEnv);
            if (node.operator === "??") {
                const filtered = left.filter(v => v !== "null" && v !== "undefined" && v !== null && v !== undefined);
                if (filtered.length === 0) return right;
                return this.deduplicateAndCap([...filtered, ...right]);
            }
            return this.deduplicateAndCap([...left, ...right]);
        }
        case "MemberExpression": {
            const mapResolved = this.resolveMemberFromObjectMap(node, scope, pos, overrides, runtimeEnv);
            if (mapResolved && mapResolved.length) {
                if (DEBUG_VAR) {
                    const name = this.getName(node);
                    console.error(`[RESOLVE] MEMBER_MAP: ${name} = ${mapResolved.join(", ")}`);
                }
                return mapResolved;
            }
            // Computed array/list index arr[i]: concrete element, or bounded union of all entries when the
            // index is opaque (sound over-approximation — every entry is a possible endpoint).
            if (node.computed) {
                const arrWiden = this.resolveComputedArrayWiden(node, scope, pos, overrides, runtimeEnv);
                if (arrWiden && arrWiden.length) {
                    if (DEBUG_VAR) console.error(`[RESOLVE] ARRAY_WIDEN: ${this.getName(node)} = ${arrWiden.length} entries`);
                    return arrWiden;
                }
            }
            if (node.object && node.object.type === "NewExpression") {
                const calleeName = this.getName(node.object.callee);
                const propName = node.computed
                    ? this.resolveExpression(node.property, scope, pos, overrides, runtimeEnv)[0]
                    : this.getName(node.property);
                if (calleeName === "URL" && propName) {
                    const argNode = node.object.arguments && node.object.arguments[0];
                    const argValues = this.resolveExpression(argNode, scope, pos, overrides, runtimeEnv);
                    const resolved = argValues.map(val => this.resolveUrlProperty(val, propName)).filter(Boolean);
                    if (resolved.length > 0) return [...new Set(resolved)];
                    const placeholder = argValues.length ? argValues.join("|") : "";
                    return placeholder ? [`{VAR:URL.${propName}(${placeholder})}`] : [""];
                }
            }
            // Try resolving non-computed dot access through object literal definitions
            const deepResolved = this.resolveDeepObjectProperty(node, scope, pos, overrides, runtimeEnv);
            if (deepResolved && deepResolved.length) {
                if (DEBUG_VAR) {
                    const name = this.getName(node);
                    console.error(`[RESOLVE] DEEP_OBJECT: ${name} = ${deepResolved.join(", ")}`);
                }
                return deepResolved;
            }
            
            // Check if this member expression was assigned a literal value (e.g., l.p = "/client/")
            const name = this.getName(node);
            if (DEBUG_VAR) {
                const hasMemAssign = this.memberAssignments && this.memberAssignments.has(name);
                const memAssignSize = this.memberAssignments ? this.memberAssignments.size : 0;
                console.error(`[RESOLVE] MemberExpr: name=${name}, hasMemAssign=${hasMemAssign}, mapSize=${memAssignSize}`);
            }
            const memberAssignmentValues = this.resolveMemberAssignment(name, scope, pos, overrides, runtimeEnv);
            if (memberAssignmentValues && memberAssignmentValues.length > 0) {
                if (DEBUG_VAR) console.error(`[RESOLVE] MEMBER_LITERAL: ${name} = ${memberAssignmentValues.join(", ")}`);
                return memberAssignmentValues;
            }
            
            if (DEBUG_VAR) console.error(`[RESOLVE] MEMBER_UNRESOLVED: ${name}`);
            // For unresolved member expressions, try to enhance the object name with its chain
            if (name && node.object && node.object.type === "Identifier") {
                const objChain = this.buildVariableChain(node.object.name, scope, pos);
                const propName = node.computed
                    ? this.resolveExpression(node.property, scope, pos, overrides, runtimeEnv)[0] || "?"
                    : (node.property.type === "Identifier" ? node.property.name : String(node.property.value || "?"));
                return [`{VAR:${objChain}.${propName}}`];
            }
            return [name ? `{VAR:${name}}` : ""];
        }
        case "CallExpression": {
            // Handle Promise chains: promise.then(cb), promise.catch(cb), promise.finally(cb)
            const promiseChainResult = this.resolvePromiseChain(node, scope, pos, overrides, runtimeEnv);
            if (promiseChainResult && promiseChainResult.length > 0) {
                if (DEBUG_VAR) console.error(`[RESOLVE] PROMISE_CHAIN: ${promiseChainResult.join(", ")}`);
                return promiseChainResult;
            }
            return this.resolveCallExpression(node, scope, pos, overrides, runtimeEnv);
        }
        case "NewExpression": {
            const calleeName = this.getName(node.callee);
            
            // Handle new URL(baseUrl, [relativeUrl])
            if (calleeName === "URL") {
                const args = node.arguments || [];
                if (args.length >= 1) {
                    const baseUrlValues = this.resolveExpression(args[0], scope, pos, overrides, runtimeEnv);
                    
                    if (args.length >= 2) {
                        // new URL(relative, base) - combine them
                        const relativeValues = this.resolveExpression(args[1], scope, pos, overrides, runtimeEnv);
                        return this.cartesianConcat(relativeValues, baseUrlValues);
                    } else {
                        // new URL(absoluteUrl) - just return the URL
                        return baseUrlValues;
                    }
                }
                return [""];
            }
            
            if (calleeName === "URLSearchParams") {
                const entries = this.resolveObjectEntriesFromNode(node.arguments && node.arguments[0], scope, pos, overrides, runtimeEnv);
                const params = [];
                entries.forEach(entry => {
                    params.push({
                        keyValues: [entry.key],
                        valueValues: this.resolveExpression(entry.valueNode, scope, pos, overrides, runtimeEnv)
                    });
                });
                return this.buildQueryStrings(params);
            }
            return [""];
        }
        case "ParenthesizedExpression": return this.resolveExpression(node.expression, scope, pos, overrides, runtimeEnv);
        case "SequenceExpression": {
            const last = node.expressions[node.expressions.length - 1];
            return this.resolveExpression(last, scope, pos, overrides, runtimeEnv);
        }
        // Optional chaining: obj?.prop, obj?.[expr], obj?.()
        case "ChainExpression": return this.resolveExpression(node.expression, scope, pos, overrides, runtimeEnv);
        // Unary expressions: void 0, typeof x, !x
        case "UnaryExpression": {
            if (node.operator === "void") return ["undefined"];
            return this.resolveExpression(node.argument, scope, pos, overrides, runtimeEnv);
        }
        // Await expression: await promise
        case "AwaitExpression": {
            return this.resolveExpression(node.argument, scope, pos, overrides, runtimeEnv);
        }
        // AssignmentExpression as expression: x = val (returns the value)
        case "AssignmentExpression": {
            return this.resolveExpression(node.right, scope, pos, overrides, runtimeEnv);
        }
        default: return [""];
    }
}
,

};
