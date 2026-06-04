const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

// In-memory message store (persists while server is running)
const webhookMessages = [];
const MAX_MESSAGES = 1000;

function zapiProxy(zapiPath, res, method="GET", body=null) {
  const options = {
    hostname: "api.z-api.io",
    port: 443,
    path: zapiPath,
    method,
    headers: { "Content-Type": "application/json", "Client-Token": "" },
  };
  const req = https.request(options, (zapiRes) => {
    let data = "";
    zapiRes.on("data", c => data += c);
    zapiRes.on("end", () => {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(data);
    });
  });
  req.on("error", e => {
    res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: e.message }));
  });
  if (body) req.write(body);
  req.end();
}

const server = http.createServer((req, res) => {
  // CORS
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  const url = req.url;

  // ── Webhook receiver ─────────────────────────────────────────────
  if (url === "/webhook" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const p = JSON.parse(body);
        const text = p.text?.message || p.caption || p.body || p.message || "";
        if (text.trim()) {
          const msg = {
            id: Date.now() + Math.random(),
            phone: p.phone || p.from || p.chatId || "",
            senderName: p.senderName || p.pushname || p.notifyName || p.phone || "Desconhecido",
            text,
            fromMe: p.fromMe || false,
            timestamp: p.momentsAgo || p.messageTimestamp || Math.floor(Date.now()/1000),
            receivedAt: new Date().toISOString(),
          };
          webhookMessages.unshift(msg);
          if (webhookMessages.length > MAX_MESSAGES) webhookMessages.pop();
          console.log(`📨 [${new Date().toLocaleTimeString("pt-BR")}] ${msg.senderName}: ${msg.text.slice(0,80)}`);
        }
      } catch(e) { console.error("Webhook error:", e.message); }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // ── Get webhook messages ──────────────────────────────────────────
  if (url === "/webhook-messages" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(webhookMessages));
    return;
  }

  // ── Clear processed messages ──────────────────────────────────────
  if (url === "/webhook-messages/clear" && req.method === "POST") {
    webhookMessages.length = 0;
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, cleared: true }));
    return;
  }

  // ── Count pending messages ────────────────────────────────────────
  if (url === "/webhook-messages/count" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ count: webhookMessages.length }));
    return;
  }

  // ── Z-API proxy ───────────────────────────────────────────────────
  if (url.startsWith("/zapi/")) {
    const zapiPath = url.replace("/zapi", "");
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => zapiProxy(zapiPath, res, req.method, body || null));
    return;
  }

  // ── Serve index.html ──────────────────────────────────────────────
  if (url === "/" || url === "/index.html") {
    const filePath = path.join(__dirname, "index.html");
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end("index.html not found"); }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║      TaskFlow AI — Rodando na nuvem      ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  Porta: ${PORT}                               ║`);
  console.log(`║  Webhook: /webhook (POST)                ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});
