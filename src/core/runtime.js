const { OP_BUDGET, collectReturns } = require("./shared");   // shared with resolve.js

module.exports = {

createRuntimeEnv() {
    return {
        values: new Map(),
        arrays: new Map(),
        objects: new Map(),
        urlParams: new Map(),
        functions: new Map()
    };
}
,

cloneRuntimeEnv(env) {
    // Op-budget: deep-copying a large env is a per-file hot path (the profile's cloneRuntimeEnv/
    // mergeRuntimeEnvInto self-time) and isn't gated by the expression resolver. Charge by the actual
    // DATA VOLUME copied (sum of contained value counts, not just key counts — a Set/array copy is O(its
    // size), so counting keys alone lets one clone of a huge env cost billions of copies for ~1 "op").
    // Over budget: return the env aliased (no copy). Safe because every caller is bailing too —
    // evalStatementRuntime returns [env] immediately once _budgetHit, so no cross-branch mutation happens.
    this._ops = (this._ops || 0) + this.runtimeEnvCost(env);
    if (OP_BUDGET && this._ops > OP_BUDGET) { this._budgetHit = true; return env; }
    const next = this.createRuntimeEnv();
    env.values.forEach((vals, key) => next.values.set(key, new Set(vals)));
    env.arrays.forEach((vals, key) => next.arrays.set(key, vals.map(v => [...v])));
    env.objects.forEach((vals, key) => next.objects.set(key, vals.map(v => ({ ...v }))));
    env.urlParams.forEach((vals, key) => next.urlParams.set(key, vals.map(v => ({
        keyValues: [...v.keyValues],
        valueValues: [...v.valueValues]
    }))));
    env.functions.forEach((fn, key) => next.functions.set(key, fn));
    return next;
}
,

runtimeEnvCost(env) {
    // Data volume of an env: total values across all buckets (+1 so an empty env still costs a tick).
    // O(#keys), not O(#values) — Set.size / Array.length are O(1) — so cheap to compute before a
    // clone/merge that IS O(#values).
    let cost = 1;
    env.values.forEach(s => { cost += s.size; });
    env.arrays.forEach(a => { cost += a.length; });
    env.objects.forEach(o => { cost += o.length; });
    env.urlParams.forEach(u => { cost += u.length; });
    return cost;
}
,

mergeRuntimeEnvInto(target, source) {
    // Same unbounded-work concern as cloneRuntimeEnv: merging copies the source's value sets/arrays.
    this._ops = (this._ops || 0) + this.runtimeEnvCost(source);
    if (OP_BUDGET && this._ops > OP_BUDGET) { this._budgetHit = true; return; }
    source.values.forEach((vals, key) => {
        if (!target.values.has(key)) target.values.set(key, new Set());
        vals.forEach(v => target.values.get(key).add(v));
    });
    source.arrays.forEach((vals, key) => {
        if (!target.arrays.has(key)) target.arrays.set(key, vals.map(v => [...v]));
    });
    source.objects.forEach((vals, key) => {
        if (!target.objects.has(key)) target.objects.set(key, vals.map(v => ({ ...v })));
    });
    source.urlParams.forEach((vals, key) => {
        if (!target.urlParams.has(key)) target.urlParams.set(key, []);
        const bucket = target.urlParams.get(key);
        vals.forEach(v => bucket.push({ keyValues: [...v.keyValues], valueValues: [...v.valueValues] }));
    });
    source.functions.forEach((fn, key) => {
        if (!target.functions.has(key)) target.functions.set(key, fn);
    });
}
,

getRuntimeMemberPropertyName(memberExpr, env, pos=0) {
    if (!memberExpr || memberExpr.type !== "MemberExpression") return "";
    if (memberExpr.computed) {
        return this.resolveExpressionRuntime(memberExpr.property, env, pos)[0];
    }
    return this.getName(memberExpr.property);
}
,

isRuntimeStringPassthroughMethod(name) {
    return /^(trim|trimStart|trimEnd|toLowerCase|toUpperCase|slice|substring|substr|normalize)$/.test(name);
}
,

mergeRuntimeEnvs(envs) {
    if (envs.length <= this.maxCombos) return envs;
    const merged = this.createRuntimeEnv();
    envs.forEach(env => this.mergeRuntimeEnvInto(merged, env));
    return [merged];
}
,

mergeAllRuntimeEnvs(envs) {
    if (!envs || envs.length === 0) return this.createRuntimeEnv();
    if (envs.length === 1) return envs[0];
    const merged = this.createRuntimeEnv();
    envs.forEach(env => this.mergeRuntimeEnvInto(merged, env));
    return merged;
}
,

resolveExpressionRuntime(node, env, pos=0) {
    if (!node) return [""];
    // Depth guard (mirrors resolveExpression): deep +/||/nested chains in minified bundles would
    // overflow this mutual recursion. Degrade to "" past the cap instead of crashing the whole file.
    this._rtDepth = (this._rtDepth || 0) + 1;
    if (this._rtDepth > 300) { this._rtDepth--; return [""]; }
    this._ops = (this._ops || 0) + 1;
    if (OP_BUDGET && this._ops > OP_BUDGET) { this._budgetHit = true; this._rtDepth--; return [""]; }   // global-budget bail
    try {
    switch (node.type) {
        case "Literal": return [String(node.value)];
        case "Identifier": {
            if (!env.values.has(node.name)) return [`{VAR:${node.name}}`];
            return [...env.values.get(node.name)];
        }
        case "TemplateLiteral": {
            const parts = [];
            node.quasis.forEach((q, idx) => {
                parts.push([q.value.cooked || ""]);
                if (node.expressions[idx]) {
                    parts.push(this.resolveExpressionRuntime(node.expressions[idx], env, pos));
                }
            });
            return parts.reduce((acc, part) => this.cartesianConcat(acc, part), [""]);
        }
        case "TaggedTemplateExpression": return this.resolveExpressionRuntime(node.quasi, env, pos);   // tag as identity
        case "BinaryExpression": {
            if (node.operator !== "+") return [""];
            const left = this.resolveExpressionRuntime(node.left, env, pos);
            const right = this.resolveExpressionRuntime(node.right, env, pos);
            return this.cartesianConcat(left, right);
        }
        case "ConditionalExpression": {
            const left = this.resolveExpressionRuntime(node.consequent, env, pos);
            const right = this.resolveExpressionRuntime(node.alternate, env, pos);
            return [...new Set([...left, ...right])].slice(0, this.maxCombos);
        }
        case "LogicalExpression": {
            const left = this.resolveExpressionRuntime(node.left, env, pos);
            const right = this.resolveExpressionRuntime(node.right, env, pos);
            if (node.operator === "??") {
                const filtered = left.filter(v => v !== "null" && v !== "undefined" && v !== null && v !== undefined);
                if (filtered.length === 0) return right;
                return [...new Set([...filtered, ...right])].slice(0, this.maxCombos);
            }
            return [...new Set([...left, ...right])].slice(0, this.maxCombos);
        }
        case "MemberExpression": {
            const memberName = this.getName(node);
            if (memberName) {
                 const fnNode = this.findLatestMemberDef(memberName, pos);
                 if (fnNode) return [`{FUNC:${memberName}:${fnNode.start || 0}}`];
            }

            if (node.computed && node.object && node.object.type === "Identifier") {
                const arrName = node.object.name;
                if (env.arrays.has(arrName)) {
                    const indexValues = this.resolveExpressionRuntime(node.property, env, pos);
                    const elements = env.arrays.get(arrName) || [];
                    const resolved = [];
                    indexValues.forEach(idx => {
                        const numeric = Number(idx);
                        if (Number.isInteger(numeric) && elements[numeric]) {
                            elements[numeric].forEach(val => resolved.push(val));
                        }
                    });
                    if (resolved.length > 0) return [...new Set(resolved)];
                }
            }
            // Handle inline ObjectExpression computed access: ({key:val,...})[param]
            if (node.computed && node.object && node.object.type === "ObjectExpression") {
                const entries = (node.object.properties || [])
                    .filter(prop => prop && prop.key)
                    .map(prop => {
                        const key = prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value || "");
                        return { key, valueNode: prop.value };
                    })
                    .filter(entry => entry.key);
                if (entries.length > 0) {
                    const keyValues = this.resolveExpressionRuntime(node.property, env, pos);
                    const resolved = [];
                    keyValues.forEach(key => {
                        entries.forEach(entry => {
                            if (entry.key === key) {
                                this.resolveExpressionRuntime(entry.valueNode, env, pos)
                                    .forEach(val => resolved.push(val));
                            }
                        });
                    });
                    // If key is placeholder, return all values
                    if (resolved.length === 0 && keyValues.some(v => typeof v === "string" && v.startsWith("{VAR:"))) {
                        entries.forEach(entry => {
                            this.resolveExpressionRuntime(entry.valueNode, env, pos)
                                .forEach(val => resolved.push(val));
                        });
                    }
                    if (resolved.length > 0) return [...new Set(resolved)].slice(0, this.maxCombos);
                }
            }
            if (node.object && node.object.type === "NewExpression") {
                const calleeName = this.getName(node.object.callee);
                const propName = this.getRuntimeMemberPropertyName(node, env, pos);
                if (calleeName === "URL" && propName) {
                    const argNode = node.object.arguments && node.object.arguments[0];
                    const argValues = this.resolveExpressionRuntime(argNode, env, pos);
                    const resolved = argValues.map(val => this.resolveUrlProperty(val, propName)).filter(Boolean);
                    if (resolved.length > 0) return [...new Set(resolved)];
                    const placeholder = argValues.length ? argValues.join("|") : "";
                    return placeholder ? [`{VAR:URL.${propName}(${placeholder})}`] : [""];
                }
            }
            const name = this.getName(node);
            return [name ? `{VAR:${name}}` : ""];
        }
        case "CallExpression": {
            const calleeName = this.getName(node.callee);
            if (calleeName === "encodeURIComponent" || calleeName === "decodeURIComponent" || calleeName === "String") {
                const arg = node.arguments && node.arguments[0];
                return arg ? this.resolveExpressionRuntime(arg, env, pos) : [""];
            }
            if (node.callee && node.callee.type === "Identifier" && env.functions.has(node.callee.name)) {
                const fnNode = env.functions.get(node.callee.name);
                return this.resolveFunctionReturnRuntime(fnNode, env, node.arguments || []);
            }
            if (node.callee && node.callee.type === "Identifier" && env.values.has(node.callee.name)) {
                const vals = [...env.values.get(node.callee.name)];
                if (vals.length === 1) {
                    const val = vals[0];
                    if (typeof val === "string" && val.startsWith("{FUNC:")) {
                         const match = val.match(/^\{FUNC:([^:]+):(\d+)\}$/);
                         if (match) {
                             const memberName = match[1];
                             const fnPos = parseInt(match[2], 10);
                             const fnNode = this.findMemberDefByPos(memberName, fnPos);
                             if (fnNode) return this.resolveFunctionReturnRuntime(fnNode, env, node.arguments || []);
                         }
                    }
                    const memberName = this.extractPlaceholderVarName(val);
                    if (memberName) {
                        const fnNode = this.findLatestMemberDef(memberName, pos); // Use current pos
                        if (fnNode) return this.resolveFunctionReturnRuntime(fnNode, env, node.arguments || []);
                        const parts = memberName.split(".");
                        const propName = parts.length > 1 ? parts[parts.length - 1] : "";
                        const objName = parts.length > 1 ? parts.slice(0, -1).join(".") : "";
                        const fallbackFn = this.findLatestMemberDefByProp(propName, objName || "b", pos);
                        if (fallbackFn) return this.resolveFunctionReturnRuntime(fallbackFn, env, node.arguments || []);
                    }
                }
            }
            if (node.callee && node.callee.type === "MemberExpression") {
                const memberName = this.getName(node.callee);
                if (memberName) {
                    const fnNode = this.findLatestMemberDef(memberName, pos);
                    if (fnNode) return this.resolveFunctionReturnRuntime(fnNode, env, node.arguments || []);
                    const propName = this.getRuntimeMemberPropertyName(node.callee, env, pos);
                    const objName = this.getName(node.callee.object);
                    const fallbackFn = this.findLatestMemberDefByProp(propName, objName || "b", pos);
                    if (fallbackFn) return this.resolveFunctionReturnRuntime(fallbackFn, env, node.arguments || []);
                }
            }
            if (node.callee && node.callee.type === "MemberExpression") {
                const propName = this.getRuntimeMemberPropertyName(node.callee, env, pos);
                const objName = this.getName(node.callee.object);
                if (propName === "toString" && objName && env.urlParams.has(objName)) {
                    return this.buildQueryStrings(env.urlParams.get(objName));
                }
                if (this.isRuntimeStringPassthroughMethod(propName)) {
                    return this.resolveExpressionRuntime(node.callee.object, env, pos);
                }
                // .replace(pattern, replacement) / .replaceAll(pattern, replacement) with literal args
                if ((propName === "replace" || propName === "replaceAll") && node.arguments && node.arguments.length >= 2) {
                    const baseVals = this.resolveExpressionRuntime(node.callee.object, env, pos);
                    const patternArg = node.arguments[0];
                    const replArg = node.arguments[1];
                    if (patternArg && patternArg.type === "Literal" && typeof patternArg.value === "string" &&
                        replArg && replArg.type === "Literal" && typeof replArg.value === "string") {
                        return baseVals.map(val => {
                            if (typeof val !== "string" || val.startsWith("{VAR:") || val.startsWith("{CALL:")) return val;
                            return propName === "replaceAll"
                                ? val.split(patternArg.value).join(replArg.value)
                                : val.replace(patternArg.value, replArg.value);
                        });
                    }
                    // Non-literal pattern: just passthrough base
                    return baseVals;
                }
                if (propName === "concat") {
                    const base = this.resolveExpressionRuntime(node.callee.object, env, pos);
                    let result = base;
                    (node.arguments || []).forEach(arg => {
                        const argVals = this.resolveExpressionRuntime(arg, env, pos);
                        result = this.cartesianConcat(result, argVals);
                    });
                    return result;
                }
                if (propName === "join") {
                    // Try to resolve as array join - return placeholder since we can't know separator perfectly
                    return this.resolveExpressionRuntime(node.callee.object, env, pos);
                }
            }
            return [`{CALL:${calleeName || "anonymous"}}`];
        }
        case "NewExpression": {
            const calleeName = this.getName(node.callee);
            if (calleeName === "URLSearchParams") {
                const entries = this.resolveObjectEntriesFromRuntime(node.arguments && node.arguments[0], env);
                const params = [];
                entries.forEach(entry => {
                    params.push({
                        keyValues: [entry.key],
                        valueValues: this.resolveExpressionRuntime(entry.valueNode, env, pos)
                    });
                });
                return this.buildQueryStrings(params);
            }
            return [""];
        }
        case "ParenthesizedExpression": return this.resolveExpressionRuntime(node.expression, env, pos);
        case "SequenceExpression": {
            const last = node.expressions[node.expressions.length - 1];
            return this.resolveExpressionRuntime(last, env, pos);
        }
        // Optional chaining: obj?.prop, obj?.[expr], obj?.()
        case "ChainExpression": return this.resolveExpressionRuntime(node.expression, env, pos);
        // Unary expressions: void 0, typeof x, !x
        case "UnaryExpression": {
            if (node.operator === "void") return ["undefined"];
            return this.resolveExpressionRuntime(node.argument, env, pos);
        }
        // AssignmentExpression: x = val (returns the assigned value)
        case "AssignmentExpression": {
            if (node.left && node.left.type === "Identifier") {
                const values = this.resolveExpressionRuntime(node.right, env, pos);
                this.setRuntimeVar(env, node.left.name, values, node.operator);
                return values;
            }
            return this.resolveExpressionRuntime(node.right, env, pos);
        }
        default: return [""];
    }
    } finally { this._rtDepth--; }
}
,

