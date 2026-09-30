const http = require("http");
const fs = require("fs");
const path = require("path");
const { queries, publicQueryDefinition } = require("./src/queries");
const { buildUrl, redactUrl, executeQuery } = require("./src/fseApi");

const root = __dirname;
const publicDir = path.join(root, "public");

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv(path.join(root, ".env"));

const port = Number(process.env.PORT || 3000);
const baseUrl = process.env.FSE_BASE_URL || "https://server.fseconomy.net/data";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readJsonBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > limitBytes) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const rawPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const requested = rawPath === "/" ? "/index.html" : rawPath;
  const safeRelative = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safeRelative);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      userKeyConfigured: Boolean(process.env.FSE_USER_KEY),
      readAccessKeyConfigured: Boolean(process.env.FSE_READ_ACCESS_KEY),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/queries") {
    return sendJson(res, 200, { queries: queries.map(publicQueryDefinition) });
  }

  if (req.method === "POST" && url.pathname === "/api/query") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }

    const { queryId, params = {} } = body || {};
    const definition = queries.find((item) => item.id === queryId);
    if (!definition) {
      return sendJson(res, 400, { error: "Unknown query type." });
    }

    let requestUrl;
    try {
      requestUrl = buildUrl({
        baseUrl,
        userKey: process.env.FSE_USER_KEY,
        readAccessKey: process.env.FSE_READ_ACCESS_KEY,
        definition,
        params,
      });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }

    try {
      const { raw } = await executeQuery(requestUrl);
      return sendJson(res, 200, {
        query: publicQueryDefinition(definition),
        requestUrl: redactUrl(requestUrl),
        raw,
      });
    } catch (error) {
      return sendJson(res, error.statusCode || 502, {
        error: error.message,
        requestUrl: redactUrl(requestUrl),
        raw: error.raw || undefined,
      });
    }
  }

  if (req.method === "GET") return serveStatic(req, res);

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method not allowed");
});

server.listen(port, () => {
  console.log(`FSE Query Tool running at http://localhost:${port}`);
});
