"use strict";

// Shared sink-detection vocabularies. Kept as module constants so the same verb/method/global-name lists
// can't drift between the many predicates that reference them.
const HTTP_VERB_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i;           // a bare method token, e.g. "GET"
const HTTP_VERB_ROUTE_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//i; // combined route, e.g. "GET /repos"
const FETCH_LIKE_RE = /^(fetch|axios|request|send)$/i;                       // identifier-form request funcs
const JQUERY_METHOD_RE = /^(get|post|getJSON|getScript|ajax)$/i;             // $.get / $.post / $.ajax / …
const WINDOW_ALIASES = new Set(["window", "globalThis", "self"]);           // global-this receivers of .fetch/.open
const GLOBAL_NAMES = new Set(["document", "window", "this", "self", "globalThis"]); // IIFE-aliasable globals

module.exports = {

createScope(parent) {
    this.scopeId += 1;
    return { id: this.scopeId, parent, defs: new Map(), paramNames: new Set() };
}
,

addDef(scope, name, node, pos) {
    if (!scope.defs.has(name)) scope.defs.set(name, []);
    scope.defs.get(name).push({ node, pos });
}
,

addFunctionCall(node, scope) {
    this.functionCalls.push({ node, scope });
}
,

addMemberDef(name, node, pos) {
    if (!name || !node) return;
    if (!this.memberDefs.has(name)) this.memberDefs.set(name, []);
    this.memberDefs.get(name).push({ node, pos: typeof pos === "number" ? pos : 0 });
}
,

findLatestMemberDef(name, pos) {
    if (!this.memberDefs.has(name)) return null;
    const defs = this.memberDefs.get(name) || [];
    if (!defs.length) return null;
    if (typeof pos !== "number") return defs[defs.length - 1].node;
    const candidate = defs
        .filter(def => typeof def.pos === "number" && def.pos <= pos)
        .sort((a, b) => b.pos - a.pos)[0];
    return candidate ? candidate.node : null;
}
,

findLatestMemberDefByProp(propName, objName, pos) {
    if (!propName) return null;
    let best = null;
    this.memberDefs.forEach((defs, name) => {
        if (!name || !name.endsWith(`.${propName}`)) return;
        if (objName && !name.startsWith(`${objName}.`)) return;
        defs.forEach(def => {
            if (typeof pos === "number" && typeof def.pos === "number" && def.pos > pos) return;
            if (!best || (def.pos || 0) > (best.pos || 0)) best = def;
        });
    });
    return best ? best.node : null;
}
,

extractPlaceholderVarName(value) {
    if (typeof value !== "string") return "";
    const match = value.match(/^\{VAR:([^}]+)\}$/);
    return match ? match[1] : "";
}
,

getName(node) {
    if (!node) return "";
    if (node.type === "Identifier") return node.name;
    if (node.type === "ThisExpression") return "this";
    if (node.type === "MemberExpression") {
        const obj = this.getName(node.object);
        const prop = this.getName(node.property);
        return obj ? `${obj}.${prop}` : prop;
    }
    return "";
}
,

getCreateElementKind(node, scope, pos) {
    if (!node || node.type !== "CallExpression") return "";
    const calleeName = this.getName(node.callee);
    // Direct: document.createElement(tag)
    let isCreateElement = calleeName === "document.createElement" || calleeName === "createElement";
    // Aliased: X.createElement(tag) where X resolves to document (common in IIFEs)
    if (!isCreateElement && node.callee && node.callee.type === "MemberExpression") {
        const propName = node.callee.property && node.callee.property.type === "Identifier" ? node.callee.property.name : "";
        if (propName === "createElement" && node.callee.object && node.callee.object.type === "Identifier") {
            const objName = node.callee.object.name;
            // Check if this identifier is an IIFE-bound alias for document
            if (this.iifeAliases && this.iifeAliases.get(objName) === "document") {
                isCreateElement = true;
            }
        }
    }
    if (!isCreateElement) return "";
    const urlTags = new Set(["script", "link", "iframe", "img", "audio", "video", "source", "embed", "object"]);
    const arg = node.arguments && node.arguments[0];
    if (!arg) return "";
    // Direct literal: createElement("script")
    if (arg.type === "Literal" && typeof arg.value === "string") {
        const tag = arg.value.toLowerCase();
        return urlTags.has(tag) ? tag : "";
    }
    // Conditional: createElement(cond ? "link" : "script") — return all possible tags
    if (arg.type === "ConditionalExpression") {
        const tags = new Set();
        const tryBranch = (branch) => {
            if (branch && branch.type === "Literal" && typeof branch.value === "string") {
                const t = branch.value.toLowerCase();
                if (urlTags.has(t)) tags.add(t);
            }
        };
        tryBranch(arg.consequent);
        tryBranch(arg.alternate);
        // If both branches are valid URL-bearing tags, pick a representative one
        if (tags.size > 0) return [...tags][0];
    }
    // AssignmentExpression as arg: createElement((a=expr)?"link":"script")
    if (arg.type === "AssignmentExpression" && arg.right && arg.right.type === "ConditionalExpression") {
        return this.getCreateElementKind({ ...node, arguments: [arg.right] }, scope, pos);
    }
    return "";
}
,

