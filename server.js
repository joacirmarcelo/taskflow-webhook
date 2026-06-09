const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const webhookMessages = [];
const MAX_MESSAGES = 1000;
const sequenceState = {}; // {phone: {step: 0}} — tracks per-contact sequence progress

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

// Detect image messages
function isImageMessage(p) {
  return p.type === "image" || p.type === "sticker" || !!p.image;
}

// Detect document messages
function isDocumentMessage(p) {
  return (p.type === "document" || !!p.document) && !isAudioMessage(p);
}

// Extract image URL from Z-API payload
function extractImageUrl(p) {
  return p.image?.imageUrl || p.image?.url || p.image?.fileUrl ||
         p.imageUrl || (typeof p.image === "string" ? p.image : null);
}

// Extract document info from Z-API payload
function extractDocumentInfo(p) {
  return {
    url: p.document?.url || p.document?.fileUrl || p.documentUrl || "",
    name: p.document?.name || p.document?.fileName || p.fileName || "documento",
    mimeType: p.document?.mimeType || p.mimeType || "application/octet-stream",
    size: p.document?.size || 0,
  };
}

// Analyze image with Claude Vision
async function analyzeImage(imageUrl, claudeKey) {
  if (!imageUrl || !claudeKey) return null;
  try {
    const imgBuffer = await downloadBuffer(imageUrl);
    const base64 = imgBuffer.toString("base64");
    const mimeType = imageUrl.includes(".png") ? "image/png" : "image/jpeg";
    const result = await httpsPost("api.anthropic.com", "/v1/messages",
      { "Content-Type": "application/json", "x-api-key": claudeKey, "anthropic-version": "2023-06-01" },
      {
        model: "claude-haiku-4-5-20251001", max_tokens: 250,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
          { type: "text", text: "Descreva esta imagem em português de forma concisa. Se for documento médico, exame ou receita, mencione os detalhes principais (médico, procedimento, data)." }
        ]}]
      }
    );
    return result.content?.[0]?.text?.trim() || null;
  } catch (e) {
    console.error("Vision error:", e.message);
    return null;
  }
}

// Send message via Z-API
async function zapiSend(zapiInst, zapiTok, phone, message) {
  return httpsPost("api.z-api.io",
    `/instances/${zapiInst}/token/${zapiTok}/send-text`,
    { "Content-Type": "application/json", "Client-Token": process.env.ZAPI_CLIENT_TOKEN || "" },
    { phone, message }
  );
}

// Store auto-reply outgoing message
function storeAutoMsg(phone, contactName, text) {
  webhookMessages.unshift({
    id: Date.now() + Math.random(),
    phone, senderName: "Joacir (Auto-IA)", text,
    type: "text", fromMe: true, isAutoReply: true,
    timestamp: Math.floor(Date.now() / 1000),
    receivedAt: new Date().toISOString(),
  });
}

// Phone fingerprint — last 8 digits of the 12-digit version
// This handles LID-contaminated numbers: 5551975796221 → 555197579622 → last8 = 97579622
// Which matches monitoring number 51997579622 → last8 = 97579622
function phoneFingerprint(raw) {
  const d = String(raw||"").replace(/\D/g,"");
  // Take first 12 digits (strips LID if present), then last 8
  return d.slice(0, 12).slice(-8);
}

function phoneMatch(a, b) {
  const pa = String(a||"").replace(/\D/g,"");
  const pb = String(b||"").replace(/\D/g,"");
  if (pa === pb) return true;
  // Fingerprint: last 8 of 12-digit version (handles LID contamination)
  if (phoneFingerprint(pa) === phoneFingerprint(pb)) return true;
  // Fallback: last 8 direct
  if (pa.slice(-8) === pb.slice(-8) && pa.length >= 8) return true;
  return false;
}

// ── AUTO-REPLY ────────────────────────────────────────────────────────────────
const autoReplyContacts = [];

