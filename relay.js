const net = require("net");
const dns = require("dns").promises;
const { Readable } = require("stream");

/* Relays a radio stream through our own domain so the browser can run Web Audio
   effects on it (needs CORS) and so http:// streams work on an https page.
   Safety: same-site requests only, public hosts only, audio responses only. */

const UA = "Mozilla/5.0";
const AUDIO_OK = /^(audio\/|application\/ogg|application\/octet-stream|video\/ogg|binary\/octet-stream)/i;

function isPrivateIP(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function safeURL(raw) {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad protocol");
  if (process.env.RELAY_ALLOW_PRIVATE !== "1") {
    const ips = net.isIP(url.hostname) ? [url.hostname] : (await dns.lookup(url.hostname, { all: true })).map(x => x.address);
    if (!ips.length || ips.some(isPrivateIP)) throw new Error("blocked host");
  }
  return url;
}

function sameSite(req) {
  const host = req.headers.host;
  const ref = req.headers.referer || req.headers.origin;
  if (ref) { try { return new URL(ref).host === host; } catch { return false; } }
  return req.headers["sec-fetch-site"] === "same-origin";
}

module.exports = async (req, res) => {
  const debug = req.query.debug === "1";
  const fail = (code, msg) => {
    if (!res.headersSent) { res.statusCode = code; res.setHeader("Content-Type", "text/plain"); }
    res.end(debug ? String(msg) : undefined);
  };

  if (!debug && !sameSite(req)) return fail(403, "forbidden");

  let url;
  try { url = await safeURL(req.query.u); } catch (e) { return fail(400, e.message); }

  const ac = new AbortController();
  req.on("close", () => ac.abort());

  for (let hop = 0; hop < 6; hop++) {
    let r;
    const timer = setTimeout(() => ac.abort(), 10000);
    try {
      r = await fetch(url, { redirect: "manual", signal: ac.signal, headers: { "Icy-MetaData": "0", "User-Agent": UA } });
    } catch (e) {
      clearTimeout(timer);
      // Old Shoutcast servers answer "ICY 200 OK", which fetch rejects. Retry over a raw socket.
      if (url.protocol === "http:" && !ac.signal.aborted) return rawRelay(url, req, res, debug, fail);
      return fail(502, "connect error: " + e.message);
    }
    clearTimeout(timer);

    if ([301, 302, 303, 307, 308].includes(r.status)) {
      try { url = await safeURL(new URL(r.headers.get("location"), url).href); } catch (e) { return fail(502, "bad redirect: " + e.message); }
      continue;
    }
    if (!r.ok) return fail(502, "upstream said: " + r.status);

    const type = r.headers.get("content-type") || "audio/mpeg";
    if (!AUDIO_OK.test(type)) return fail(415, "not audio: " + type);
    if (debug) return fail(200, `HTTP ${r.status}\ncontent-type: ${type}\nfinal url: ${url.href}`);

    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    const body = Readable.fromWeb(r.body);
    body.on("error", () => res.end());
    return body.pipe(res);
  }
  fail(502, "too many redirects");
};

function rawRelay(u, req, res, debug, fail) {
  const sock = net.connect({ host: u.hostname, port: u.port || 80 });
  let head = Buffer.alloc(0), started = false;

  sock.setTimeout(10000, () => { if (!started) { fail(504, "upstream timeout"); sock.destroy(); } });
  sock.on("error", e => { fail(502, `connect error: ${e.code || ""} ${e.message}`); sock.destroy(); });
  req.on("close", () => sock.destroy());
  sock.on("connect", () => sock.write(
    `GET ${u.pathname}${u.search} HTTP/1.0\r\nHost: ${u.host}\r\nUser-Agent: ${UA}\r\nIcy-MetaData: 0\r\nConnection: close\r\n\r\n`));

  sock.on("data", chunk => {
    if (started) return res.write(chunk);
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) return;

    const headText = head.slice(0, end).toString("latin1");
    const status = headText.split("\r\n")[0];
    const type = ((headText.match(/^content-type:\s*(.+)$/im) || [])[1] || "audio/mpeg").trim();
    if (!/\s2\d\d(\s|$)/.test(status)) { fail(502, `upstream said: ${status}`); return sock.destroy(); }
    if (!AUDIO_OK.test(type)) { fail(415, "not audio: " + type); return sock.destroy(); }
    if (debug) { fail(200, `${status}\n${headText}`); return sock.destroy(); }

    started = true;
    sock.setTimeout(0);
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    const body = head.slice(end + 4);
    if (body.length) res.write(body);
  });
  sock.on("end", () => res.end());
}