setRuntimeVar(env, name, values, op) {
    if (!env.values.has(name)) env.values.set(name, new Set());
    const current = env.values.get(name);
    if (op === "+=") {
        const base = [...current];
        const next = this.cartesianConcat(base.length ? base : [""], values);
        env.values.set(name, new Set(next));
    } else {
        env.values.set(name, new Set(values));
    }
}
,

resolveArrayElementsFromRuntime(node, env) {
    if (!node) return [];
    if (node.type === "ArrayExpression") {
        return (node.elements || []).filter(Boolean).map(el => this.resolveExpressionRuntime(el, env));
    }
    if (node.type === "Identifier" && env.arrays.has(node.name)) {
        return env.arrays.get(node.name);
    }
    return [];
}
,

resolveObjectEntriesFromRuntime(node, env) {
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
    if (node.type === "Identifier" && env.objects.has(node.name)) {
        return env.objects.get(node.name).map(entry => ({ ...entry }));
    }
    return [];
}
,

resolveFunctionReturnRuntime(fnNode, env, argNodes) {
    if (!fnNode) return [""];
    const localEnv = this.cloneRuntimeEnv(env);
    const params = fnNode.params || [];
    const pos = fnNode.start || 0;
    
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
        // Resolve arguments in CALLER's environment
        const values = this.resolveExpressionRuntime(argNode, localEnv, 0);
        // If no argument provided and there's a default value, use both
        if (!argNode && defaultNode) {
            const defaultValues = this.resolveExpressionRuntime(defaultNode, localEnv, 0);
            this.setRuntimeVar(localEnv, paramName, defaultValues, "=");
        } else {
            this.setRuntimeVar(localEnv, paramName, values, "=");
        }
    });

    if (params.length === 1) {
        const paramName = params[0].type === "Identifier" ? params[0].name 
            : (params[0].type === "AssignmentPattern" && params[0].left && params[0].left.type === "Identifier" ? params[0].left.name : "");
        const overrideValues = localEnv.values.has(paramName) ? [...localEnv.values.get(paramName)] : [];
        const isPlaceholder = (val) => typeof val === "string" && val.startsWith("{VAR:");
        if (paramName && overrideValues.length === 1 && isPlaceholder(overrideValues[0])) {
            const condInfo = this.extractConditionalMap(fnNode, paramName);
            if (condInfo && (condInfo.map.size > 0 || condInfo.defaultNode)) {
                let expanded = [];
                condInfo.map.forEach((node, key) => {
                    const nextEnv = this.cloneRuntimeEnv(localEnv);
                    this.setRuntimeVar(nextEnv, paramName, [String(key)], "=");
                    expanded = expanded.concat(this.resolveExpressionRuntime(node, nextEnv, pos));
                });
                if (condInfo.defaultNode) {
                    const objMapKeys = this.extractObjectMapKeys(condInfo.defaultNode, paramName);
                    if (objMapKeys.length > 0) {
                        objMapKeys.forEach(key => {
                            const nextEnv = this.cloneRuntimeEnv(localEnv);
                            this.setRuntimeVar(nextEnv, paramName, [String(key)], "=");
                            expanded = expanded.concat(this.resolveExpressionRuntime(condInfo.defaultNode, nextEnv, pos));
                        });
                    } else {
                        expanded = expanded.concat(this.resolveExpressionRuntime(condInfo.defaultNode, localEnv, pos));
                    }
                }
                expanded = expanded.filter(val => val !== "");
                return expanded.length ? [...new Set(expanded)] : [""];
            }
        }
    }
    const returns = [];
    if (fnNode.type === "ArrowFunctionExpression" && fnNode.body && fnNode.body.type !== "BlockStatement") {
         returns.push(fnNode.body);
    } else {
         returns.push(...collectReturns(fnNode.body || fnNode));
    }

    let results = [];
    returns.forEach(ret => {
        results = results.concat(this.resolveExpressionRuntime(ret, localEnv, pos));
    });
    results = results.filter(val => val !== "");
    return results.length ? [...new Set(results)] : [""];
}
,