async function generateAndSendAutoReply(config, msgData, phone) {
  const claudeKey = config.claudeKey || process.env.CLAUDE_API_KEY;
  console.log(`🤖 generateAutoReply: phone=${phone} name=${config.name} claudeKey=${!!claudeKey} zapiInst=${!!config.zapiInst} zapiTok=${!!config.zapiTok}`);
  if (!claudeKey) { console.log("❌ Sem Claude API key"); return; }
  if (!config.zapiInst || !config.zapiTok) { console.log("❌ Sem Z-API credentials"); return; }
  const senderName = config.name || phone;
  let userText = msgData.text || "";

  // Handle media types
  if (msgData.type === "image") {
    const desc = msgData.mediaUrl ? await analyzeImage(msgData.mediaUrl, claudeKey) : null;
    userText = desc
      ? `[Imagem: ${desc}]${msgData.caption ? " — " + msgData.caption : ""}`
      : (msgData.caption || "[Imagem recebida]");
  } else if (msgData.type === "document") {
    userText = `[Documento: ${msgData.fileName || "arquivo"}]${msgData.caption ? " — " + msgData.caption : ""}`;
  } else if (!userText.trim()) return;

  // Sequence logic
  const sequence = config.sequence || [];
  if (sequence.length > 0) {
    const stateKey = Object.keys(sequenceState).find(k => phoneMatch(k, phone)) || phone;
    const state = sequenceState[stateKey] || { step: 0 };
    if (state.step < sequence.length) {
      const q = sequence[state.step];
      await zapiSend(config.zapiInst, config.zapiTok, phone, q);
      sequenceState[stateKey] = { step: state.step + 1 };
      storeAutoMsg(phone, senderName, q);
      console.log(`📋 Sequência ${state.step + 1}/${sequence.length} → ${senderName}`);
      return;
    }
  }

  // Claude free-form response with fallback
  const fallback = config.fallbackMsg ||
    "Peço desculpas! Essa questão precisará da confirmação do Sr. Joacir Marcelo. Entrarei em contato o mais breve possível. 🙏";
  const globalInst = config.globalInstructions ||
    "Você é assistente cordial e profissional. Responda em português de forma objetiva.";
  const specificInst = config.instructions || "";
  const history = webhookMessages.filter(m => m.phone === phone)
    .slice(0, 8).reverse()
    .map(m => `${m.fromMe ? "Assistente" : senderName}: ${m.text}`).join("\n");

  try {
    const r = await httpsPost("api.anthropic.com", "/v1/messages",
      { "Content-Type": "application/json", "x-api-key": claudeKey, "anthropic-version": "2023-06-01" },
      {
        model: "claude-haiku-4-5-20251001", max_tokens: 400,
        system: [
          globalInst,
          specificInst ? `\nContexto — ${senderName}:\n${specificInst}` : "",
          "\nSe fora do contexto, responda APENAS: FORA_DO_CONTEXTO",
        ].filter(Boolean).join(""),
        messages: [{ role: "user", content: history ? `${history}\n\n${senderName}: ${userText}` : userText }]
      }
    );
    const reply = r.content?.[0]?.text?.trim();
    const msg = (!reply || reply.includes("FORA_DO_CONTEXTO")) ? fallback : reply;
    await zapiSend(config.zapiInst, config.zapiTok, phone, msg);
    storeAutoMsg(phone, senderName, msg);
    console.log(`🤖 Auto-reply → ${senderName}: ${msg.slice(0, 80)}`);
  } catch (e) { console.error("Auto-reply error:", e.message); }
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
      const isImage = !isAudio && isImageMessage(p);
      const isDoc = !isAudio && !isImage && isDocumentMessage(p);
      let text = typeof p.text === "object" ? (p.text?.message || "") : (p.text || p.caption || p.body || p.message || "");

      // Detect message type
      let msgType = "text";
      let mediaUrl = null, fileName = null, mimeType = null, caption = null;

      if (isAudio) {
        msgType = "audio";
        const audioUrl = extractAudioUrl(p);
        if (audioUrl && process.env.OPENAI_API_KEY) {
          try {
            console.log(`🎙 Transcrevendo áudio...`);
            const ext = (audioUrl.split("?")[0].split(".").pop() || "ogg").slice(0, 4);
            const buf = await downloadBuffer(audioUrl);
            const t = await transcribeAudio(buf, `audio.${ext}`);
            text = t ? `[Áudio] ${t}` : "[Áudio - não transcrito]";
            if (t) console.log(`✓ Transcrição: ${t.slice(0, 100)}`);
          } catch (e) { text = "[Áudio - erro na transcrição]"; }
        } else if (!process.env.OPENAI_API_KEY) {
          text = "[Áudio - configure OPENAI_API_KEY para transcrever]";
        }
        mediaUrl = extractAudioUrl(p);
      } else if (isImage) {
        msgType = "image";
        mediaUrl = extractImageUrl(p);
        caption = p.caption || "";
        text = caption || "[Imagem]";
      } else if (isDoc) {
        msgType = "document";
        const di = extractDocumentInfo(p);
        mediaUrl = di.url; fileName = di.name; mimeType = di.mimeType;
        caption = p.caption || "";
        text = `[Documento: ${fileName}]${caption ? " — " + caption : ""}`;
      }

      const needsText = text.trim() || msgType !== "text";
      if (needsText) {
        // Normalize phone — strip LID format completely
        const rawPhone = (p.phone || p.from || p.chatId || "")
          .replace(/@\S+$/, "")    // remove @c.us, @lid, @g.us etc
          .replace(/:\d+$/, "");   // remove :154164128 LID suffix
        const phoneFull = rawPhone.replace(/[^0-9]/g, "");
        // Store raw full digits — matching uses fingerprint, not exact length
        const phone = phoneFull;
        const fromMe = p.fromMe || false;
        let senderName;
        if (fromMe) {
          senderName = "Você";
        } else {
          const raw = p.senderName || p.pushname || p.notifyName || "";
          const clean = raw.trim().replace(/^[.\-_\s]+$/, "");
          senderName = clean.length > 1 ? clean : (phone.slice(-11) || "Desconhecido");
        }

        const msgData = {
          id: Date.now() + Math.random(),
          phone, senderName, text,
          type: msgType, isAudio: msgType === "audio",
          mediaUrl, fileName, mimeType, caption,
          isGroup: (p.chatId || "").includes("@g.us"),
          fromMe,
          timestamp: p.momentsAgo || p.messageTimestamp || Math.floor(Date.now() / 1000),
          receivedAt: new Date().toISOString(),
        };
        webhookMessages.unshift(msgData);
        if (webhookMessages.length > MAX_MESSAGES) webhookMessages.pop();
        console.log(`📨 ${new Date().toLocaleTimeString("pt-BR")} | ${senderName}: ${text.slice(0, 80)}`);

        // Auto-reply — uses fingerprint matching (last 8 digits of 12-digit version)
        if (!fromMe && !msgData.isGroup) {
          const fp = phoneFingerprint(phone);
          console.log(`🔍 Auto-reply check: phone=${phone} fp=${fp} | ${autoReplyContacts.length} contatos configurados`);
          const cfg = autoReplyContacts.find(c => {
            const match = c.enabled && phoneMatch(phone, c.phone);
            if (match) console.log(`✅ Match: ${c.name} (${c.phone}) enabled=${c.enabled} zapiInst=${!!c.zapiInst} zapiTok=${!!c.zapiTok}`);
            return match;
          });
          if (!cfg) console.log(`⚠️ Nenhum contato com auto-reply habilitado para ${phone}`);
          if (cfg) setTimeout(() => generateAndSendAutoReply(cfg, msgData, phone), 1500);
        }
      }
    } catch (e) { console.error("Webhook parse error:", e.message); }
    return json(res, { ok: true });
  }

  // ── Webhook messages ──────────────────────────────────────────────────────
  if (url === "/webhook-messages" && req.method === "GET") return json(res, webhookMessages.filter(m=>!m.processed));
  if (url === "/webhook-messages/all" && req.method === "GET") return json(res, webhookMessages);
  if (url === "/webhook-messages/count" && req.method === "GET") return json(res, { count: webhookMessages.filter(m=>!m.processed).length });
  if (url === "/webhook-messages/clear" && req.method === "POST") {
    webhookMessages.forEach(m => { m.processed = true; });
    if (webhookMessages.length > 500) webhookMessages.splice(500);
    return json(res, { ok: true });
  }
  if (url === "/webhook-messages/fix-lids" && req.method === "POST") {
    const knownPhones = autoReplyContacts.map(c => c.phone.replace(/\D/g,""));
    function matchesKnown(p) {
      return knownPhones.some(k => k===p || p.endsWith(k.slice(-8)) || k.endsWith(p.slice(-8)));
    }
    function bestPhone(digits) {
      if (digits.length <= 13) return digits;
      const p12 = digits.slice(0, 12);
      const p13 = digits.slice(0, 13);
      // Prefer the version that matches a known contact
      if (matchesKnown(p12) && !matchesKnown(p13)) return p12;
      if (matchesKnown(p13) && !matchesKnown(p12)) return p13;
      // Neither or both match — use 12 for 8-digit Brazilian numbers, 13 for 9-digit
      // 9-digit mobile (9-prefix): 5th char after country+DDD is '9'
      // e.g. 55519_9_xxxxxxxx — digit at index 4 AND 5 both start with 9
      // But we can't know reliably, so default to 12 (safer—avoids LID contamination)
      return p12;
    }
    let fixed = 0;
    webhookMessages.forEach(m => {
      const digits = String(m.phone||"").replace(/@\S+$/,"").replace(/:\d+$/,"").replace(/\D/g,"");
      if (digits.length > 13) { m.phone = bestPhone(digits); fixed++; }
    });
    autoReplyContacts.forEach(c => {
      const digits = String(c.phone||"").replace(/@\S+$/,"").replace(/:\d+$/,"").replace(/\D/g,"");
      if (digits.length > 13) { c.phone = bestPhone(digits); fixed++; }
    });
    console.log(`🔧 fix-lids: corrigidos ${fixed} número(s)`);
    return json(res, { ok: true, fixed });
  }
  if (url === "/webhook-messages/purge" && req.method === "POST") {
    webhookMessages.length = 0;
    return json(res, { ok: true });
  }
  if (url === "/webhook-messages/mark-read" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const { phone } = JSON.parse(body);
      let count = 0;
      webhookMessages.forEach(m => {
        if (!m.fromMe && !m.read && phoneMatch(m.phone, phone)) {
          m.read = true;
          count++;
        }
      });
      return json(res, { ok: true, marked: count });
    } catch(e) { return json(res, { error: e.message }, 400); }
  }
  // Forward media to another contact via Z-API
  if (url === "/forward-media" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const { targetPhone, type, mediaUrl, fileName, caption, zapiInst, zapiTok } = JSON.parse(body);
      if (!targetPhone || !mediaUrl || !zapiInst || !zapiTok) return json(res, { error: "Missing fields" }, 400);
      let zapiPath, zapiBody;
      if (type === "image") {
        zapiPath = `/instances/${zapiInst}/token/${zapiTok}/send-image`;
        zapiBody = { phone: targetPhone, image: mediaUrl, caption: caption || "" };
      } else if (type === "document") {
        zapiPath = `/instances/${zapiInst}/token/${zapiTok}/send-document`;
        zapiBody = { phone: targetPhone, document: mediaUrl, fileName: fileName || "documento", caption: caption || "" };
      } else if (type === "audio") {
        zapiPath = `/instances/${zapiInst}/token/${zapiTok}/send-audio`;
        zapiBody = { phone: targetPhone, audio: mediaUrl };
      } else {
        return json(res, { error: "Unsupported type" }, 400);
      }
      const result = await httpsPost("api.z-api.io", zapiPath,
        { "Content-Type": "application/json", "Client-Token": process.env.ZAPI_CLIENT_TOKEN || "" },
        zapiBody
      );
      return json(res, { ok: true, result });
    } catch(e) { return json(res, { error: e.message }, 500); }
  }
  if (url === "/webhook-messages/inject" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const d = JSON.parse(body);
      webhookMessages.unshift({
        id: Date.now() + Math.random(),
        phone: d.phone || "manual", senderName: d.senderName || d.name || "Manual",
        text: d.text || d.message || "", type: d.type || "text",
        isAudio: false, isGroup: false, fromMe: d.fromMe || false,
        mediaUrl: d.mediaUrl || null, fileName: d.fileName || null,
        timestamp: Math.floor(Date.now() / 1000), receivedAt: new Date().toISOString(),
      });
      return json(res, { ok: true });
    } catch(e) { return json(res, { error: e.message }, 400); }
  }

  // ── Debug endpoint ────────────────────────────────────────────────────────
  if (url === "/debug" && req.method === "GET") {
    const recent = webhookMessages.slice(0, 5).map(m => ({
      phone: m.phone, name: m.senderName, text: m.text?.slice(0,50),
      fromMe: m.fromMe, type: m.type, time: m.receivedAt
    }));
    return json(res, {
      status: "online",
      webhookMessages: webhookMessages.length,
      autoReplyContacts: autoReplyContacts.map(c => ({
        phone: c.phone, name: c.name, enabled: c.enabled,
        hasInst: !!(c.instructions), hasZapi: !!(c.zapiInst && c.zapiTok),
        hasClaude: !!(c.claudeKey || process.env.CLAUDE_API_KEY),
        sequence: c.sequence?.length || 0
      })),
      recentMessages: recent,
      env: {
        hasClaude: !!process.env.CLAUDE_API_KEY,
        hasOpenAI: !!process.env.OPENAI_API_KEY,
        hasZapiToken: !!process.env.ZAPI_CLIENT_TOKEN,
      }
    });
  }


  if (url === "/auto-reply" && req.method === "GET") return json(res, autoReplyContacts);

  if (url === "/auto-reply/save" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const d = JSON.parse(body);
      const idx = autoReplyContacts.findIndex(c => c.phone === d.phone);
      const entry = {
        phone: d.phone, name: d.name || d.phone,
        enabled: d.enabled !== false,
        instructions: d.instructions || "",
        globalInstructions: d.globalInstructions || "",
        fallbackMsg: d.fallbackMsg || "",
        sequence: Array.isArray(d.sequence) ? d.sequence : [],
        welcomeMsg: d.welcomeMsg || "",
        zapiInst: d.zapiInst || "", zapiTok: d.zapiTok || "",
        claudeKey: d.claudeKey || "",
        savedAt: new Date().toISOString(),
      };
      if (idx >= 0) autoReplyContacts[idx] = entry;
      else autoReplyContacts.push(entry);
      return json(res, { ok: true });
    } catch(e) { return json(res, { error: e.message }, 400); }
  }

  if (url === "/auto-reply/toggle" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const { phone, enabled } = JSON.parse(body);
      const c = autoReplyContacts.find(c => c.phone === phone);
      if (c) { c.enabled = enabled; return json(res, { ok: true }); }
      return json(res, { error: "Not found" }, 404);
    } catch(e) { return json(res, { error: e.message }, 400); }
  }

  if (url === "/auto-reply/remove" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const { phone } = JSON.parse(body);
      const idx = autoReplyContacts.findIndex(c => c.phone === phone);
      if (idx >= 0) autoReplyContacts.splice(idx, 1);
      return json(res, { ok: true });
    } catch(e) { return json(res, { error: e.message }, 400); }
  }

  if (url.startsWith("/auto-reply/sequence-state") && req.method === "GET") {
    const phone = new URL("http://x" + url).searchParams.get("phone") || "";
    const norm = phone.replace(/\D/g,"");
    const key = Object.keys(sequenceState).find(k => phoneMatch(k, norm)) || norm;
    return json(res, { state: sequenceState[key] || { step: 0 } });
  }

  if (url === "/auto-reply/sequence-reset" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const { phone } = JSON.parse(body);
      const norm = phone.replace(/\D/g,"");
      const key = Object.keys(sequenceState).find(k => phoneMatch(k, norm)) || norm;
      sequenceState[key] = { step: 0 };
      return json(res, { ok: true });
    } catch(e) { return json(res, { error: e.message }, 400); }
  }

  if (url === "/auto-reply/extract-from-text" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const { text, contact, claudeKey } = JSON.parse(body);
      const key = claudeKey || process.env.CLAUDE_API_KEY;
      if (!key) return json(res, { error: "No Claude API key" }, 400);
      const r = await httpsPost("api.anthropic.com", "/v1/messages",
        { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        {
          model: "claude-haiku-4-5-20251001", max_tokens: 700,
          system: "Você analisa conversas do WhatsApp e extrai informações sobre o contato. Retorne APENAS JSON válido, sem markdown.",
          messages: [{ role: "user", content:
            `Analise esta conversa com ${contact} e extraia informações relevantes.\n\nConversa:\n${text.slice(0,8000)}\n\nRetorne JSON: {"items":[{"key":"Nome","value":"...","icon":"👤"},{"key":"Preferências","value":"...","icon":"⚙"}]}`
          }]
        }
      );
      const raw = r.content?.[0]?.text?.replace(/```json\n?|```/g,"").trim() || '{"items":[]}';
      return json(res, JSON.parse(raw));
    } catch(e) { return json(res, { items: [] }); }
  }


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
