"use strict";
// Extract <script>s from HTML in DOM order, split into classic (share global scope -> concat)
// vs ES modules (isolated -> analyze separately). Dependency-free; the browser closes a script
// at the first </script>, so a non-greedy match is faithful for the common case.

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

function attr(attrs, name) {
  const m = attrs.match(new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? "").trim() : null;
}

const JS_TYPES = new Set(["", "text/javascript", "application/javascript", "module",
  "text/ecmascript", "application/ecmascript", "text/jscript"]);

// -> { classic: [{code,line}|{src,line}], modules: [...] }  (in DOM order within each group)
// `line` = 1-based HTML line: for inline it's where the body starts, for src it's the <script> tag line.
function extractScripts(html) {
  const classic = [], modules = [];
  let m;
  SCRIPT_RE.lastIndex = 0;
  const lineAt = (idx) => { let c = 1; for (let i = 0; i < idx && i < html.length; i++) if (html[i] === "\n") c++; return c; };
  while ((m = SCRIPT_RE.exec(html))) {
    const attrs = m[1] || "", body = m[2] || "";
    const type = (attr(attrs, "type") || "").toLowerCase();
    const src = attr(attrs, "src");
    if (type && !JS_TYPES.has(type)) continue;               // skip application/json, text/template, etc.
    const bucket = type === "module" ? modules : classic;
    const tagLine = lineAt(m.index);
    const bodyLine = lineAt(m.index + 8 + attrs.length);      // "<script"(7) + ">"(1) + attrs -> body start
    if (src) bucket.push({ src, line: tagLine });            // external (src wins; inline body ignored)
    else if (body.trim()) bucket.push({ code: body, line: bodyLine }); // inline
  }
  return { classic, modules };
}

function looksHtml(s) {
  const head = s.slice(0, 1000).toLowerCase();
  return /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]|<script[\s>]|<meta[\s>]/.test(head);
}

module.exports = { extractScripts, looksHtml };