handleObjectEntriesForEachRuntime(callExpr, env) {
    if (!callExpr || callExpr.type !== "CallExpression") return false;
    if (!callExpr.callee || callExpr.callee.type !== "MemberExpression") return false;
    const propName = this.getRuntimeMemberPropertyName(callExpr.callee, env, 0);
    if (propName !== "forEach") return false;
    const objCall = callExpr.callee.object;
    if (!objCall || objCall.type !== "CallExpression") return false;
    const objCallee = this.getName(objCall.callee);
    if (objCallee !== "Object.entries") return false;
    const entries = this.resolveObjectEntriesFromRuntime(objCall.arguments[0], env);
    if (!entries.length) return false;
    const callback = callExpr.arguments && callExpr.arguments[0];
    if (!callback || (callback.type !== "FunctionExpression" && callback.type !== "ArrowFunctionExpression")) return false;

    let keyParam = null;
    let valueParam = null;
    if (callback.params[0] && callback.params[0].type === "Identifier") {
        keyParam = callback.params[0].name;
        valueParam = callback.params[1] && callback.params[1].type === "Identifier" ? callback.params[1].name : null;
    } else if (callback.params[0] && callback.params[0].type === "ArrayPattern") {
        const elements = callback.params[0].elements || [];
        keyParam = elements[0] && elements[0].type === "Identifier" ? elements[0].name : null;
        valueParam = elements[1] && elements[1].type === "Identifier" ? elements[1].name : null;
    }
    if (!keyParam || !valueParam) return false;

    let appended = false;
    const scan = (node) => {
        if (!node || typeof node !== "object") return;
        if (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
            const appendProp = this.getRuntimeMemberPropertyName(node.callee, env, 0);
            const targetName = this.getName(node.callee.object);
            if (appendProp === "append" && targetName &&
                node.arguments[0] && node.arguments[0].type === "Identifier" &&
                node.arguments[1] && node.arguments[1].type === "Identifier" &&
                node.arguments[0].name === keyParam && node.arguments[1].name === valueParam) {
                if (env.urlParams.has(targetName)) {
                    entries.forEach(entry => {
                        const keyValues = [entry.key];
                        const valueValues = this.resolveExpressionRuntime(entry.valueNode, env);
                        if (valueValues.length) {
                            env.urlParams.get(targetName).push({
                                keyValues: [...keyValues],
                                valueValues: [...valueValues]
                            });
                        }
                    });
                    appended = true;
                }
            }
        }
        for (const k in node) {
            if (k === "parent") continue;
            const child = node[k];
            if (Array.isArray(child)) child.forEach(c => scan(c));
            else scan(child);
        }
    };
    scan(callback.body);
    return appended;
}
,

