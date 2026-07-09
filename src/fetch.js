"use strict";
// Robust, portable HTTP(S) GET for HTML/URL input and --recurse. Stdlib http/https (no undici
// h2 crashes), browser UA, relaxed TLS, gzip/deflate/br decompression, redirect following,
// transient retries. Dual-stack via Node's built-in Happy-Eyeballs (prefers IPv4).

const http = require("http");
const https = require("https");
const zlib = require("zlib");
require("dns").setDefaultResultOrder("ipv4first"); // prefer IPv4, but still fall back to IPv6

const MAX_BYTES = 20 * 1024 * 1024;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
};
const CONN_ERRS = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "ECONNRESET", "EPIPE", "EAI_AGAIN"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(rawUrl, timeout, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(rawUrl); } catch (e) { return reject(e); }
    const isHttps = u.protocol === "https:";
    const opts = { timeout, headers: HEADERS, ...(isHttps ? { rejectUnauthorized: false } : {}) };
    const req = (isHttps ? https : http).get(u, opts, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error("too_many_redirects"));
        return resolve(httpGet(new URL(res.headers.location, u).href, timeout, redirectsLeft - 1));
      }
      if (code !== 200) { res.resume(); return resolve({ status: code, buf: null }); }
      const enc = (res.headers["content-encoding"] || "").toLowerCase();
      let stream = res;
      if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = []; let size = 0;
      stream.on("data", (c) => { size += c.length; if (size > MAX_BYTES) { req.destroy(); return reject(new Error("too_large")); } chunks.push(c); });
      stream.on("end", () => resolve({ status: 200, buf: Buffer.concat(chunks) }));
      stream.on("error", reject);
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// { status, buf } ; retries transient failures; { status:0 } on give-up.
async function fetchUrl(url, { timeout = 10000, retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await httpGet(url, timeout); }
    catch (e) {
      const c = (e && (e.code || e.message)) || "error";
      if ((!CONN_ERRS.has(c) && c !== "timeout") || attempt === retries) return { status: 0, buf: null, error: c };
      await sleep(400 * (attempt + 1));
    }
  }
  return { status: 0, buf: null };
}

async function fetchText(url, opts) {
  const { status, buf } = await fetchUrl(url, opts);
  return status === 200 && buf ? buf.toString("utf8") : null;
}

module.exports = { fetchUrl, fetchText };
