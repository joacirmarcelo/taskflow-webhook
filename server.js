const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const webhookMessages = [];
const MAX_MESSAGES = 1000;

// ── HELPERS ──────────────────────────────────────────────────────────────────

function httpsPost(hostname, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname, port: 443, path: urlPath, method: "POST",
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

function httpsGet(hostname, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const options = { hostname, port: 443, path: urlPath, method: "GET", headers };
    const req = https.request(options, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on("error", reject);
    req.end();
  });
}

// Download URL to Buffer (follows redirects)
function downloadBuffer(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) return reject(new Error("Too many redirects"));
    const proto = url.startsWith("https") ? https : http;
    proto.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return downloadBuffer(res.headers.location, maxRedirects - 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// Transcribe audio via OpenAI Whisper
async function transcribeAudio(audioBuffer, filename = "audio.ogg") {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !audioBuffer || audioBuffer.length === 0) return null;

  // Detect format from filename
  const ext = filename.split(".").pop() || "ogg";
  const mimeMap = { ogg:"audio/ogg", mp3:"audio/mpeg", mp4:"audio/mp4", m4a:"audio/mp4",
                    wav:"audio/wav", webm:"audio/webm", opus:"audio/ogg" };
  const mimeType = mimeMap[ext] || "audio/ogg";

  const boundary = "----WhisperBoundary" + Date.now().toString(16);
  const CRLF = "\r\n";

  const filePart = Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
    `Content-Type: ${mimeType}${CRLF}${CRLF}`
  );
  const modelPart = Buffer.from(
    `${CRLF}--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="model"${CRLF}${CRLF}` +
    `whisper-1` +
    `${CRLF}--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="language"${CRLF}${CRLF}` +
    `pt` +
    `${CRLF}--${boundary}--${CRLF}`
  );

  const body = Buffer.concat([filePart, audioBuffer, modelPart]);

  return new Promise((resolve) => {
    const options = {
      hostname: "api.openai.com",
      port: 443,
      path: "/v1/audio/transcriptions",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      }
    };
    const req = https.request(options, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(d);
          resolve(parsed.text || null);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

// Extract audio URL from Z-API webhook payload
function extractAudioUrl(p) {
  return p.audio?.audioUrl || p.audio?.url || p.audio?.fileUrl ||
         p.document?.url || p.document?.fileUrl ||
         p.voice?.audioUrl || p.fileUrl || null;
}

// Detect if webhook payload is an audio message
function isAudioMessage(p) {
  return (
    p.type === "audio" || p.type === "ptt" || p.type === "voice" ||
    !!p.audio || !!p.voice ||
    (p.document?.mimeType || "").includes("audio")
  );
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

// ── SCHEDULED MESSAGES ───────────────────────────────────────────────────────
const scheduledMessages = [];

// Check every 30 seconds for messages due to send
setInterval(async () => {
  const now = Date.now();
  for (const sm of scheduledMessages) {
    if (sm.status !== "pending") continue;
    if (sm.scheduledFor > now) continue;
    sm.status = "sending";
    try {
      const path = `/instances/${sm.zapiInst}/token/${sm.zapiTok}/send-text`;
      await httpsPost("api.z-api.io", path,
        { "Content-Type": "application/json", "Client-Token": process.env.ZAPI_CLIENT_TOKEN || "" },
        { phone: sm.phone, message: sm.message }
      );
      sm.status = "sent";
      sm.sentAt = new Date().toISOString();
      console.log(`✅ Msg programada enviada → ${sm.contact || sm.phone}`);
    } catch (e) {
      sm.retries = (sm.retries || 0) + 1;
      sm.status = sm.retries < 3 ? "pending" : "failed";
      sm.error = e.message;
      console.error(`❌ Falha msg programada (tentativa ${sm.retries}): ${e.message}`);
    }
  }
}, 30000);

// ── SERVER ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }

  const url = req.url;

  // ── Webhook receiver ─────────────────────────────────────────────────────
  if (url === "/webhook" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const p = JSON.parse(body);
      const isAudio = isAudioMessage(p);
      let text = p.text?.message || p.caption || p.body || p.message || "";

      // Auto-transcribe audio if no text and OpenAI key is set
      if (!text.trim() && isAudio) {
        const audioUrl = extractAudioUrl(p);
        if (audioUrl && process.env.OPENAI_API_KEY) {
          try {
            console.log(`🎙 Transcrevendo áudio de ${p.senderName || p.pushname || "?"} ...`);
            const ext = (audioUrl.split("?")[0].split(".").pop() || "ogg").slice(0, 4);
            const audioBuffer = await downloadBuffer(audioUrl);
            const transcription = await transcribeAudio(audioBuffer, `audio.${ext}`);
            if (transcription) {
              text = `[Áudio] ${transcription}`;
              console.log(`✓ Transcrição: ${transcription.slice(0, 100)}`);
            } else {
              text = "[Áudio - não transcrito]";
            }
          } catch (e) {
            console.error("Erro na transcrição:", e.message);
            text = "[Áudio - erro na transcrição]";
          }
        } else if (!process.env.OPENAI_API_KEY) {
          text = "[Áudio - configure OPENAI_API_KEY para transcrever]";
        }
      }

      if (text.trim()) {
        // Normalize name — reject dots/punctuation-only names
        const rawName = p.senderName || p.pushname || p.notifyName || "";
        const cleanName = rawName.trim().replace(/^[.\-_\s]+$/, "");
        const senderName = cleanName.length > 1 ? cleanName : (p.phone || "Desconhecido");

        // Normalize phone — strip @c.us, @lid, @s.whatsapp.net suffixes
        const rawPhone = p.phone || p.from || p.chatId || "";
        const isGroup = rawPhone.includes("-group") || rawPhone.includes("@g.us");
        const phone = isGroup
          ? rawPhone.replace(/@.+$/, "")               // group: keep number-group format
          : rawPhone.replace(/@.+$/, "").replace(/[^0-9]/g, ""); // individual: digits only

        webhookMessages.unshift({
          id: Date.now() + Math.random(),
          phone,
          senderName,
          text,
          isAudio,
          isGroup,
          fromMe: p.fromMe || false,
          timestamp: p.momentsAgo || p.messageTimestamp || Math.floor(Date.now() / 1000),
          receivedAt: new Date().toISOString(),
        });
        if (webhookMessages.length > MAX_MESSAGES) webhookMessages.pop();
        const audioTag = isAudio ? " 🎙" : "";
        console.log(`📨 ${new Date().toLocaleTimeString("pt-BR")} | ${webhookMessages[0].senderName}: ${text.slice(0, 80)}${audioTag}`);
      }
    } catch (e) {
      console.error("Webhook parse error:", e.message);
    }
    return json(res, { ok: true });
  }

  // ── Webhook messages ──────────────────────────────────────────────────────
  if (url === "/webhook-messages" && req.method === "GET") return json(res, webhookMessages);
  if (url === "/webhook-messages/count" && req.method === "GET") return json(res, { count: webhookMessages.length });
  if (url === "/webhook-messages/clear" && req.method === "POST") {
    webhookMessages.length = 0;
    return json(res, { ok: true });
  }

  // ── Scheduled messages ────────────────────────────────────────────────────
  if (url === "/schedule-message" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const d = JSON.parse(body);
      if (!d.phone || !d.message || !d.scheduledFor || !d.zapiInst || !d.zapiTok) {
        return json(res, { error: "Missing required fields" }, 400);
      }
      const sm = {
        id: Date.now() + Math.random(),
        phone: d.phone, message: d.message,
        scheduledFor: Number(d.scheduledFor),
        scheduledAt: new Date().toISOString(),
        zapiInst: d.zapiInst, zapiTok: d.zapiTok,
        contact: d.contact || "", taskTitle: d.taskTitle || "",
        status: "pending", sentAt: null, error: null, retries: 0
      };
      scheduledMessages.push(sm);
      const when = new Date(sm.scheduledFor).toLocaleString("pt-BR");
      console.log(`📅 Mensagem programada para ${sm.contact || sm.phone} em ${when}`);
      return json(res, { ok: true, id: sm.id });
    } catch (e) { return json(res, { error: e.message }, 400); }
  }
  if (url === "/scheduled-messages" && req.method === "GET") {
    return json(res, scheduledMessages.slice().reverse());
  }
  if (url === "/scheduled-messages/cancel" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const { id } = JSON.parse(body);
      const sm = scheduledMessages.find(m => String(m.id) === String(id));
      if (sm && sm.status === "pending") { sm.status = "cancelled"; return json(res, { ok: true }); }
      return json(res, { error: "Not found or already sent" }, 404);
    } catch (e) { return json(res, { error: e.message }, 400); }
  }

  // ── Claude API proxy ──────────────────────────────────────────────────────
  if (url === "/claude" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const payload = JSON.parse(body);
      const apiKey = process.env.CLAUDE_API_KEY || payload.apiKey;
      if (!apiKey) return json(res, { error: "API key required" }, 400);
      delete payload.apiKey;
      const result = await httpsPost(
        "api.anthropic.com", "/v1/messages",
        { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        payload
      );
      return json(res, result);
    } catch (e) { return json(res, { error: e.message }, 500); }
  }

  // ── Z-API proxy ───────────────────────────────────────────────────────────
  if (url.startsWith("/zapi/")) {
    const zapiPath = url.replace("/zapi", "");
    const body = await readBody(req);
    const options = {
      hostname: "api.z-api.io", port: 443, path: zapiPath,
      method: req.method,
      headers: { "Content-Type": "application/json", "Client-Token": process.env.ZAPI_CLIENT_TOKEN || "" },
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

  // ── Serve index.html ──────────────────────────────────────────────────────
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
  const whisperStatus = process.env.OPENAI_API_KEY ? "✓ Whisper ativo" : "⚠ sem OPENAI_API_KEY";
  console.log(`
╔══════════════════════════════════════╗
║       TaskFlow AI — FullLife         ║
╠══════════════════════════════════════╣
║  Porta : ${PORT}                         ║
║  Claude: /claude (POST)              ║
║  Webhook: /webhook (POST)            ║
║  Áudio : ${whisperStatus}         ║
╚══════════════════════════════════════╝
  `);
});