evalStatementRuntime(stmt, env) {
    if (!stmt) return [env];
    // Op-budget: statement interpretation (branch fan-out + the env cloning below) is the OTHER unbounded
    // cost besides expression resolution — a big loop-unroll or many-branch block clones envs thousands of
    // times without re-entering resolveExpressionRuntime, so its budget check never fires. Charge + bail
    // here too; over budget, degrade to a pass-through env instead of hanging. Mirrors resolveExpressionRuntime.
    this._ops = (this._ops || 0) + 1;
    if (OP_BUDGET && this._ops > OP_BUDGET) { this._budgetHit = true; return [env]; }
    const pos = stmt.start || 0;

    if (stmt.type === "VariableDeclaration") {
        stmt.declarations.forEach(decl => {
            // Handle destructuring: const { a, b } = obj
            if (decl.id && decl.id.type === "ObjectPattern" && decl.init) {
                const initValues = this.resolveExpressionRuntime(decl.init, env, pos);
                // Try to get object entries from the init node
                const entries = this.resolveObjectEntriesFromRuntime(decl.init, env);
                (decl.id.properties || []).forEach(prop => {
                    if (!prop || !prop.value || prop.value.type !== "Identifier") return;
                    const keyName = prop.key && prop.key.type === "Identifier" ? prop.key.name : (prop.key && prop.key.type === "Literal" ? String(prop.key.value) : "");
                    if (!keyName) return;
                    const entry = entries.find(e => e.key === keyName);
                    if (entry) {
                        const vals = this.resolveExpressionRuntime(entry.valueNode, env, pos);
                        this.setRuntimeVar(env, prop.value.name, vals, "=");
                    } else {
                        this.setRuntimeVar(env, prop.value.name, [`{VAR:${prop.value.name}}`], "=");
                    }
                });
                return;
            }
            // Handle destructuring: const [x, y] = arr
            if (decl.id && decl.id.type === "ArrayPattern" && decl.init) {
                const elements = this.resolveArrayElementsFromRuntime(decl.init, env);
                (decl.id.elements || []).forEach((el, idx) => {
                    if (!el || el.type !== "Identifier") return;
                    if (elements[idx]) {
                        this.setRuntimeVar(env, el.name, elements[idx], "=");
                    } else {
                        this.setRuntimeVar(env, el.name, [`{VAR:${el.name}}`], "=");
                    }
                });
                return;
            }
            if (!decl.id || decl.id.type !== "Identifier") return;
            if (decl.init && (decl.init.type === "FunctionExpression" || decl.init.type === "ArrowFunctionExpression")) {
                env.functions.set(decl.id.name, decl.init);
            }
            if (decl.init && decl.init.type === "ArrayExpression") {
                const elements = this.resolveArrayElementsFromRuntime(decl.init, env);
                env.arrays.set(decl.id.name, elements);
                this.setRuntimeVar(env, decl.id.name, [`{VAR:${decl.id.name}}`], "=");
                return;
            }
            if (decl.init && decl.init.type === "ObjectExpression") {
                const entries = this.resolveObjectEntriesFromRuntime(decl.init, env);
                env.objects.set(decl.id.name, entries);
                this.setRuntimeVar(env, decl.id.name, [`{VAR:${decl.id.name}}`], "=");
                return;
            }
            if (decl.init && decl.init.type === "NewExpression" && this.getName(decl.init.callee) === "URLSearchParams") {
                if (!env.urlParams.has(decl.id.name)) env.urlParams.set(decl.id.name, []);
                this.setRuntimeVar(env, decl.id.name, [`{VAR:${decl.id.name}}`], "=");
                return;
            }
            const values = this.resolveExpressionRuntime(decl.init, env, pos);
            this.setRuntimeVar(env, decl.id.name, values, "=");
        });
        return [env];
    }

    if (stmt.type === "ExpressionStatement") {
        const expr = stmt.expression;
        if (expr.type === "AssignmentExpression" && expr.left.type === "Identifier") {
            if (expr.right && (expr.right.type === "FunctionExpression" || expr.right.type === "ArrowFunctionExpression")) {
                env.functions.set(expr.left.name, expr.right);
            }
            if (expr.right && expr.right.type === "ArrayExpression") {
                const elements = this.resolveArrayElementsFromRuntime(expr.right, env);
                env.arrays.set(expr.left.name, elements);
                this.setRuntimeVar(env, expr.left.name, [`{VAR:${expr.left.name}}`], "=");
                return [env];
            }
            if (expr.right && expr.right.type === "ObjectExpression") {
                const entries = this.resolveObjectEntriesFromRuntime(expr.right, env);
                env.objects.set(expr.left.name, entries);
                this.setRuntimeVar(env, expr.left.name, [`{VAR:${expr.left.name}}`], "=");
                return [env];
            }
            if (expr.right && expr.right.type === "NewExpression" && this.getName(expr.right.callee) === "URLSearchParams") {
                if (!env.urlParams.has(expr.left.name)) env.urlParams.set(expr.left.name, []);
                this.setRuntimeVar(env, expr.left.name, [`{VAR:${expr.left.name}}`], "=");
                return [env];
            }
            const values = this.resolveExpressionRuntime(expr.right, env, pos);
            this.setRuntimeVar(env, expr.left.name, values, expr.operator);
        }
        if (expr.type === "CallExpression") {
            if (this.handleObjectEntriesForEachRuntime(expr, env)) return [env];
            // Handle array.forEach(callback) and array.map(callback)
            if (expr.callee && expr.callee.type === "MemberExpression") {
                    const propName = this.getRuntimeMemberPropertyName(expr.callee, env, pos);
                if (/^(forEach|map|filter|find|some|every|reduce|flatMap)$/.test(propName)) {
                    const callback = expr.arguments && expr.arguments[0];
                    if (callback && (callback.type === "FunctionExpression" || callback.type === "ArrowFunctionExpression")) {
                        const arrName = this.getName(expr.callee.object);
                        if (arrName && env.arrays.has(arrName)) {
                            const elements = env.arrays.get(arrName) || [];
                            const cbParam = callback.params && callback.params[0];
                            const idxParam = callback.params && callback.params[1];
                            if (cbParam && cbParam.type === "Identifier") {
                                elements.forEach((elementValues, idx) => {
                                    const iterEnv = this.cloneRuntimeEnv(env);
                                    this.setRuntimeVar(iterEnv, cbParam.name, elementValues, "=");
                                    if (idxParam && idxParam.type === "Identifier") {
                                        this.setRuntimeVar(iterEnv, idxParam.name, [String(idx)], "=");
                                    }
                                    const bodyStmts = callback.body && callback.body.type === "BlockStatement" ? callback.body.body : [callback.body];
                                    this.evalBlockRuntime(bodyStmts.filter(Boolean), iterEnv);
                                });
                            }
                        }
                    }
                }
            }
            if (expr.callee && expr.callee.type === "MemberExpression") {
                    const propName = this.getRuntimeMemberPropertyName(expr.callee, env, pos);
                const objName = this.getName(expr.callee.object);
                if (propName === "append" && objName && env.urlParams.has(objName)) {
                    const keyValues = this.resolveExpressionRuntime(expr.arguments[0], env, pos);
                    const valueValues = this.resolveExpressionRuntime(expr.arguments[1], env, pos);
                    if (keyValues.length && valueValues.length) {
                        env.urlParams.get(objName).push({
                            keyValues: [...keyValues],
                            valueValues: [...valueValues]
                        });
                    }
                }
            }
        }
        return [env];
    }

    if (stmt.type === "BlockStatement") {
        return this.evalBlockRuntime(stmt.body, env);
    }

    if (stmt.type === "IfStatement") {
        const branches = [];
        const thenEnv = this.cloneRuntimeEnv(env);
        const thenBody = stmt.consequent.type === "BlockStatement" ? stmt.consequent.body : [stmt.consequent];
        branches.push(...this.evalBlockRuntime(thenBody, thenEnv));
        const elseEnv = this.cloneRuntimeEnv(env);
        if (stmt.alternate) {
            const elseBody = stmt.alternate.type === "BlockStatement" ? stmt.alternate.body : [stmt.alternate];
            branches.push(...this.evalBlockRuntime(elseBody, elseEnv));
        } else {
            branches.push(elseEnv);
        }
        return branches;
    }

    // SwitchStatement: treat each case as a branch (like if/else)
    if (stmt.type === "SwitchStatement") {
        const branches = [];
        const cases = stmt.cases || [];
        cases.forEach(caseNode => {
            const caseEnv = this.cloneRuntimeEnv(env);
            // If discriminant is a simple identifier and test is a literal, bind it
            if (stmt.discriminant && stmt.discriminant.type === "Identifier" && caseNode.test && caseNode.test.type === "Literal") {
                this.setRuntimeVar(caseEnv, stmt.discriminant.name, [String(caseNode.test.value)], "=");
            }
            const bodyStmts = (caseNode.consequent || []).filter(s => s && s.type !== "BreakStatement");
            if (bodyStmts.length > 0) {
                branches.push(...this.evalBlockRuntime(bodyStmts, caseEnv));
            } else {
                branches.push(caseEnv);
            }
        });
        // Also consider the case where none match (pass through)
        if (!cases.some(c => c.test === null)) {
            branches.push(this.cloneRuntimeEnv(env));
        }
        return branches.length > 0 ? branches : [env];
    }

    if (stmt.type === "ForOfStatement") {
        const left = stmt.left;
        let loopVar = "";
        if (left && left.type === "VariableDeclaration" && left.declarations[0] && left.declarations[0].id.type === "Identifier") {
            loopVar = left.declarations[0].id.name;
        } else if (left && left.type === "Identifier") {
            loopVar = left.name;
        }
        if (!loopVar) return [env];
        const elements = this.resolveArrayElementsFromRuntime(stmt.right, env);
        if (!elements.length) return [env];
        let envs = [env];
        for (const elementValues of elements) {
            if (this._budgetHit) break;   // op-budget exhausted — stop unrolling
            const next = [];
            envs.forEach(current => {
                elementValues.forEach(val => {
                    const iterEnv = this.cloneRuntimeEnv(current);
                    this.setRuntimeVar(iterEnv, loopVar, [val], "=");
                    const bodyStmts = stmt.body.type === "BlockStatement" ? stmt.body.body : [stmt.body];
                    next.push(...this.evalBlockRuntime(bodyStmts, iterEnv));
                });
            });
            envs = this.mergeRuntimeEnvs(next);
        }
        return envs;
    }

    if (stmt.type === "ForStatement") {
        const init = stmt.init;
        let loopVar = "";
        let start = null;
        if (init && init.type === "VariableDeclaration" && init.declarations[0] && init.declarations[0].id.type === "Identifier") {
            loopVar = init.declarations[0].id.name;
            start = this.resolveExpressionRuntime(init.declarations[0].init, env, pos)[0];
        } else if (init && init.type === "AssignmentExpression" && init.left.type === "Identifier") {
            loopVar = init.left.name;
            start = this.resolveExpressionRuntime(init.right, env, pos)[0];
        }

        const test = stmt.test;
        let arrName = "";
        let isAscending = false;
        if (test && test.type === "BinaryExpression" && (test.operator === ">=" || test.operator === ">")) {
            if (test.left.type === "Identifier" && test.left.name === loopVar &&
                test.right.type === "Literal" && test.right.value === 0) {
                arrName = this.getArrayNameFromLengthExpr(init && init.declarations ? init.declarations[0].init : init && init.right, env);
            }
            // Handle i-- > 0 pattern (decrement embedded in test)
            if (test.left.type === "UpdateExpression" && test.left.operator === "--" &&
                test.left.argument && test.left.argument.type === "Identifier" && test.left.argument.name === loopVar &&
                test.right.type === "Literal" && test.right.value === 0) {
                arrName = this.getArrayNameFromLengthExpr(init && init.declarations ? init.declarations[0].init : init && init.right, env);
            }
        }
        if (test && test.type === "BinaryExpression" && (test.operator === "<" || test.operator === "<=")) {
            if (test.left.type === "Identifier" && test.left.name === loopVar) {
                arrName = this.getArrayNameFromLengthMember(test.right, env);
                isAscending = arrName !== "";
            }
        }

        const update = stmt.update;
        const isDecrement = update && ((update.type === "UpdateExpression" && update.operator === "--") ||
            (update.type === "AssignmentExpression" && update.operator === "-=" && update.right.type === "Literal" && update.right.value === 1));
        const isIncrement = update && ((update.type === "UpdateExpression" && update.operator === "++") ||
            (update.type === "AssignmentExpression" && update.operator === "+=" && update.right.type === "Literal" && update.right.value === 1));
        // Also detect decrement embedded in test (i-- > 0): update is null but decrement happens in test
        const testHasDecrement = !update && test && test.type === "BinaryExpression" &&
            test.left && test.left.type === "UpdateExpression" && test.left.operator === "--";

        if (loopVar && arrName && (isDecrement || testHasDecrement) && env.arrays.has(arrName)) {
            const elements = env.arrays.get(arrName) || [];
            const bodyStmts = stmt.body.type === "BlockStatement" ? stmt.body.body : [stmt.body];
            let envs = [env];
            for (let idx = elements.length - 1; idx >= 0; idx -= 1) {
                if (this._budgetHit) break;   // op-budget exhausted — stop unrolling
                const next = [];
                envs.forEach(current => {
                    const iterEnv = this.cloneRuntimeEnv(current);
                    this.setRuntimeVar(iterEnv, loopVar, [String(idx)], "=");
                    next.push(...this.evalBlockRuntime(bodyStmts, iterEnv));
                });
                envs = this.mergeRuntimeEnvs(next);
            }
            return envs;
        }

        if (loopVar && arrName && isAscending && isIncrement && env.arrays.has(arrName)) {
            const elements = env.arrays.get(arrName) || [];
            const bodyStmts = stmt.body.type === "BlockStatement" ? stmt.body.body : [stmt.body];
            let envs = [env];
            for (let idx = 0; idx < elements.length; idx += 1) {
                if (this._budgetHit) break;   // op-budget exhausted — stop unrolling
                const next = [];
                envs.forEach(current => {
                    const iterEnv = this.cloneRuntimeEnv(current);
                    this.setRuntimeVar(iterEnv, loopVar, [String(idx)], "=");
                    next.push(...this.evalBlockRuntime(bodyStmts, iterEnv));
                });
                envs = this.mergeRuntimeEnvs(next);
            }
            return envs;
        }
    }

    // WhileStatement / DoWhileStatement: execute body once (conservative)
    if (stmt.type === "WhileStatement" || stmt.type === "DoWhileStatement") {
        const bodyStmts = stmt.body && stmt.body.type === "BlockStatement" ? stmt.body.body : [stmt.body];
        const loopEnv = this.cloneRuntimeEnv(env);
        const results = this.evalBlockRuntime(bodyStmts.filter(Boolean), loopEnv);
        // Return both the loop-executed env and the original (may never enter loop for while)
        if (stmt.type === "WhileStatement") {
            return [...results, this.cloneRuntimeEnv(env)];
        }
        return results; // do-while always executes at least once
    }

    // TryStatement: evaluate try block, also consider catch block
    if (stmt.type === "TryStatement") {
        const branches = [];
        if (stmt.block) {
            const tryBody = stmt.block.body || [];
            branches.push(...this.evalBlockRuntime(tryBody, this.cloneRuntimeEnv(env)));
        }
        if (stmt.handler && stmt.handler.body) {
            const catchBody = stmt.handler.body.body || [];
            branches.push(...this.evalBlockRuntime(catchBody, this.cloneRuntimeEnv(env)));
        }
        if (stmt.finalizer) {
            // Finalizer always runs — apply to all branches
            const finalizerBody = stmt.finalizer.body || [];
            const finalBranches = [];
            branches.forEach(branchEnv => {
                finalBranches.push(...this.evalBlockRuntime(finalizerBody, branchEnv));
            });
            return finalBranches.length ? finalBranches : branches;
        }
        return branches.length ? branches : [env];
    }

    // ReturnStatement: evaluate the argument expression for side effects / tracking
    if (stmt.type === "ReturnStatement" && stmt.argument) {
        this.resolveExpressionRuntime(stmt.argument, env, pos);
        return [env];
    }

    return [env];
}
,

