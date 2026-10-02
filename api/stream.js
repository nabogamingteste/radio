const net = require("net");

// Only these streams can be relayed (keeps this from being an open proxy).
const STREAMS = {
  "icefm": "http://78.129.185.84:15225/;",
  "jcfm": "http://37.157.242.104:18275/;",
  "mradio": "http://95.154.196.37:34662/;",
  "rafikifm": "http://82.145.63.6:4819/;",
  "hominagospelradio": "http://uk5freenew.listen2myradio.com:15602/;",
  "uplandsfm": "http://uk19freenew.listen2myradio.com:6548/;",
  "selousfm": "http://uk19freenew.listen2myradio.com:11854/;",
  "cloudsfm": "http://eu6.fastcast4u.com:5306/;"
};

// Raw TCP on purpose: old Shoutcast servers answer "ICY 200 OK", which Node's
// HTTP client rejects as a parse error.
module.exports = (req, res) => {
  const target = STREAMS[req.query.id];
  if (!target) {
    res.statusCode = 404;
    return res.end("Unknown stream");
  }

  const debug = req.query.debug === "1";
  const u = new URL(target);
  const sock = net.connect({ host: u.hostname, port: u.port || 80 });
  let head = Buffer.alloc(0);
  let started = false;

  const fail = (code, msg) => {
    if (!res.headersSent) {
      res.statusCode = code;
      res.setHeader("Content-Type", "text/plain");
    }
    res.end(debug ? msg : undefined);
    sock.destroy();
  };

  sock.setTimeout(10000, () => { if (!started) fail(504, "upstream timeout"); });
  sock.on("error", err => fail(502, `connect error: ${err.code || ""} ${err.message}`));
  req.on("close", () => sock.destroy());

  sock.on("connect", () => {
    sock.write(
      `GET ${u.pathname}${u.search} HTTP/1.0\r\nHost: ${u.host}\r\n` +
      `User-Agent: Mozilla/5.0\r\nIcy-MetaData: 0\r\nConnection: close\r\n\r\n`
    );
  });

  sock.on("data", chunk => {
    if (started) return res.write(chunk);

    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) return;

    const headText = head.slice(0, end).toString("latin1");
    const body = head.slice(end + 4);
    const status = headText.split("\r\n")[0];
    const type = (headText.match(/^content-type:\s*(.+)$/im) || [])[1] || "audio/mpeg";

    if (!/\s2\d\d(\s|$)/.test(status)) return fail(502, `upstream said: ${status}\n${headText}`);
    if (debug) { res.setHeader("Content-Type", "text/plain"); res.end(`${status}\n${headText}`); return sock.destroy(); }

    started = true;
    sock.setTimeout(0);
    res.writeHead(200, {
      "Content-Type": type.trim(),
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    if (body.length) res.write(body);
  });

  sock.on("end", () => res.end());
};
          
