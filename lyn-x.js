#!/usr/bin/env node
"use strict";
// LyN-X v2 CLI: analyze a .js file, an HTML file, or a URL. Auto-detects input type.
// HTML: inline classic <script>s are concatenated in DOM order (they share the page's global scope);
// external <script src> files, ES modules, and recursion targets are analyzed in ISOLATION so
// unrelated bundles don't alias each other's variables (see DESIGN.md §2).
//
// Relative-URL resolution: when a base is known — a URL input (full page URL) or a local file
// with --origin — extracted relative URLs are resolved against it (root- and directory-relative),
// preserving {TYPE:...} placeholders. Without a base (local file, no --origin) relatives are left
// as-is.
//
// Recursion: --recurse fetches every fully-resolved script URL (.js / importScripts) and folds it
// into the analysis to a fixpoint. DEFAULT is input-dependent: ON for URL inputs (we are already
// fetching), OFF for local HTML/.js files. Override with --recurse / --no-recurse.

const util = require("util");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { LyNX } = require("./src");
const { fetchText } = require("./src/fetch");
const { extractScripts, looksHtml } = require("./src/html");
const { renderTable, renderRaw, isUrlLike } = require("./src/render");
const { isConcrete, PH_G } = require("./src/placeholders");
const acorn = require("acorn");

// gray (dim) stderr note for warnings + soft errors; plain when piped (not a TTY)
const warn = (m) => process.stderr.write((process.stderr.isTTY ? `\x1b[90m${m}\x1b[0m` : m) + "\n");

// Content is HTML iff it LOOKS like HTML and does NOT parse as JS. This keeps a .js that merely
// contains "<script>" strings (valid JS: document.write('<script src=...>')) in JS mode, while an
// HTML page saved/served with a .js name (fails to parse as JS) is correctly analyzed as HTML.
// parsesAsJs fails fast at (1:0) on real HTML, so the extra parse is cheap and only runs when the
// content already looks HTML-ish (a minority of files).
const parsesAsJs = (code) => { for (const st of ["script", "module"]) { try { acorn.parse(code, { ecmaVersion: "latest", sourceType: st }); return true; } catch {} } return false; };
const isHtmlContent = (source) => looksHtml(source) && !parsesAsJs(source);

function printHelp() {
  console.log(`LyN-X v2 — static URL/endpoint extraction from JavaScript

Usage:
  lynx <file.js | file.html | https://url> [more files...] [options]

Options:
  -r, --raw           Print only extracted URLs, one per line (no color/table)
  -a, --all           Include non-URL fragments (bare words, {var}-only, javascript:); default hides them
      --recurse [N]   Fetch external script references and re-analyze, N layers deep. Bare (or -1)
                      = until nothing new; --recurse 1 = first layer only, etc. Local files fetch
                      NOTHING unless this is set (they still extract <script src> URLs + analyze
                      inline); URL inputs recurse fully by default.
      --no-recurse    Fetch nothing (alias for --recurse 0)
      --origin URL    Base origin/URL for resolving relative URLs, RFC-style (auto-set from a URL
                      input); a leading-slash route replaces the base path (use for live-URL checks)
      --base  URL     Base to CONCATENATE onto root-relative routes, preserving the base's own path
                      (e.g. .../v1); mirrors SDK baseURL+route. Unlike --origin, keeps the /v1 prefix
      --op-budget N     Per-sink resolver work cap (ops); raise for deep/complex sinks, 0 disables
      --index-budget N  Indexing-walk cap (AST-node visits); raise for very large bundles, 0 disables
      --total-budget N  Whole-file resolver work cap (ops); 0 disables
                        Hitting any budget yields PARTIAL results (footer shows "(partial)").
      --stack-size N  Re-run with a larger V8 stack (KB) for very deep/large minified JS whose
                      parse recursion overflows. Keep below your OS thread stack ('ulimit -s',
                      default 8192 KB) or Node may segfault; raise 'ulimit -s' to go higher.
      --json [file]   Write results as JSON (default: lynx-results.json)
      --no-color      Disable ANSI colors
      --ast           Print the parsed AST
      --ast-json      Print the parsed AST as JSON
  -h, --help          Show this help

Color: bold = resolved · white = literal · light-blue {var} · dark-blue {call}
       red = sensitive source · green/orange host = same-site/external · gray = non-URL`);
}