getArrayNameFromLengthExpr(node, env) {
    if (!node) return "";
    // Handle arr.length - 1
    if (node.type === "BinaryExpression" && node.operator === "-") {
        const left = node.left;
        if (left && left.type === "MemberExpression" && !left.computed && left.property.type === "Identifier" && left.property.name === "length") {
            const objName = this.getName(left.object);
            if (objName && env.arrays.has(objName)) return objName;
        }
    }
    // Handle arr.length directly (e.g., for (let i = arr.length; i-- > 0;))
    if (node.type === "MemberExpression" && !node.computed && node.property && node.property.type === "Identifier" && node.property.name === "length") {
        const objName = this.getName(node.object);
        if (objName && env.arrays.has(objName)) return objName;
    }
    return "";
}
,

getArrayNameFromLengthMember(node, env) {
    if (!node || node.type !== "MemberExpression") return "";
    if (node.computed) return "";
    if (!node.property || node.property.type !== "Identifier" || node.property.name !== "length") return "";
    const objName = this.getName(node.object);
    if (objName && env.arrays.has(objName)) return objName;
    return "";
}
,

evalBlockRuntime(statements, env) {
    let envs = [env];
    for (const stmt of statements) {
        if (this._budgetHit) break;   // op-budget exhausted — stop expanding further statements
        const next = [];
        envs.forEach(current => {
            next.push(...this.evalStatementRuntime(stmt, current));
        });
        envs = this.mergeRuntimeEnvs(next);
    }
    return envs;
}
,

