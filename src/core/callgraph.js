const { MAX_VARIANTS_PER_STRUCT } = require("./shared");

module.exports = {

recordInterproceduralSink(entry, overrides, runtimeEnv) {
    const arg = this.getSinkArgumentNode(entry.node, entry.sinkInfo, entry.scope, entry.node.start || 0);
    const pos = entry.node.start || 0;
    const values = this.resolveExpression(arg, entry.scope, pos, overrides || new Map(), runtimeEnv);
    const structCount = new Map();                            // over-generation guard (see recordResolvedSinkValues)
    values.forEach(val => {
        if (!val) return;
        const sk = this.structuralKey(val);
        const c = structCount.get(sk) || 0;
        if (c >= MAX_VARIANTS_PER_STRUCT) return;
        structCount.set(sk, c + 1);
        const loc = entry.node.loc && entry.node.loc.start ? entry.node.loc.start : null;
        const line = loc ? loc.line : 0;
        const col = loc ? loc.column + 1 : 0;                 // 1-based char position of the sink
        this.results.add(`${line}|${col}|${entry.sinkInfo.name}|${val}`);
    });
}
,

findEnclosingFunction(node) {
    let current = node;
    while (current) {
        if (current.type === "FunctionDeclaration" || current.type === "FunctionExpression" || current.type === "ArrowFunctionExpression") {
            return current;
        }
        current = this.parentMap.get(current);
    }
    return null;
}
,

getSinksByFunction() {
    const map = new Map();
    this.sinks.forEach(entry => {
        const fnNode = this.findEnclosingFunction(entry.node);
        if (!fnNode) return;
        if (!map.has(fnNode)) map.set(fnNode, []);
        map.get(fnNode).push(entry);
    });
    return map;
}
,

getCallsByFunction() {
    const map = new Map();
    this.functionCalls.forEach(entry => {
        const fnNode = this.findEnclosingFunction(entry.node);
        if (!fnNode) return;
        if (!map.has(fnNode)) map.set(fnNode, []);
        map.get(fnNode).push(entry);
    });
    return map;
}
,

resolveCalledFunctionNode(callEntry) {
    if (!callEntry || !callEntry.node || !callEntry.node.callee) return null;
    const callNode = callEntry.node;
    if (callNode.callee.type === "Identifier") {
        const name = callNode.callee.name;
        const defInfo = this.findLatestDef(callEntry.scope, name, callNode.start || 0);
        if (!defInfo || !defInfo.def || !defInfo.def.node) return null;
        return this.resolveFunctionNodeFromDef(defInfo.def.node);
    }
    if (callNode.callee.type === "MemberExpression") {
        const memberName = this.getName(callNode.callee);
        if (memberName) return this.findLatestMemberDef(memberName, callNode.start || 0);
    }
    return null;
}
,

buildCallOverrides(fnNode, callEntry, parentOverrides) {
    if (!fnNode || !callEntry || !callEntry.node) return new Map();
    const overrides = new Map();
    const params = fnNode.params || [];
    const callNode = callEntry.node;
    const runtimeEnv = this.getRuntimeEnvForNodeChain(callNode);
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
        const argNode = callNode.arguments && callNode.arguments[idx];
        if (!argNode && defaultNode) {
            const values = this.resolveExpression(defaultNode, callEntry.scope, callNode.start || 0, parentOverrides || new Map(), runtimeEnv);
            overrides.set(paramName, values);
        } else {
            const values = this.resolveExpression(argNode, callEntry.scope, callNode.start || 0, parentOverrides || new Map(), runtimeEnv);
            overrides.set(paramName, values);
        }
    });
    return overrides;
}
,

serializeOverrides(overrides) {
    if (!overrides || overrides.size === 0) return "";
    return [...overrides.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, vals]) => `${key}=${(vals || []).slice().sort().join("|")}`)
        .join(";");
}
,

resolveFunctionCallsInterprocedurally(entryCalls, sinksByFunction, callsByFunction) {
    const maxDepth = 12;
    const visit = (fnNode, overrides, depth, seen) => {
        // Once the resolver budget is spent, stop the WHOLE interproc traversal. Individual
        // resolveExpression calls already bail cheaply past budget, but on huge call graphs even the
        // cheap-bail traversal (millions of no-op recursions) costs real wall-clock — so cut it off here.
        if (!fnNode || depth > maxDepth || this._budgetHit) return;
        const signature = `${fnNode.start || 0}:${this.serializeOverrides(overrides)}`;
        if (seen.has(signature)) return;
        seen.add(signature);

        const runtimeEnv = this.getRuntimeEnvForFunction(fnNode);
        const fnSinks = sinksByFunction.get(fnNode) || [];
        fnSinks.forEach(sinkEntry => {
            this.recordInterproceduralSink(sinkEntry, overrides, runtimeEnv);
        });

        const nestedCalls = callsByFunction.get(fnNode) || [];
        nestedCalls.forEach(callEntry => {
            if (this._budgetHit) return;
            const childFnNode = this.resolveCalledFunctionNode(callEntry);
            if (!childFnNode) return;
            const childOverrides = this.buildCallOverrides(childFnNode, callEntry, overrides || new Map());
            visit(childFnNode, childOverrides, depth + 1, seen);
        });
    };

    entryCalls.forEach(callEntry => {
        if (this._budgetHit) return;   // budget spent -> stop launching new entry-call traversals
        const fnNode = this.resolveCalledFunctionNode(callEntry);
        if (!fnNode) return;
        const overrides = this.buildCallOverrides(fnNode, callEntry, new Map());
        visit(fnNode, overrides, 0, new Set());
    });
}
,

resolveFunctionNodeFromDef(defNode) {
    if (!defNode) return null;
    if (defNode.type === "FunctionDeclaration" || defNode.type === "FunctionExpression" || defNode.type === "ArrowFunctionExpression") {
        return defNode;
    }
    if (defNode.type === "AssignmentExpression") {
        if (defNode.right && (defNode.right.type === "FunctionExpression" || defNode.right.type === "ArrowFunctionExpression")) {
            return defNode.right;
        }
    }
    return null;
}
,

};
