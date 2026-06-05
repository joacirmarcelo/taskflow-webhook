const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

const webhookMessages = [];
const MAX_MESSAGES = 1000;

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname, port: 443, path, method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(data) }
    };
    const req = https.request(options, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const options = { hostname, port: 443, path, method: "GET", headers };
    const req = https.request(options, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on("error", reject);
    req.end();
  });
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, data, status = 200) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise(resolve => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }

  const url = req.url;

  // ── Webhook receiver ──────────────────────────────────────────────
  if (url === "/webhook" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const p = JSON.parse(body);
      const text = p.text?.message || p.caption || p.body || p.message || "";
      if (text.trim()) {
        webhookMessages.unshift({
          id: Date.now() + Math.random(),
          phone: p.phone || p.from || p.chatId || "",
          senderName: p.senderName || p.pushname || p.notifyName || p.phone || "Desconhecido",
          text,
          fromMe: p.fromMe || false,
          timestamp: p.momentsAgo || p.messageTimestamp || Math.floor(Date.now() / 1000),
          receivedAt: new Date().toISOString(),
        });
        if (webhookMessages.length > MAX_MESSAGES) webhookMessages.pop();
        console.log(`📨 ${new Date().toLocaleTimeString("pt-BR")} | ${webhookMessages[0].senderName}: ${text.slice(0, 80)}`);
      }
    } catch (e) { console.error("Webhook parse error:", e.message); }
    return json(res, { ok: true });
  }

  // ── Get/clear webhook messages ────────────────────────────────────
  if (url === "/webhook-messages" && req.method === "GET") return json(res, webhookMessages);
  if (url === "/webhook-messages/count" && req.method === "GET") return json(res, { count: webhookMessages.length });
  if (url === "/webhook-messages/clear" && req.method === "POST") {
    webhookMessages.length = 0;
    return json(res, { ok: true });
  }

  // ── Claude API proxy (solves CORS) ────────────────────────────────
  if (url === "/claude" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const payload = JSON.parse(body);
      const apiKey = payload.apiKey;
      if (!apiKey) return json(res, { error: "API key required" }, 400);
      delete payload.apiKey;
      const result = await httpsPost("api.anthropic.com", "/v1/messages",
        { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        payload
      );
      return json(res, result);
    } catch (e) { return json(res, { error: e.message }, 500); }
  }

  // ── Z-API proxy ───────────────────────────────────────────────────
  if (url.startsWith("/zapi/")) {
    const zapiPath = url.replace("/zapi", "");
    const body = await readBody(req);
    const options = {
      hostname: "api.z-api.io", port: 443, path: zapiPath,
      method: req.method,
      headers: { "Content-Type": "application/json", "Client-Token": "" },
    };
    const zapiReq = https.request(options, (zapiRes) => {
      let d = "";
      zapiRes.on("data", c => d += c);
      zapiRes.on("end", () => { cors(res); res.writeHead(200, { "Content-Type": "application/json" }); res.end(d); });
    });
    zapiReq.on("error", e => json(res, { error: e.message }, 500));
    if (body) zapiReq.write(body);
    zapiReq.end();
    return;
  }

  // ── Serve index.html ──────────────────────────────────────────────
  if (url === "/" || url === "/index.html") {
    const filePath = path.join(__dirname, "index.html");
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║      TaskFlow AI — Rodando na nuvem      ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  Porta: ${PORT}                               ║`);
  console.log(`║  Claude proxy: /claude (POST)            ║`);
  console.log(`║  Webhook: /webhook (POST)                ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});