getRuntimeEnvForFunction(fnNode) {
    if (!fnNode) return null;
    if (this.runtimeEnvCache.has(fnNode)) return this.runtimeEnvCache.get(fnNode);
    const bodyStmts = fnNode.body && fnNode.body.type === "BlockStatement" ? fnNode.body.body : [fnNode.body];
    const envs = this.evalBlockRuntime(bodyStmts.filter(Boolean), this.createRuntimeEnv());
    const merged = this.mergeAllRuntimeEnvs(envs);
    this.runtimeEnvCache.set(fnNode, merged);
    return merged;
}
,

getRuntimeEnvForProgram() {
    const program = this.ast;
    if (!program || program.type !== "Program") return null;
    if (this.runtimeEnvCache.has(program)) return this.runtimeEnvCache.get(program);
    const envs = this.evalBlockRuntime(program.body || [], this.createRuntimeEnv());
    const merged = this.mergeAllRuntimeEnvs(envs);
    this.runtimeEnvCache.set(program, merged);
    return merged;
}
,

getRuntimeEnvForNodeChain(node) {
    const envs = [];
    const programEnv = this.getRuntimeEnvForProgram();
    if (programEnv) envs.push(programEnv);
    let current = node;
    while (current) {
        if (current.type === "FunctionDeclaration" || current.type === "FunctionExpression" || current.type === "ArrowFunctionExpression") {
            const fnEnv = this.getRuntimeEnvForFunction(current);
            if (fnEnv) envs.push(fnEnv);
        }
        current = this.parentMap.get(current);
    }
    return this.mergeAllRuntimeEnvs(envs);
}
,

};