function parseArgs(argv) {
  const o = { inputs: [], raw: false, all: false, recurse: null, origin: null, json: undefined,
    ast: false, astJson: false, color: !!process.stdout.isTTY, timeout: 10000 };
  const numFlag = (i) => { const v = argv[i + 1]; return (v !== undefined && /^\d+$/.test(v)) ? +v : NaN; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "-r" || a === "--raw") { o.raw = true; o.color = false; }
    else if (a === "-a" || a === "--all") o.all = true;
    else if (a === "--recurse") {   // optional depth: --recurse N = N layers; bare or -1 = unlimited
      const v = argv[i + 1];
      if (v !== undefined && /^-?\d+$/.test(v)) { const n = +v; o.recurse = n < 0 ? Infinity : n; i++; }
      else o.recurse = Infinity;
    }
    else if (a === "--no-recurse") o.recurse = 0;
    else if (a === "--origin" || a === "--domain") { const v = argv[i + 1]; if (v && !v.startsWith("--")) { o.origin = v; i++; } }
    else if (a === "--base") { const v = argv[i + 1]; if (v && !v.startsWith("--")) { o.base = v; i++; } }
    // Work-budget overrides (0 disables the cap). See core/shared.js: op = per-sink resolver ops,
    // total = whole-file resolver ops, index = AST-node visits in the indexing walk.
    else if (a === "--op-budget") { const n = numFlag(i); if (!Number.isNaN(n)) { o.opBudget = n; i++; } }
    else if (a === "--total-budget") { const n = numFlag(i); if (!Number.isNaN(n)) { o.totalBudget = n; i++; } }
    else if (a === "--index-budget") { const n = numFlag(i); if (!Number.isNaN(n)) { o.indexBudget = n; i++; } }
    else if (a === "--stack-size") o.stackSize = +argv[++i];
    else if (a === "--no-color") o.color = false;
    else if (a === "--ast") o.ast = true;
    else if (a === "--ast-json") o.astJson = true;
    else if (a === "--json") { const v = argv[i + 1]; if (v && !v.startsWith("--")) { o.json = v; i++; } else o.json = "lynx-results.json"; }
    else if (!a.startsWith("-")) o.inputs.push(a);   // positional: one or more file/URL inputs (e.g. lynx *.js)
  }
  return o;
}

