"use strict";
// The placeholder format LyN-X emits for unresolved values: `{TYPE:name}`
// (TYPE = VAR | CALL | EXCLUDED_CALL | URL_CALL). Shared by the analysis pipeline and the renderer
// so the format is defined in exactly one place.

const PH_G = /\{[A-Z_]+:[^}]*\}/g;      // global — for exec/replace loops (reset lastIndex before exec)
const PH_TEST = /\{[A-Z_]+:[^}]*\}/;    // non-global — safe for stateless .test()

const isConcrete = (u) => !PH_TEST.test(u);                         // no placeholders left -> fully resolved
const nameOf = (ph) => ph.replace(/^\{[A-Z_]+:/, "").replace(/\}$/, "");   // "{VAR:document.cookie}" -> "document.cookie"
const typeOf = (ph) => (ph.match(/^\{([A-Z_]+):/) || [])[1] || "";        // "VAR" | "CALL" | ...
const display = (ph) => "{" + nameOf(ph) + "}";                           // drop the TYPE: prefix
const stripTypes = (s) => s.replace(PH_G, display);                       // strip TYPE: from every placeholder in a URL

module.exports = { PH_G, PH_TEST, isConcrete, nameOf, typeOf, display, stripTypes };