addElementUrl(name, entry) {
    if (!name || !entry) return;
    if (!this.elementUrls.has(name)) this.elementUrls.set(name, []);
    this.elementUrls.get(name).push(entry);
}
,

resolveUrlProperty(urlValue, prop) {
    try {
        const parsed = new URL(urlValue);
        if (prop === "origin") return parsed.origin;
        if (prop === "href") return parsed.href;
        if (prop === "pathname") return parsed.pathname;
        if (prop === "search") return parsed.search;
        if (prop === "host") return parsed.host;
        if (prop === "hostname") return parsed.hostname;
        if (prop === "protocol") return parsed.protocol;
    } catch (err) {
        return "";
    }
    return "";
}
,

resolveIdentifierSink(name, node) {
    if (FETCH_LIKE_RE.test(name)) return { name, urlArgIndex: 0 };
    if (/^importScripts$/i.test(name)) return { name: "importScripts", urlArgIndex: 0 };
    if (/open$/i.test(name)) {
        if (node.arguments && node.arguments[0] && node.arguments[0].type === "Literal" && typeof node.arguments[0].value === "string") {
            return { name, urlArgIndex: node.arguments[1] ? 1 : 0 };
        }
        return { name, urlArgIndex: 0 };
    }
    return null;
}
,

normalizeSinkObjectName(name, scope, lookupPos) {
    if (!name) return name;
    if (this.iifeAliases && this.iifeAliases.has(name)) return this.iifeAliases.get(name);
    const found = this.findLatestDef(scope, name, lookupPos);
    const defNode = found && found.def ? found.def.node : null;
    if (defNode && defNode.type === "Identifier") return defNode.name;
    if (defNode && defNode.type === "AssignmentExpression" && defNode.right && defNode.right.type === "Identifier") {
        return defNode.right.name;
    }
    return name;
}
,

resolveSinkMemberPropName(memberExpr, scope, lookupPos) {
    if (!memberExpr) return "";
    if (!memberExpr.computed) return this.getName(memberExpr.property);
    if (memberExpr.property && memberExpr.property.type === "Literal") {
        return String(memberExpr.property.value);
    }
    if (memberExpr.property && memberExpr.property.type === "Identifier") {
        const found = this.findLatestDef(scope, memberExpr.property.name, lookupPos);
        const defNode = found && found.def ? found.def.node : null;
        if (defNode && defNode.type === "Literal" && typeof defNode.value === "string") {
            return String(defNode.value);
        }
    }
    return "";
}
,

resolveMemberSink(objNameRaw, propName, scope, lookupPos) {
    const objName = this.normalizeSinkObjectName(objNameRaw, scope, lookupPos);
    if (objName === "axios" && /^(get|post|put|delete|patch|head|request)$/i.test(propName)) {
        return { name: `axios.${propName}`, urlArgIndex: 0 };
    }
    if (WINDOW_ALIASES.has(objName) && propName === "fetch") {
        return { name: "fetch", urlArgIndex: 0 };
    }
    if (WINDOW_ALIASES.has(objName) && propName === "open") {
        return { name: "window.open", urlArgIndex: 0 };
    }
    if (/^(location|window\.location|document\.location)$/.test(objName) && /^(assign|replace)$/.test(propName)) {
        return { name: `location.${propName}`, urlArgIndex: 0 };
    }
    if (objName === "navigator" && propName === "sendBeacon") {
        return { name: "navigator.sendBeacon", urlArgIndex: 0 };
    }
    if (/^\$|^jQuery$/.test(objName) && JQUERY_METHOD_RE.test(propName)) {
        return { name: `$.${propName}`, urlArgIndex: 0 };
    }
    if (/^https?$/.test(objName) && /^(request|get)$/.test(propName)) {
        return { name: `${objName}.${propName}`, urlArgIndex: 0 };
    }
    if (/^(history|window\.history)$/.test(objName) && /^(pushState|replaceState)$/.test(propName)) {
        return { name: `history.${propName}`, urlArgIndex: 2 };
    }
    return null;
}
,

