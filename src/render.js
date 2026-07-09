"use strict";
// Output rendering: colored/beautified table (default) or plain --raw URLs. Results are grouped by
// originating file (each group's column header carries the file URL as a trailing pseudo-column).
// Color scheme:
//   host       green (same site) / orange (external)  — only when a base host is known
//   literals   white (in a URL) / gray (in a non-URL / anchorless fragment)
//   {var}      light blue (unresolved variable origin)      — TYPE: prefix stripped for display
//   {call}     dark blue  (unresolved call: CALL/EXCLUDED_CALL/URL_CALL)
//   sensitive  red — overrides blue when the placeholder's origin is a sensitive data source
//   BOLD       = the URL is fully resolved; placeholders inside a real URL are bold too. Non-URL /
//              anchorless fragments are rendered non-bold (gray literals) so they read as lower-confidence.
// The TYPE: prefix is stripped for display in both the table and --raw ({VAR:x} -> {x}); only --json
// keeps the full {TYPE:...} form.

const { isSensitiveName } = require("./sensitive-sources");
const { PH_G: PH, isConcrete, nameOf: placeholderName, typeOf: placeholderType, display: phDisplay, stripTypes } = require("./placeholders");

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const HOST_RE = /^(https?:\/\/)([^/?#{}]+)(.*)$/i;      // concrete host only (no placeholder braces)

const sgr = (params, bold) => "\x1b[" + (bold ? "1;" : "") + params + "m";
const WHITE = "37", GRAY = "90", GREEN = "32", ORANGE = "38;5;208", RED = "31";
const LBLUE = "38;5;117", DBLUE = "34";   // VAR = light blue, CALL-family = dark blue

// URL-like = has a scheme/authority (http(s)://, //) or is an absolute path (/...). Everything else —
// bare words ("photo"), bare filenames ("shield.abc.chunk.js"), non-network schemes ("javascript:"),
// and anchorless templates ("{VAR:c}1") — is a low-confidence, non-URL extraction → rendered gray.
const isUrlLike = (u) => /^(https?:)?\/\//i.test(u) || u.startsWith("/");

// color for a placeholder: sensitive origin wins (red), else VAR=light blue / call-family=dark blue
const phColor = (ph) => isSensitiveName(placeholderName(ph)) ? RED : (placeholderType(ph) === "VAR" ? LBLUE : DBLUE);

// registrable-domain heuristic (dependency-free; handles subdomains + common 2-part TLDs)
const SLD2 = new Set(["co.uk", "org.uk", "gov.uk", "ac.uk", "com.au", "net.au", "org.au", "co.jp", "co.nz", "co.za", "com.br", "com.cn"]);
function regDomain(host) {
  const p = String(host).toLowerCase().split(".");
  if (p.length <= 2) return p.join(".");
  const last2 = p.slice(-2).join(".");
  return SLD2.has(last2) ? p.slice(-3).join(".") : last2;
}
const stripPort = (h) => h.replace(/:\d+$/, "").toLowerCase();      // "0.0.0.0:8000" -> "0.0.0.0"
function sameSite(host, base) {
  const a = stripPort(host), b = stripPort(base);
  if (a === b) return true;
  // IPs (v4/v6) and anything with a colon: exact match only (registrable-domain is meaningless)
  if (a.includes(":") || b.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(a) || /^\d+\.\d+\.\d+\.\d+$/.test(b)) return a === b;
  return regDomain(a) === regDomain(b);
}

// color literal + placeholder segments. litColor = color for literal runs; bold = weight for literals;
// boldPh = weight for placeholders (real URLs bold their placeholders; anchorless fragments do not).
function colorSegments(s, litColor, bold, boldPh) {
  let out = "", last = 0, m; PH.lastIndex = 0;
  while ((m = PH.exec(s))) {
    if (m.index > last) out += sgr(litColor, bold) + s.slice(last, m.index) + RESET;
    out += sgr(phColor(m[0]), boldPh) + phDisplay(m[0]) + RESET;   // prefix stripped
    last = m.index + m[0].length;
  }
  if (last < s.length) out += sgr(litColor, bold) + s.slice(last) + RESET;
  return out;
}

// color a URL. baseHost (optional) enables green/orange host coloring.
function colorUrl(url, baseHost) {
  // non-URL / anchorless fragment: gray literals, typed-blue (or red-if-sensitive) placeholders, all non-bold
  if (!isUrlLike(url)) return colorSegments(url, GRAY, false, false);
  const bold = isConcrete(url);                          // bold iff fully resolved
  const m = baseHost ? url.match(HOST_RE) : null;        // isolate concrete host only if we have a base
  if (m) {
    const hostColor = sameSite(m[2], baseHost) ? GREEN : ORANGE;
    return sgr(WHITE, bold) + m[1] + RESET               // scheme
      + sgr(hostColor, bold) + m[2] + RESET              // host (green/orange, bold=resolved)
      + colorSegments(m[3], WHITE, bold, true);          // path/query
  }
  return colorSegments(url, WHITE, bold, true);          // no base host, or placeholder/relative host
}

function hasSensitive(url) {
  PH.lastIndex = 0; let m;
  while ((m = PH.exec(url))) if (isSensitiveName(placeholderName(m[0]))) return true;
  return false;
}

// flat, deduped URL list — TYPE: prefixes stripped ({VAR:document.cookie} -> {document.cookie}).
function renderRaw(rows) {
  const seen = new Set(), urls = [];
  for (const r of rows) {
    if (!r.url) continue;
    const u = stripTypes(r.url);
    if (!seen.has(u)) { seen.add(u); urls.push(u); }
  }
  return urls.join("\n") + (urls.length ? "\n" : "");
}

// width-adaptive table grouped by originating file: each group's column header (with the file URL as
// a trailing pseudo-column) sits above a divider, then its rows. LINE/COL/SINK are padded to content
// globally so columns align across groups.
function renderTable(rows, { color = true, baseHost = null, columns = process.stdout.columns } = {}) {
  if (!rows.length) return "No URLs extracted.\n";
  const lineW = Math.max(4, ...rows.map((r) => String(r.line).length));
  const colW = Math.max(3, ...rows.map((r) => String(r.col || 0).length));   // COL = char offset of sink in its line
  const sinkW = Math.min(24, Math.max(4, ...rows.map((r) => String(r.sink).length)));
  const contentW = lineW + colW + sinkW + 42;
  const termW = (typeof columns === "number" && columns > 20) ? columns : null; // known terminal width (null when piped)
  const dividerW = termW || contentW;
  const paint = color ? (u) => colorUrl(u, baseHost) : (u) => u;
  const head = color ? DIM : "", rst = color ? RESET : "";
  // column header repeated per group; the file URL is a trailing pseudo-column — right-aligned to the
  // window edge when width is known, else >=1 gap after "URL" (and left as-is if it must wrap).
  // Header lines start with "LINE", so `grep -v '^LINE'` strips them.
  const colHdr = `${"LINE".padEnd(lineW)}  ${"COL".padEnd(colW)}  ${"SINK".padEnd(sinkW)}  URL`;
  const MIN_GAP = 4;
  const headerFor = (f) => {
    const label = f || "(source)";
    const gap = termW ? Math.max(MIN_GAP, termW - colHdr.length - label.length) : MIN_GAP;
    return `${head}${colHdr}${" ".repeat(gap)}${label}${rst}`;
  };

  // group by file, preserving first-appearance order
  const order = [], groups = new Map();
  for (const r of rows) { if (!groups.has(r.file)) { groups.set(r.file, []); order.push(r.file); } groups.get(r.file).push(r); }

  let out = "", sensitive = 0;
  for (const f of order) {
    out += `${headerFor(f)}\n`;
    out += `${head}${"-".repeat(dividerW)}${rst}\n`;
    for (const r of groups.get(f)) {
      if (hasSensitive(r.url)) sensitive++;
      const sink = String(r.sink).length > sinkW ? String(r.sink).slice(0, sinkW - 1) + "…" : String(r.sink).padEnd(sinkW);
      out += `${String(r.line).padEnd(lineW)}  ${String(r.col || 0).padEnd(colW)}  ${sink}  ${paint(r.url)}\n`;
    }
    out += "\n";
  }
  const flag = sensitive ? (color ? sgr(RED, true) : "") + `  (${sensitive} with sensitive sources)` + (color ? RESET : "") : "";
  const scope = order.length > 1 ? ` across ${order.length} files` : "";
  out += `${head}${rows.length} URL(s)${scope}${rst}${flag}\n`;
  return out;
}

module.exports = { renderTable, renderRaw, colorUrl, hasSensitive, sameSite, isUrlLike };
