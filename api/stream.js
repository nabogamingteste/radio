const http = require("http");

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

module.exports = (req, res) => {
  const target = STREAMS[req.query.id];
  if (!target) {
    res.statusCode = 404;
    return res.end("Unknown stream");
  }

  const upstreamReq = http.get(
    target,
    {
      headers: { "Icy-MetaData": "0", "User-Agent": "Mozilla/5.0" },
      insecureHTTPParser: true, // tolerate Shoutcast "ICY 200 OK" responses
      timeout: 10000,
    },
    upstream => {
      res.writeHead(200, {
        "Content-Type": upstream.headers["content-type"] || "audio/mpeg",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      upstream.pipe(res);
      upstream.on("error", () => res.end());
      req.on("close", () => upstreamReq.destroy());
    }
  );

  upstreamReq.on("timeout", () => upstreamReq.destroy());
  upstreamReq.on("error", () => {
    if (!res.headersSent) res.statusCode = 502;
    res.end();
  });
};