// True iff a string is ROUTE-SHAPED: starts with "/", "http(s)://", or a combined "VERB /path" prefix
// (octokit-style request("GET /repos/{owner}/{repo}") — the verb is stripped on emit). Shared qualifier.
routeHead(s) {
    return typeof s === "string" &&
        (s.startsWith("/") || /^https?:\/\//i.test(s) || HTTP_VERB_ROUTE_RE.test(s));
}
,

// The concrete string / template-literal head of a node (unwrapping a tagged template), or null.
pathHeadOf(node) {
    if (!node) return null;
    if (node.type === "TaggedTemplateExpression") node = node.quasi;      // path`/x/${id}` → the template
    if (node.type === "Literal") return typeof node.value === "string" ? node.value : null;
    if (node.type === "TemplateLiteral") {
        const first = node.quasis && node.quasis[0];
        const head = first && first.value && (first.value.cooked != null ? first.value.cooked : first.value.raw);
        return typeof head === "string" ? head : null;
    }
    return null;
}
,

// Qualifier for the verb-METHOD dispatch sink (.get/.post/.request("...")): arg #idx is a concrete route.
// Admits real endpoints while excluding Map.get(k)/_.get(o,"a.b")/cache.delete(k) (arg isn't route-shaped).
hasLeadingSlashPathArg(node, idx) {
    return this.routeHead(this.pathHeadOf(node.arguments && node.arguments[idx]));
}
,

// True iff a value node is a concrete route (leading "/", http, or "VERB /path"). Qualifies the
// options-object sink's path property, and the concrete side of the positional pair.
isPathLikeNode(node) {
    return this.routeHead(this.pathHeadOf(node));
}
,

// An HTTP verb expressed as a string literal ("GET") OR an enum/const member (HttpMethod.GET, M["GET"]).
// Returns the uppercased verb, or null. Lets the positional/config sinks match generated SDKs that pass
// the method as an enum rather than a raw string.
verbOfNode(node) {
    if (!node) return null;
    if (node.type === "Literal" && typeof node.value === "string" && HTTP_VERB_RE.test(node.value)) return node.value.toUpperCase();
    if (node.type === "MemberExpression" && node.property) {
        const p = !node.computed && node.property.type === "Identifier" ? node.property.name
            : (node.property.type === "Literal" ? String(node.property.value) : "");
        if (HTTP_VERB_RE.test(p)) return p.toUpperCase();
    }
    return null;
}
,

// A path argument for the positional dispatch sink: a concrete route, OR a plain variable / property
// reference we resolve backward to the path — e.g. openapi-generator's
// makeRequestContext(localVarPath, HttpMethod.GET), where `localVarPath = "/api/v1/…"`. A non-path
// resolved value is dropped downstream by getSortedResultRows' route-shape filter, so this stays precise.
isPathCandidateNode(node) {
    if (!node || this.verbOfNode(node)) return false;                    // a verb is the method, not the path
    return this.isPathLikeNode(node) || node.type === "Identifier" || node.type === "MemberExpression";
}
,

// Options-object HTTP dispatch: a call whose argument is an inline request-config object
//   fn({ method: "POST", url|path|fullPath|uri|endpoint: "/..." })
// — the shape used by axios(config)/got and SDK dispatchers (stripe stripeMethod({method,fullPath}),
// square/sendgrid request({method,path})), where the URL is a PROPERTY, not a positional arg. GATED on a
// sibling `method` HTTP-verb literal: that excludes SPA router configs ({ path:"/x", component }) which
// share the path-property shape but never carry a method. Returns the path property's value NODE as
// sinkInfo.urlNode (getSinkArgumentNode returns urlNode directly, so no positional index is needed).
restConfigSink(node) {
    const URLPROPS = ["url", "path", "fullPath", "uri", "endpoint"];
    const keyOf = (p) => (p && p.type === "Property" && !p.computed && p.key)
        ? (p.key.type === "Identifier" ? p.key.name : (p.key.type === "Literal" ? String(p.key.value) : "")) : "";
    for (const arg of node.arguments || []) {
        if (!arg || arg.type !== "ObjectExpression") continue;
        let methodOk = false, urlNode = null;
        for (const p of arg.properties) {
            const k = keyOf(p);
            if (k === "method" && this.verbOfNode(p.value)) methodOk = true;   // "GET" literal or HttpMethod.GET enum
            else if (!urlNode && URLPROPS.includes(k) && this.isPathLikeNode(p.value)) urlNode = p.value;
        }
        if (methodOk && urlNode) return { name: "rest.config", urlNode };
    }
    return null;
}
,

// Positional (method, path) dispatch: a call with an ADJACENT verb + path pair, in EITHER order, where the
// verb is a string literal OR an enum member (HttpMethod.GET) and the path is a concrete route OR a
// variable. Covers square's builder(cfg,cfg,"POST","/v2/subscriptions"), stripeMethod("GET","/v1/x"), and
// openapi-generator's makeRequestContext(localVarPath, HttpMethod.GET). The general form of the built-in
// xhr.open(method, url). The verb is the low-FP discriminator; a non-path resolved value is dropped by
// getSortedResultRows' route-shape filter, so the loose (verb, <expr>) match stays precise.
positionalVerbPathSink(node) {
    const args = node.arguments || [];
    let fallback = null;   // a (verb, <variable>) pair — used only if no concrete route pair is found, so a
                           // config object adjacent to the verb (square: builder(cfg,cfg,"POST","/v2/x"))
                           // can't win over the real "/v2/x" that follows.
    for (let i = 0; i + 1 < args.length; i++) {
        const a = args[i], b = args[i + 1];
        const path = this.verbOfNode(a) && !this.verbOfNode(b) ? b
                   : this.verbOfNode(b) && !this.verbOfNode(a) ? a : null;
        if (!path) continue;
        if (this.isPathLikeNode(path)) return { name: "rest.method", urlNode: path };   // concrete route wins
        if (!fallback && this.isPathCandidateNode(path)) fallback = path;                // else remember the variable
    }
    return fallback ? { name: "rest.method", urlNode: fallback } : null;
}
,

isSinkCall(node, scope, pos) {
    if (!node || node.type !== "CallExpression") return null;
    const callee = node.callee;
    // Callee-agnostic dispatch sinks (fire for axios(config), this.request({...}), stripeMethod(...),
    // and minified (0,f)(...) builder calls alike). Both are method-verb-gated, so they never shadow a
    // plain positional string sink (fetch(url), etc.) — those calls carry no HTTP-verb literal.
    const cfg = this.restConfigSink(node);
    if (cfg) return cfg;
    const pvp = this.positionalVerbPathSink(node);
    if (pvp) return pvp;

    const lookupPos = typeof pos === "number" ? pos : (node.start || 0);

    if (callee.type === "Identifier") {
        const name = callee.name;
        const directSink = this.resolveIdentifierSink(name, node);
        if (directSink) return directSink;
        const found = this.findLatestDef(scope, name, lookupPos);
        const defNode = found && found.def ? found.def.node : null;
        if (defNode) {
            if (defNode.type === "Identifier") {
                const aliasedSink = this.resolveIdentifierSink(defNode.name, node);
                if (aliasedSink) return aliasedSink;
            }
            if (defNode.type === "MemberExpression") {
                const objName = this.getName(defNode.object);
                const propName = this.resolveSinkMemberPropName(defNode, scope, lookupPos);
                const memberSink = this.resolveMemberSink(objName, propName, scope, lookupPos);
                if (memberSink) return memberSink;
            }
            if (defNode.type === "AssignmentExpression" && defNode.right) {
                if (defNode.right.type === "Identifier") {
                    const aliasedSink = this.resolveIdentifierSink(defNode.right.name, node);
                    if (aliasedSink) return aliasedSink;
                }
                if (defNode.right.type === "MemberExpression") {
                    const objName = this.getName(defNode.right.object);
                    const propName = this.resolveSinkMemberPropName(defNode.right, scope, lookupPos);
                    const memberSink = this.resolveMemberSink(objName, propName, scope, lookupPos);
                    if (memberSink) return memberSink;
                }
            }
        }
        return null;
    }

    if (callee.type === "MemberExpression") {
        const propName = this.resolveSinkMemberPropName(callee, scope, lookupPos);
        // REST-client dispatch: <recv>.get|post|put|patch|delete|request("/path"[, ...]). Qualified by a
        // leading-slash path ARGUMENT, NOT the receiver — so it fires on custom SDK/axios-instance clients
        // (this.post("/v1/..."), client.get(...), b.uE.get("/api/...")) that aren't in the known-receiver
        // set (axios/$/http). The slash filter is what keeps non-HTTP verbs out: Map.get(k), _.get(o,"a.b"),
        // cache.delete(k), emitter.post(msg) — their arg0 doesn't start with "/". Runs BEFORE the this.*
        // bail below so this.post("/path") is caught. Emits the path (study scores path-template recall).
        if (/^(get|post|put|patch|delete|request)$/i.test(propName) && this.hasLeadingSlashPathArg(node, 0)) {
            return { name: `rest.${propName.toLowerCase()}`, urlArgIndex: 0 };
        }
        if (callee.object && callee.object.type === "ThisExpression") return null;
        const objName = this.getName(callee.object);
        const memberSink = this.resolveMemberSink(objName, propName, scope, lookupPos);
        if (memberSink) return memberSink;
        // XMLHttpRequest.open(method, url)
        if (propName === "open" && node.arguments && node.arguments.length >= 2) {
            const firstArg = node.arguments[0];
            if (firstArg && firstArg.type === "Literal" && typeof firstArg.value === "string" &&
                HTTP_VERB_RE.test(firstArg.value)) {
                return { name: "xhr.open", urlArgIndex: 1 };
            }
        }
    }

    return null;
}
,

isEventHandlerProperty(propName) {
    return /^on(click|dblclick|mousedown|mouseup|mouseover|mouseout|mousemove|mouseenter|mouseleave|focus|blur|input|change|submit|reset|load|unload|beforeunload|resize|scroll|keydown|keyup|keypress|contextmenu|touchstart|touchend|touchmove|error|ready|drag|drop|dragover|dragend|dragstart|transitionend|animationend|animationstart)$/i.test(propName);
}
,

extractEventNameFromProperty(propName) {
    const match = propName.match(/^on(.+)$/i);
    return match ? match[1].toLowerCase() : "";
}
,

isEventListenerCall(node, scope, pos) {
    if (!node || node.type !== "CallExpression") return null;
    const callee = node.callee;
    if (!callee) return null;
    
    const lookupPos = typeof pos === "number" ? pos : (node.start || 0);
    
    if (callee.type === "MemberExpression") {
        const propName = callee.computed
            ? (callee.property && callee.property.type === "Literal" ? String(callee.property.value) : "")
            : (callee.property && callee.property.type === "Identifier" ? callee.property.name : "");
        
        if ((propName === "addEventListener" || propName === "on") && node.arguments && node.arguments.length >= 2) {
            const eventNameNode = node.arguments[0];
            const callbackNode = node.arguments[1];
            
            let eventName = "";
            if (eventNameNode && eventNameNode.type === "Literal" && typeof eventNameNode.value === "string") {
                eventName = eventNameNode.value.toLowerCase();
            }
            
            if (eventName && (callbackNode.type === "FunctionExpression" || callbackNode.type === "ArrowFunctionExpression" || callbackNode.type === "Identifier")) {
                return { eventName, callbackNode, type: "addEventListener" };
            }
        }
    }
    
    return null;
}
,

handleEventListener(handlerInfo, node, scope, walk, fnScope, position) {
    const { eventName, callbackNode } = handlerInfo;
    
    if (callbackNode.type === "Identifier") {
        const found = this.findLatestDef(scope, callbackNode.name, position);
        if (found && found.def && found.def.node) {
            const defNode = found.def.node;
            if (defNode.type === "FunctionExpression" || defNode.type === "ArrowFunctionExpression") {
                this._walkEventHandler(defNode, found.scope, walk);
            }
        }
    } else if (callbackNode.type === "FunctionExpression" || callbackNode.type === "ArrowFunctionExpression") {
        this._walkEventHandler(callbackNode, scope, walk);
    }
}
,

_walkEventHandler(fnNode, scope, walk) {
    if (!fnNode) return;
    // Register the callback's function scope, but do NOT re-walk its body: the main traversal already walks
    // every function body exactly once (an inline callback is an ordinary CallExpression argument; a named
    // one is walked at its definition). Re-walking here double-processed the body, and for NESTED event
    // listeners that doubling compounded to 2^depth — a shared subtree was re-visited tens of thousands of
    // times, making index() effectively non-terminating on some bundles. `walk` is now unused but kept in
    // the signature so callers are unchanged.
    if (!this.fnScopeMap.has(fnNode)) {
        const fnScope = this.createScope(scope);
        this.fnScopeMap.set(fnNode, fnScope);
        const params = fnNode.params || [];
        params.forEach(param => {
            if (param.type === "Identifier") fnScope.paramNames.add(param.name);
            if (param.type === "AssignmentPattern" && param.left && param.left.type === "Identifier") {
                fnScope.paramNames.add(param.left.name);
            }
        });
    }
}
,

index() {
    const enterScope = (node, parentScope) => {
        const scope = this.createScope(parentScope);
        this.scopeMap.set(node, scope);
        return scope;
    };

    const stack = [];
    // Per-property-key Set of literal values already stored under the general ".prop" key, so the dedup
    // below is O(1) instead of an O(n²) rescan of the whole list (see the push site for why that mattered).
    const propKeySeen = new Map();
    // Deferred/iterative traversal: `walk` only enqueues; `process` does the per-node work. This
    // replaces native recursion so deeply-nested ASTs (long +/||/method chains in minified bundles)
    // can't overflow the call stack. Children are pushed in reverse so they pop in source order —
    // an identical pre-order DFS to the former recursion (results verified byte-identical).
    const walk = (node, scope, parent) => { if (node && typeof node === "object") stack.push([node, scope, parent]); };
    const visit = (node, scope, parent) => {   // NB: not named `process` — that shadows the global `process` (env checks below)
        if (!node || typeof node !== "object") return;
        this.scopeMap.set(node, scope);
        this.parentMap.set(node, parent || null);

        if (node.type === "FunctionDeclaration" && node.id && node.id.name) {
            // Use position 0 to account for JavaScript function declaration hoisting —
            // function declarations are available throughout their enclosing scope.
            this.addDef(scope, node.id.name, node, 0);
        }
        if (node.type === "VariableDeclarator" && node.id && node.id.type === "Identifier") {
            this.addDef(scope, node.id.name, node.init || null, node.start || 0);
            if (node.init) {
                const kind = this.getCreateElementKind(node.init, scope, node.start || 0);
                if (kind) this.elementKinds.set(node.id.name, kind);
            }
        }
        // Destructuring: const { a, b } = obj  or  const [x, y] = arr
        if (node.type === "VariableDeclarator" && node.id && node.id.type === "ObjectPattern" && node.init) {
            (node.id.properties || []).forEach(prop => {
                if (!prop || !prop.value || prop.value.type !== "Identifier") return;
                const keyName = prop.key && prop.key.type === "Identifier" ? prop.key.name : (prop.key && prop.key.type === "Literal" ? String(prop.key.value) : "");
                if (!keyName) return;
                // Create a synthetic MemberExpression node for the destructured property
                const syntheticNode = {
                    type: "MemberExpression",
                    object: node.init,
                    property: { type: "Identifier", name: keyName },
                    computed: false,
                    start: node.start || 0
                };
                this.addDef(scope, prop.value.name, syntheticNode, node.start || 0);
            });
        }
        if (node.type === "VariableDeclarator" && node.id && node.id.type === "ArrayPattern" && node.init) {
            (node.id.elements || []).forEach((el, idx) => {
                if (!el || el.type !== "Identifier") return;
                const syntheticNode = {
                    type: "MemberExpression",
                    object: node.init,
                    property: { type: "Literal", value: idx, raw: String(idx) },
                    computed: true,
                    start: node.start || 0
                };
                this.addDef(scope, el.name, syntheticNode, node.start || 0);
            });
        }
        if (node.type === "AssignmentExpression" && node.left && node.left.type === "Identifier") {
            this.addDef(scope, node.left.name, node, node.start || 0);
            if (node.right) {
                const kind = this.getCreateElementKind(node.right, scope, node.start || 0);
                if (kind) this.elementKinds.set(node.left.name, kind);
            }
        }
        if (node.type === "AssignmentExpression" && node.left && node.left.type === "MemberExpression") {
            const leftName = this.getName(node.left);
            if (leftName && node.right &&
                (node.right.type === "FunctionExpression" || node.right.type === "ArrowFunctionExpression")) {
                this.addMemberDef(leftName, node.right, node.start || 0);
            }
            const propName = node.left.computed
                ? (node.left.property && node.left.property.type === "Literal" ? String(node.left.property.value) : "")
                : this.getName(node.left.property);
            const objName = this.getName(node.left.object);
            
            // Track member assignments so the resolver can follow aliases like a.p = t.
            // Each record carries the assignment's lexical `scope`, its `base` variable (root of the
            // LHS member chain), and `global` (assigned at program scope) so resolution can respect
            // scope (see resolveMemberAssignment / resolveVariablePlaceholders) instead of matching
            // by name across unrelated scopes.
            if (objName && propName && node.right) {
                let baseNode = node.left;
                while (baseNode && baseNode.type === "MemberExpression") baseNode = baseNode.object;
                const base = baseNode && baseNode.type === "Identifier" ? baseNode.name : null;
                const meta = { scope, base, global: !scope.parent };
                const value = node.right.type === "Literal" && typeof node.right.value === "string" ? node.right.value : null;

                const memberKey = `${objName}.${propName}`;
                if (!this.memberAssignments.has(memberKey)) {
                    this.memberAssignments.set(memberKey, []);
                }
                this.memberAssignments.get(memberKey).push({ value, node: node.right, pos: node.start || 0, ...meta });

                // Also store by property name alone for general lookup (e.g., any ".p" assignment)
                // This allows resolution of {VAR:l.p}, {VAR:b.p}, etc. regardless of variable name
                const propKey = `.${propName}`;
                if (!this.memberAssignments.has(propKey)) {
                    this.memberAssignments.set(propKey, []);
                }
                // Dedup a repeated literal value under the general ".prop" key. This used to be
                // `existing.some(a => a.value === node.right.value)` — an O(n²) linear rescan of the whole
                // list per assignment. Minified bundles assign the same short prop name (`.a`, `.p`, …)
                // tens of thousands of times, so index() went quadratic and hung — and index() charges no
                // op-budget, so nothing capped it. A per-key Set makes it O(1). Semantics are unchanged:
                // string-literal values dedup on first occurrence; non-literal RHS (value === null) never
                // matched the old scan (null !== node.right.value), so those are always appended.
                let pushGeneral = true;
                if (value !== null) {
                    let seen = propKeySeen.get(propKey);
                    if (!seen) { seen = new Set(); propKeySeen.set(propKey, seen); }
                    if (seen.has(value)) pushGeneral = false; else seen.add(value);
                }
                if (pushGeneral) {
                    this.memberAssignments.get(propKey).push({ value, node: node.right, pos: node.start || 0, isGeneral: true, ...meta });
                }
                
                if (process.env.DEBUG_MEMBER) {
                    console.error(`[INDEX] MEMBER_ASSIGN: ${memberKey} = ${JSON.stringify(value)}`);
                }
            }
            
            // Event handler assignment: element.onclick = function() { ... }
            if (this.isEventHandlerProperty(propName) && node.right &&
                (node.right.type === "FunctionExpression" || node.right.type === "ArrowFunctionExpression")) {
                // Will be processed in walk() - add to deferred processing
                // Store as a pseudo-sink so we can extract URLs from event handlers
                this.sinks.push({
                    node,
                    scope,
                    sinkInfo: { name: `event:${this.extractEventNameFromProperty(propName)}`, isEventHandler: true },
                    eventHandlerNode: node.right
                });
            }
            if ((propName === "src" || propName === "href") && node.right) {
                if (objName) {
                    const kind = this.elementKinds.get(objName);
                    if (kind) {
                        this.addElementUrl(objName, { node: node.right, scope, pos: node.start || 0 });
                        this.sinks.push({
                            node,
                            scope,
                            sinkInfo: { name: kind, urlNode: node.right }
                        });
                    } else {
                        // Standalone .src/.href on a named object without known elementKind
                        this.sinks.push({
                            node,
                            scope,
                            sinkInfo: { name: propName, urlNode: node.right }
                        });
                    }
                } else {
                    // Object is a CallExpression (e.g. c("script").src = url)
                    // Try to detect element kind from the call
                    const objNode = node.left.object;
                    let callKind = null;
                    if (objNode && objNode.type === "CallExpression") {
                        callKind = this.getCreateElementKind(objNode, scope, node.start || 0);
                    }
                    this.sinks.push({
                        node,
                        scope,
                        sinkInfo: { name: callKind || propName, urlNode: node.right }
                    });
                }
            }
            // location.href = url, window.location.href = url, window.location = url
            if (propName === "href" && /^(location|window\.location|document\.location)$/.test(objName) && node.right) {
                this.sinks.push({
                    node, scope,
                    sinkInfo: { name: "location.href", urlNode: node.right }
                });
            }
            if ((leftName === "window.location" || leftName === "document.location" || leftName === "location") && node.right) {
                this.sinks.push({
                    node, scope,
                    sinkInfo: { name: "location", urlNode: node.right }
                });
            }
            // Generic x.location = url (e.g. n.location = s where n is a window reference)
            if (propName === "location" && objName && !/^(window|document)$/.test(objName) && node.right) {
                this.sinks.push({
                    node, scope,
                    sinkInfo: { name: "location", urlNode: node.right }
                });
            }
        }
        if (node.type === "MethodDefinition" && node.key && node.value) {
            const methodName = node.key.type === "Identifier" ? node.key.name : String(node.key.value || "");
            if (methodName) this.methodDefs.set(methodName, node.value);
        }

        // import() dynamic imports as sinks
        if (node.type === "ImportExpression") {
            this.sinks.push({
                node,
                scope,
                sinkInfo: { name: "import", urlNode: node.source }
            });
        }

        // new Worker(url), new SharedWorker(url), new EventSource(url), new WebSocket(url)
        if (node.type === "NewExpression") {
            const calleeName = this.getName(node.callee);
            if (/^(Worker|SharedWorker|EventSource|WebSocket)$/.test(calleeName) && node.arguments && node.arguments[0]) {
                this.sinks.push({
                    node,
                    scope,
                    sinkInfo: { name: calleeName, urlNode: node.arguments[0] }
                });
            }
            // new Image() - track for .src assignment
            if (calleeName === "Image") {
                // Find the variable name if available (let img = new Image())
                const parentNode = this.parentMap.get(node);
                if (parentNode && parentNode.type === "VariableDeclarator" && parentNode.id && parentNode.id.type === "Identifier") {
                    this.elementKinds.set(parentNode.id.name, "img");
                }
            }
        }

        if (node.type === "CallExpression") {
            const sinkInfo = this.isSinkCall(node, scope, node.start || 0);
            if (sinkInfo) this.sinks.push({ node, sinkInfo, scope });
            
            // Check for addEventListener or direct event listeners
            const eventHandlerInfo = this.isEventListenerCall(node, scope, node.start || 0);
            if (eventHandlerInfo) {
                // Process the event handler callback immediately
                this.handleEventListener(eventHandlerInfo, node, scope, walk, scope, node.start || 0);
                // Also track as sink marker (for reference)
                this.sinks.push({
                    node,
                    scope,
                    sinkInfo: { name: `event:${eventHandlerInfo.eventName}`, isEventHandler: true },
                    eventHandlerNode: eventHandlerInfo.callbackNode
                });
            }
            
            if (node.callee && (node.callee.type === "Identifier" || node.callee.type === "MemberExpression")) {
                this.addFunctionCall(node, scope);
            }
            if (node.callee && node.callee.type === "MemberExpression") {
                const propName = node.callee.computed
                    ? (node.callee.property && node.callee.property.type === "Literal" ? String(node.callee.property.value) : "")
                    : this.getName(node.callee.property);
                const objName = this.getName(node.callee.object);
                if (propName === "setAttribute" && objName) {
                    const attrNode = node.arguments && node.arguments[0];
                    const valueNode = node.arguments && node.arguments[1];
                    if (attrNode && attrNode.type === "Literal" && (attrNode.value === "src" || attrNode.value === "href") && valueNode) {
                        // el.setAttribute("src"/"href", url) is a URL sink just like el.src = url. Use the element
                        // kind when known (script/link/img/...); otherwise fall back to the attribute name, so a
                        // setAttribute on a createElement(<variable-tag>) element (the GTM/pixel-loader idiom,
                        // whose tag lynx can't statically resolve) is still recorded — matching the direct-.src path.
                        const kind = this.elementKinds.get(objName);
                        if (kind) this.addElementUrl(objName, { node: valueNode, scope, pos: node.start || 0 });
                        this.sinks.push({
                            node,
                            scope,
                            sinkInfo: { name: kind || String(attrNode.value), urlNode: valueNode }
                        });
                    }
                }
                if (propName === "appendChild" || propName === "append" || propName === "insertBefore") {
                    const childNode = node.arguments && node.arguments[0];
                    const childName = this.getName(childNode);
                    const kind = childName ? this.elementKinds.get(childName) : "";
                    const entries = childName ? this.elementUrls.get(childName) || [] : [];
                    if (kind && entries.length > 0) {
                        entries.forEach(entry => {
                            this.sinks.push({
                                node,
                                scope,
                                sinkInfo: { name: kind, urlNode: entry.node }
                            });
                        });
                    }
                }
            }
        }

        if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
            const fnScope = enterScope(node, scope);
            this.fnScopeMap.set(node, fnScope);
            const params = node.params || [];

            // IIFE detection: if this function is the callee of a CallExpression, bind arguments to params
            const callParent = this.parentMap.get(node);
            const isIIFE = callParent && callParent.type === "CallExpression" && callParent.callee === node;
            if (isIIFE) {
                const callArgs = callParent.arguments || [];
                params.forEach((param, idx) => {
                    const paramName = param.type === "Identifier" ? param.name
                        : (param.type === "AssignmentPattern" && param.left && param.left.type === "Identifier") ? param.left.name
                        : "";
                    if (!paramName) return;
                    const argNode = callArgs[idx];
                    if (argNode) {
                        // Register as a def (not paramName) so it resolves through the argument
                        this.addDef(fnScope, paramName, argNode, node.start || 0);
                        // Track well-known global aliases for document/window
                        if (argNode.type === "Identifier" && GLOBAL_NAMES.has(argNode.name)) {
                            this.iifeAliases.set(paramName, argNode.name);
                        }
                    } else {
                        // No argument provided — treat as param
                        fnScope.paramNames.add(paramName);
                        if (param.type === "AssignmentPattern" && param.right && param.right.type === "Identifier" &&
                            GLOBAL_NAMES.has(param.right.name)) {
                            this.iifeAliases.set(paramName, param.right.name);
                            this.addDef(fnScope, paramName, param.right, node.start || 0);
                        }
                    }
                });
            } else {
                params.forEach(param => {
                    if (param.type === "Identifier") fnScope.paramNames.add(param.name);
                    // Default parameter: function f(x = defaultVal)
                    if (param.type === "AssignmentPattern" && param.left && param.left.type === "Identifier") {
                        fnScope.paramNames.add(param.left.name);
                    }
                });
            }
            const body = node.body && node.body.type === "BlockStatement" ? node.body.body : [node.body];
            { const b = body.filter(Boolean); for (let i = b.length - 1; i >= 0; i--) walk(b[i], fnScope, node); }
            return;
        }

        if (node.type === "MethodDefinition" && node.value) {
            const fnScope = enterScope(node.value, scope);
            this.fnScopeMap.set(node.value, fnScope);
            const params = node.value.params || [];
            params.forEach(param => {
                if (param.type === "Identifier") fnScope.paramNames.add(param.name);
                if (param.type === "AssignmentPattern" && param.left && param.left.type === "Identifier") {
                    fnScope.paramNames.add(param.left.name);
                }
            });
            const body = node.value.body && node.value.body.type === "BlockStatement" ? node.value.body.body : [node.value.body];
            { const b = body.filter(Boolean); for (let i = b.length - 1; i >= 0; i--) walk(b[i], fnScope, node.value); }
            return;
        }

        // Enqueue only real AST children: objects carrying a string `.type` (ESTree nodes), or arrays of
        // them. This deliberately skips acorn's location bookkeeping (`loc` and its `start`/`end` Position
        // objects, plus numeric `start`/`end`/`range`). Those aren't AST nodes and hold no sink info — and
        // in some concatenated bundles acorn SHARES Position objects across many nodes, so the old
        // "descend into every enumerable key" walk re-traversed that shared metadata combinatorially (a
        // single Position object was re-visited 25k+ times), making index() effectively non-terminating.
        const kids = [];
        for (const key in node) {
            if (key === "parent" || key === "loc") continue;
            const child = node[key];
            if (Array.isArray(child)) { for (const c of child) if (c && typeof c.type === "string") kids.push(c); }
            else if (child && typeof child.type === "string") kids.push(child);
        }
        for (let i = kids.length - 1; i >= 0; i--) walk(kids[i], scope, node);   // reverse -> pop in source order
    };

    const rootScope = this.createScope(null);
    walk(this.ast, rootScope, null);
    // Node-visit budget: if the walk blows past indexBudget, stop on the PARTIALLY-indexed tree. The scopes,
    // defs, and sinks collected so far stay valid, so analyze() still resolves whatever sinks were reached —
    // a partial file result instead of a hang. _budgetHit is the shared "results are partial" signal.
    let visits = 0;
    while (stack.length) {
        if (this.indexBudget && ++visits > this.indexBudget) { this._indexBudgetHit = true; this._budgetHit = true; break; }
        const [n, s, p] = stack.pop(); visit(n, s, p);
    }
}
,

findLatestDef(scope, name, pos) {
    let current = scope;
    while (current) {
        const defs = current.defs.get(name) || [];
        const candidate = defs
            .filter(def => typeof def.pos === "number" && def.pos <= pos)
            .sort((a, b) => b.pos - a.pos)[0];
        if (candidate) return { def: candidate, scope: current };
        current = current.parent;
    }
    return null;
}
,

findPrevDef(scope, name, pos) {
    let current = scope;
    while (current) {
        const defs = current.defs.get(name) || [];
        const candidate = defs
            .filter(def => typeof def.pos === "number" && def.pos < pos)
            .sort((a, b) => b.pos - a.pos)[0];
        if (candidate) return { def: candidate, scope: current };
        current = current.parent;
    }
    return null;
}
// NB: cartesianConcat lives in analyze.js (assigned last in LyNX.js, so it wins) — no duplicate here.

};
