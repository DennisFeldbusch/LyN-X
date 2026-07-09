"use strict";
// Canonical set of sensitive client-side data sources. LyN-X names unresolved placeholders by their
// ORIGIN (e.g. `{VAR:document.cookie}`, chain-resolved), so we flag a placeholder as sensitive when
// its origin name matches one of these. Drives the red highlight and the "sensitive source ->
// off-origin sink" security signal.
//
// Matching philosophy (uniform, property-aware — no loose substring matching):
//  - Tokens are matched as PROPER DOTTED SEGMENTS via `(^|\.)token(\.|$|\b)`, never as substrings,
//    so `relocation`/`fullscreen`/`mycookie` never match.
//  - DISTINCTIVE tokens (cookie, *Storage, indexedDB, clipboardData, getSelection) are flagged on
//    any receiver — `x.cookie` is almost always `document.cookie` behind a minifier alias.
//  - AMBIGUOUS property names that are common on ordinary objects (`url`, `name`) require the real
//    global parent anchored at the START of the chain, so `y.document.url.0` or `user.name` do NOT
//    match while `document.URL` / `window.name` do. This trades a little recall on aliased globals
//    (e.g. `w.document.url` where w=window) for far fewer false positives; those cases are rare and
//    low-severity (the URL is also sent in Referer anyway).
//  - `location` is property-aware: only URL-bearing members (href/search/hash) carry tokens/PII;
//    protocol/host/hostname/origin/port are public routing info and are NOT flagged.

const SENSITIVE = []; // (kept for API compatibility / future exact-match entries)

const PATTERNS = [
  // High-value credential / storage sources — distinctive, flagged on any (aliased) receiver.
  /(^|\.)cookie\b/i,                                          // document.cookie
  /(^|\.)(local|session)storage\b/i,
  /(^|\.)indexeddb\b/i,
  /(^|\.)clipboarddata\b/i,
  /(^|\.)getselection\b/i,

  // document URL-family — `.url` is a very common property name, so require the global document
  // parent anchored at the start (excludes `y.document.url.0`, `config.url`, `request.referrer`).
  /^(window\.)?document\.(url|documenturi|referrer|baseuri)\b/i,

  // window.name — `name` alone is ubiquitous, so require the window parent.
  /(^|\.)window\.name\b/i,

  // Fingerprinting surfaces — object matched as a segment (won't hit `fullscreen`, `splashscreen`).
  /(^|\.)navigator(\.|$)/i,
  /(^|\.)screen(\.|$)/i,

  // crypto — only the secret/entropy members, not a generic `crypto` token (avoids `crypto.price`).
  /(^|\.)crypto\.(getrandomvalues|randomuuid|subtle)\b/i,

  // location — only URL-bearing members, or the whole global Location object.
  /(^|\.)location\.(href|search|hash)\b/i,
  /^(window\.|document\.)?location$/i,
];

function isSensitiveName(name) {
  if (!name) return false;
  const n = String(name).trim().toLowerCase();
  if (SENSITIVE.some((s) => n === s)) return true;
  return PATTERNS.some((re) => re.test(n));
}

module.exports = { SENSITIVE, PATTERNS, isSensitiveName };