const isScriptUrl = (u) => /\.m?js([?#]|$)/i.test(u);

// Permissive absolutization for concrete resources (script src=, recursion targets — no placeholders).
const absolutize = (src, base) => {
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith("//")) return "https:" + src;
  try { return new URL(src, base || "https://example.invalid").href; } catch { return src; }
};

// --base: string-CONCATENATE a known base onto root-relative routes, PRESERVING the base's own path
// (e.g. /v1) — unlike --origin/resolveRel's RFC resolution, where a leading-slash path overrides the base
// path. This mirrors how API-client SDKs build URLs (baseURL + route), so `.post("/chat/completions")`
// with --base https://api.openai.com/v1 -> https://api.openai.com/v1/chat/completions. Placeholders
// ({VAR:}/{CALL:}) ride along untouched since this is a plain string concat.
function applyBase(url, base) {
  if (!base || typeof url !== "string" || !url) return url;
  if (/^https?:\/\//i.test(url)) return url;                    // already absolute
  if (url.startsWith("//")) return url;                         // protocol-relative (host-relative) → leave
  if (!url.startsWith("/")) return url;                         // only root-relative routes
  return base.replace(/\/+$/, "") + url;                        // concat; collapse the slash boundary
}

// Conservative, placeholder-preserving resolution for EXTRACTED URLs. Resolves root-relative (/…, //…)
// and path-structured (contains "/") refs against the base; leaves bare tokens ("photo") and
// placeholder-anchored refs ("{VAR:base}/x") untouched so they stay flagged as non-URL.
function resolveRel(url, base) {
  if (!base || typeof url !== "string" || !url) return url;
  if (/^https?:\/\//i.test(url)) return url;                    // already absolute
  if (url.startsWith("{")) return url;                          // anchorless template
  if (!(url.startsWith("/") || url.includes("/"))) return url;  // bare token → leave (likely noise)
  const masks = [];
  const masked = url.replace(PH_G, (m) => `qphq${masks.push(m) - 1}qphq`); // mask so URL() won't encode {}
  let out;
  try { out = new URL(masked, base).href; } catch { return url; }
  return out.replace(/qphq(\d+)qphq/g, (_, i) => masks[+i] ?? _);
}

// Per-run analysis state (a CLI invocation is one run): budget overrides from flags, and whether any
// analyzed unit hit a budget — which flips the "(partial)" footer on. Set once in main().
const RUN = { budgets: {}, partial: false };

function analyzeSource(code, origin) {
  try {
    const w = new LyNX({ code });
    if (RUN.budgets.opBudget !== undefined) w.opBudget = RUN.budgets.opBudget;
    if (RUN.budgets.totalBudget !== undefined) w.totalBudget = RUN.budgets.totalBudget;
    if (RUN.budgets.indexBudget !== undefined) w.indexBudget = RUN.budgets.indexBudget;
    w.domain = origin || null;   // core does webpack varDomains + root-relative concat when set
    const rows = w.analyze({ printTable: false });
    if (w._budgetHit) {
      RUN.partial = true;
      warn(w._indexBudgetHit
        ? "[warn] indexing budget exceeded — partial results (raise --index-budget, or 0 to disable)"
        : "[warn] resolver budget exceeded — partial results (raise --op-budget/--total-budget, or 0 to disable)");
    }
    return rows;
  } catch (e) {
    warn(`[warn] analysis error, skipping unit: ${(e && e.message) || e}`);
    return [];
  }
}

// Dedupe by (file, line, col, sink, url) so distinct sink locations are preserved; group by file in
// first-appearance order, sort within a file by line then column.
function dedupeRows(rows) {
  const seen = new Set(), kept = [];
  for (const r of rows) { const k = `${r.file}|${r.line}|${r.col}|${r.sink}|${r.url}`; if (!seen.has(k)) { seen.add(k); kept.push(r); } }
  const order = [], groups = new Map();
  for (const r of kept) { if (!groups.has(r.file)) { groups.set(r.file, []); order.push(r.file); } groups.get(r.file).push(r); }
  const out = [];
  for (const f of order) { groups.get(f).sort((a, b) => a.line - b.line || (a.col || 0) - (b.col || 0) || String(a.url).localeCompare(String(b.url))); out.push(...groups.get(f)); }
  return out;
}

const nlCount = (s) => { let c = 0; for (let i = 0; i < s.length; i++) if (s[i] === "\n") c++; return c; };

// Concatenate parts [{label, code, base}] with `\n;\n` separators (ASI-safe), tracking where each
// part's code begins in the bundle so bundle-relative lines can be mapped back to per-file lines.
// `base` = the display line that the part's first code line corresponds to (HTML line for inline, 1 for files).
function assemble(parts) {
  const SEP = "\n;\n";
  let bundle = "", line = 1;
  const units = [];
  for (const p of parts) {
    units.push({ label: p.label, base: p.base || 1, bundleStart: line });
    bundle += p.code + SEP;
    line += nlCount(p.code) + nlCount(SEP);
  }
  return { bundle, units };
}

// Map bundle-relative rows back to their originating file + local line number. `units` is ascending
// by bundleStart; each row belongs to the last unit that starts at or before it.
function remap(rows, units) {
  return rows.map((r) => {
    let u = units[0];
    for (const cand of units) { if (cand.bundleStart <= r.line) u = cand; else break; }
    return { ...r, file: u ? u.label : null, line: u ? u.base + (r.line - u.bundleStart) : r.line };
  });
}

const PRELUDE = " prelude";   // sentinel unit label for the page-globals prelude

// Analyze one self-contained unit (external file / module / recursed script), tagged to `label` with
// display base line `base`. If `prelude` (the page's inline global-defining code) is given, it is
// prepended so the unit can resolve genuine page globals (e.g. a `configUn` defined in an inline
// <script>); only the unit's OWN rows are returned — the prelude's sinks were already reported when
// the inline bundle was analyzed. Unrelated external bundles are never combined with each other, so
// no cross-bundle variable aliasing is reintroduced.
function analyzeUnit(code, origin, label, base, prelude) {
  const parts = prelude ? [{ label: PRELUDE, code: prelude, base: 1 }, { label, code, base }] : [{ label, code, base }];
  const { bundle, units } = assemble(parts);
  const rows = remap(analyzeSource(bundle, origin), units);
  return prelude ? rows.filter((r) => r.file === label) : rows;
}

// Fetch a script URL and append its analysis (with the page-globals prelude), tagged to that URL.
// `seen` dedups fetches across the src pass and recursion (a URL is fetched at most once).
async function analyzeRemote(url, origin, opts, seen, out, prelude) {
  if (seen.has(url)) return;
  seen.add(url);
  const c = await fetchText(url, opts);
  if (c != null) out.push(...analyzeUnit(c, origin, url, 1, prelude));
}

// Recursion (in place, to a fixpoint): fetch every fully-resolved script URL discovered so far and
// analyze each, until no new ones appear or the depth cap is hit.
async function recurseIsolated(out, origin, baseUrl, opts, seen, prelude) {
  for (let depth = 0; depth < opts.recurse; depth++) {   // opts.recurse = # of fetch layers (0 = none, Infinity = all)
    const next = [...new Set(
      out.map((r) => r.url).filter(isConcrete)
        .map((u) => absolutize(u, baseUrl))
        .filter((u) => /^https?:\/\//i.test(u) && isScriptUrl(u) && !seen.has(u))
    )];
    if (!next.length) break;
    for (const u of next) await analyzeRemote(u, origin, opts, seen, out, prelude);
  }
}

async function analyzeHtml(html, origin, baseUrl, opts, pageLabel) {
  const { classic, modules } = extractScripts(html);
  const out = [];
  const seen = new Set();   // fetched script URLs (avoids re-analysis across src + recursion)

  // Inline classic scripts DO share the page's global scope -> concatenate in DOM order and report.
  const inlineParts = classic.filter((s) => s.code != null).map((s) => ({ label: pageLabel, code: s.code, base: s.line }));
  if (inlineParts.length) {
    const { bundle, units } = assemble(inlineParts);
    out.push(...remap(analyzeSource(bundle, origin), units));
  }
  // Prelude = the inline scripts' code (page globals), prepended when analyzing external units so
  // cross-script globals resolve. External bundles are still analyzed one-at-a-time (never together).
  const prelude = inlineParts.map((p) => p.code).join("\n;\n");

  // Emit each external <script src>/<module src> as a row (a resource the page loads) — this is
  // extraction, always done. We do NOT fetch them here: fetching is recursion (network), gated by
  // --recurse. recurseIsolated picks these concrete script URLs up as its first fetch layer.
  for (const s of classic) if (s.code == null && s.src) {
    out.push({ file: pageLabel, line: s.line, col: 1, sink: "script-src", url: absolutize(s.src, baseUrl) });
  }
  for (const m of modules) {
    if (m.code != null) out.push(...analyzeUnit(m.code, origin, `${pageLabel} (module)`, m.line, prelude));
    else if (m.src) out.push({ file: pageLabel, line: m.line, col: 1, sink: "module-src", url: absolutize(m.src, baseUrl) });
  }

  await recurseIsolated(out, origin, baseUrl, opts, seen, prelude);
  return dedupeRows(out);
}

async function analyzeJs(code, origin, baseUrl, opts, pageLabel) {
  const out = analyzeUnit(code, origin, pageLabel, 1, "");   // single file: no page-globals prelude
  await recurseIsolated(out, origin, baseUrl, opts, new Set([pageLabel]), "");
  return dedupeRows(out);
}

// Analyze ONE input (local file or URL): read/fetch, detect HTML vs JS, run the analyzer, and resolve
// extracted relatives against this input's own base. Rows are tagged with `input` as their file (so the
// table groups by file). `recurse`'s default is per-input (URL → recurse, local → none), computed here
// without mutating shared opts, so `lynx page.html local.js` treats each correctly. Returns
// { rows, baseHost, failed }; `failed` marks a hard read/fetch error (vs. a valid file with no URLs).
async function analyzeInput(input, o) {
  const isUrl = /^https?:\/\//i.test(input);
  const recurse = o.recurse === null ? (isUrl ? Infinity : 0) : o.recurse;
  const iopts = { ...o, recurse };

  let source, isHtml, baseUrl = null;
  if (isUrl) {
    baseUrl = input;                            // full page URL -> resolve every relative against it
    source = await fetchText(input, iopts);
    if (source == null) { warn(`Failed to fetch ${input}`); return { rows: [], baseHost: null, failed: true }; }
    isHtml = isHtmlContent(source);
  } else {
    try {
      source = fs.readFileSync(input, "utf8");
    } catch (e) {
      warn(e.code === "ENOENT" ? `file not found: ${input}` : `cannot read ${input}: ${e.message}`);
      return { rows: [], baseHost: null, failed: true };
    }
    // Trust the extension: a .js/.mjs/.json file is JS even if it contains "<script>" strings (social/
    // analytics bundles do document.write('<script src=...>')) — otherwise looksHtml misfires and we'd
    // treat it as HTML, extract those tags, and recurse+fetch them over the network. Only sniff when
    // the extension is not a known code type.
    isHtml = /\.html?$/i.test(input) || isHtmlContent(source);
    if (o.origin) baseUrl = /^https?:\/\//i.test(o.origin) ? o.origin : "https://" + o.origin;
  }

  // parse the base once: `origin` (scheme+host) feeds the core; `baseHost` drives host coloring
  let origin = null, baseHost = null;
  if (baseUrl) { try { const u = new URL(baseUrl); origin = u.origin; baseHost = u.hostname; } catch {} }

  let rows = isHtml ? await analyzeHtml(source, origin, baseUrl, iopts, input) : await analyzeJs(source, origin, baseUrl, iopts, input);

  // Resolve extracted relative URLs against the base (full URL for URL inputs, --origin for local).
  if (baseUrl) rows = dedupeRows(rows.map((r) => ({ ...r, url: resolveRel(r.url, baseUrl) })));
  // --base: string-concat a known base onto root-relative routes (preserves the base path, e.g. /v1).
  if (o.base) rows = dedupeRows(rows.map((r) => ({ ...r, url: applyBase(r.url, o.base) })));
  return { rows, baseHost, failed: false };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.inputs.length) { printHelp(); process.exit(o.help ? 0 : 1); }
  RUN.budgets = { opBudget: o.opBudget, totalBudget: o.totalBudget, indexBudget: o.indexBudget };

  // V8's stack limit can only be set at process start, so honor --stack-size by re-exec'ing once.
  // Iterative walkers handle deep ASTs during analysis; this covers only acorn's recursive-descent
  // PARSE of pathologically deep expressions (long +/||/[] chains) that no in-process change avoids.
  // Node-only: the bun-compiled standalone binary uses JavaScriptCore (no V8 --stack-size) and has no
  // script path to re-exec, so we warn and continue (the iterative/guard fixes still apply there).
  if (o.stackSize && !process.env.LYNX_STACK_REEXEC) {
    if (process.versions && process.versions.bun) {
      process.stderr.write("[warn] --stack-size is only supported under node (V8); ignored in the standalone binary.\n");
    } else {
      const r = spawnSync(process.execPath, [`--stack-size=${o.stackSize}`, process.argv[1], ...process.argv.slice(2)],
        { stdio: "inherit", env: { ...process.env, LYNX_STACK_REEXEC: "1" } });
      process.exit(r.status == null ? 1 : r.status);
    }
  }

  // --ast dumps the parsed tree; only meaningful for one source — use the first input.
  if (o.ast || o.astJson) {
    const input = o.inputs[0];
    let src;
    if (/^https?:\/\//i.test(input)) src = await fetchText(input, o);
    else { try { src = fs.readFileSync(input, "utf8"); } catch (e) { warn(`cannot read ${input}: ${e.message}`); src = null; } }
    if (src == null) process.exit(1);
    const w = new LyNX({ code: src });
    console.log(o.astJson ? JSON.stringify(w.ast, null, 2) : util.inspect(w.ast, { depth: 8, compact: false, colors: false }));
    return;
  }

  // Analyze every input; rows carry their source file, so they render as per-file groups in one table.
  let allRows = [];
  const hosts = new Set();
  let failed = false;
  for (const input of o.inputs) {
    const { rows, baseHost, failed: f } = await analyzeInput(input, o);
    allRows.push(...rows);
    if (baseHost) hosts.add(baseHost);
    if (f) failed = true;
  }
  if (o.inputs.length === 1 && failed) process.exit(1);   // preserve single-input hard-error exit code

  if (o.json !== undefined) {   // JSON is the complete export — never filtered
    const outPath = path.resolve(o.json);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ inputs: o.inputs, generatedAt: new Date().toISOString(),
      partial: RUN.partial, resultCount: allRows.length, results: allRows }, null, 2));
    console.log(`Wrote JSON results to ${outPath}`);
    return;
  }

  // Human output shows only real URLs (templated or full) by default; --all keeps non-URL fragments.
  const shown = o.all ? allRows : allRows.filter((r) => isUrlLike(r.url));
  const baseHost = hosts.size === 1 ? [...hosts][0] : null;   // host coloring is only meaningful with one base

  if (o.raw) { process.stdout.write(renderRaw(shown)); return; }   // fast path: no table/color setup
  process.stdout.write(renderTable(shown, { color: o.color, baseHost, partial: RUN.partial }));
}

main().catch((e) => { console.error(e); process.exit(1); });
