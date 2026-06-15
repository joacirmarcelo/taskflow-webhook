const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const webhookMessages = [];
const MAX_MESSAGES = 1000;
let lastRawWebhook = null;
const recentSends = []; // tracks messages sent from platform to dedup fromMe webhooks
const sequenceState = {};

// LID→Phone map: WhatsApp uses internal IDs (LIDs) instead of real phone numbers
// for some accounts. LIDs look like random 12-digit numbers (e.g. 247716701597).
// This map learns the real phone from RECEIVED messages and resolves LIDs for sent messages.
const LID_MAP_FILE = "/tmp/lid-map.json";
let lidToPhone = {};
try {
  if (fs.existsSync(LID_MAP_FILE)) lidToPhone = JSON.parse(fs.readFileSync(LID_MAP_FILE, "utf8")) || {};
  if (Object.keys(lidToPhone).length > 0) console.log(`📂 ${Object.keys(lidToPhone).length} mapeamento(s) LID→Phone carregado(s)`);
} catch (e) {}
function saveLidMap() {
  try { fs.writeFileSync(LID_MAP_FILE, JSON.stringify(lidToPhone)); } catch (e) {}
}
// When we receive a message with a known real phone, learn all LID identifiers
function learnLid(payload, realPhone) {
  let changed = false;
  // Standard fields: map chatId/phone/from → realPhone (requires realPhone)
  if (realPhone && realPhone.length >= 8) {
    [payload.chatId, payload.phone, payload.from].forEach(raw => {
      if (!raw) return;
      const id = String(raw).replace(/@\S+$/, "").replace(/:\d+$/, "").replace(/\D/g, "");
      if (id && id !== realPhone && id.length >= 8) {
        const looksLikeLid = !id.startsWith("55") || id.length > 13;
        if (looksLikeLid && lidToPhone[id] !== realPhone) {
          lidToPhone[id] = realPhone;
          changed = true;
          console.log(`🔗 LID: ${id} → ${realPhone}`);
        }
      }
    });
  }
  // Group participant: map participantLid → participantPhone (always, no realPhone needed)
  if (payload.participantLid && payload.participantPhone) {
    const lid = String(payload.participantLid).replace(/@\S+$/, "").replace(/:\d+$/, "").replace(/\D/g, "");
    const ph = String(payload.participantPhone).replace(/@\S+$/, "").replace(/:\d+$/, "").replace(/\D/g, "");
    if (lid && ph && lid !== ph && ph.startsWith("55") && lidToPhone[lid] !== ph) {
      lidToPhone[lid] = ph;
      changed = true;
      console.log(`🔗 Group LID: ${lid} → ${ph} (${payload.senderName || "?"})`);
    }
  }
  if (changed) saveLidMap();
}
function resolveLid(raw) {
  const id = String(raw || "").replace(/@\S+$/, "").replace(/:\d+$/, "").replace(/\D/g, "");
  return lidToPhone[id] || null;
}

// Check if a phone number is a real Brazilian number (not a WhatsApp LID)
function isRealPhone(phone) {
  const p = String(phone || "").replace(/\D/g, "");
  return p.startsWith("55") && p.length >= 10 && p.length <= 13;
}

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
      if (res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode} ao baixar mídia`));
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        buf._contentType = res.headers["content-type"] || null;
        resolve(buf);
      });
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

// Send message via Z-API — ensures Brazilian country code
async function zapiSend(zapiInst, zapiTok, phone, message) {
  let p = String(phone||"").replace(/\D/g,"");
  if (p.length <= 11 && !p.startsWith("55")) p = "55" + p;
  console.log(`📤 zapiSend → inst=${zapiInst?.slice(0,8)} phone=${p} msg="${message?.slice(0,40)}"`);
  const result = await httpsGet("api.z-api.io",
    `/instances/${zapiInst}/token/${zapiTok}/send-text`,
    { "Content-Type": "application/json", "Client-Token": process.env.ZAPI_CLIENT_TOKEN || "" },
    { phone: p, message }
  );
  console.log(`📤 zapiSend result:`, JSON.stringify(result).slice(0,120));
  return result;
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
const AUTOREPLY_FILE = "/tmp/autoreply.json";
let autoReplyContacts = [];
// Load persisted auto-reply configs on startup
try {
  if (fs.existsSync(AUTOREPLY_FILE)) {
    autoReplyContacts = JSON.parse(fs.readFileSync(AUTOREPLY_FILE, "utf8")) || [];
    console.log(`📂 ${autoReplyContacts.length} configuração(ões) de auto-reply carregada(s)`);
  }
} catch (e) { console.error("Erro ao carregar auto-reply:", e.message); }
function saveAutoReplyToDisk() {
  try { fs.writeFileSync(AUTOREPLY_FILE, JSON.stringify(autoReplyContacts)); }
  catch (e) { console.error("Erro ao salvar auto-reply:", e.message); }
}

// ── SCHEDULING SUGGESTIONS (IA suggests, user approves) ───────────────────────
const SUGGEST_FILE = "/tmp/suggestions.json";
let scheduleSuggestions = [];
try {
  if (fs.existsSync(SUGGEST_FILE)) scheduleSuggestions = JSON.parse(fs.readFileSync(SUGGEST_FILE, "utf8")) || [];
} catch (e) { console.error("Erro ao carregar sugestões:", e.message); }
function saveSuggestionsToDisk() {
  try { fs.writeFileSync(SUGGEST_FILE, JSON.stringify(scheduleSuggestions)); }
  catch (e) { console.error("Erro ao salvar sugestões:", e.message); }
}

// Available time slots, synced from the frontend calendar (so IA can suggest times)
const SLOTS_FILE = "/tmp/slots.json";
let availableSlots = {}; // { "2026-06-15": [{time:"09:00",duration:30}], ... }
try {
  if (fs.existsSync(SLOTS_FILE)) availableSlots = JSON.parse(fs.readFileSync(SLOTS_FILE, "utf8")) || {};
} catch (e) {}
function saveSlotsToDisk() {
  try { fs.writeFileSync(SLOTS_FILE, JSON.stringify(availableSlots)); } catch (e) {}
}

// Detect scheduling intent in a message (keyword-based, fast)
function hasSchedulingIntent(text) {
  const t = (text || "").toLowerCase();
  return /\b(agendar|agenda|marcar|marca|hor[áa]rio|consulta|exame|atend|dispon[íi]vel|que dia|qual dia|qual hora|que hora|reservar|encaixe|vaga)\b/.test(t);
}

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

  // ── SCHEDULING: if the contact asks about scheduling, create a SUGGESTION
  // for the user to approve (instead of confirming automatically).
  if (hasSchedulingIntent(userText)) {
    // Find the next available slots (today onward)
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = Object.keys(availableSlots)
      .filter(d => d >= today)
      .sort()
      .flatMap(d => (availableSlots[d] || []).map(s => ({ date: d, time: s.time, duration: s.duration })))
      .slice(0, 5);

    // Create a pending suggestion (don't message the contact yet — wait for approval)
    const suggestion = {
      id: Date.now() + "_" + Math.random().toString(36).slice(2, 8),
      phone, contactName: senderName,
      requestText: userText.slice(0, 200),
      suggestedSlots: upcoming,
      proposedDraft: upcoming.length
        ? `Olá! Tenho estes horários disponíveis: ${upcoming.map(s => `${new Date(s.date+"T12:00:00").toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"})} às ${s.time}`).join(", ")}. Qual prefere?`
        : `Olá! Vou verificar a disponibilidade de horários e retorno em breve.`,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    scheduleSuggestions.unshift(suggestion);
    if (scheduleSuggestions.length > 100) scheduleSuggestions.pop();
    saveSuggestionsToDisk();
    console.log(`📅 Sugestão de agendamento criada para ${senderName} (aguardando aprovação)`);
    return; // do NOT auto-reply; wait for user to approve/edit the suggestion
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
      await httpsGet("api.z-api.io", path,
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
      // Store last raw payload + log group payloads to discover the group-name field
      lastRawWebhook = p;
      const wType = p.type || p.notification || p.status || "?";
      console.log(`📩 webhook: type=${wType} fromMe=${!!p.fromMe} phone=${(p.phone||"?").slice(0,15)} text="${(p.text||"").slice(0,30)}"`);
      if ((p.chatId || "").includes("@g.us")) {
        console.log("👥 GROUP RAW PAYLOAD:", JSON.stringify(p).slice(0, 600));
      }

      // Handle message revoke/delete — remove from stored messages
      if (p.notification === "REVOKE" || p.type === "REVOKE" || p.status === "REVOKE") {
        const revokedId = p.messageId || p.id || p.referencedMessage?.messageId;
        if (revokedId) {
          const idx = webhookMessages.findIndex(m => m.messageId === revokedId);
          if (idx >= 0) {
            console.log(`🗑 Msg revogada: "${webhookMessages[idx].text?.slice(0,30)}" de ${webhookMessages[idx].senderName}`);
            webhookMessages.splice(idx, 1);
          }
        }
        return json(res, { ok: true });
      }

      // Handle read receipts — when you read on the phone, mark as read on platform
      if (p.status === "READ" || p.status === "PLAYED" || p.type === "ReadCallback") {
        const msgId = p.messageId || p.id;
        if (msgId) {
          const msg = webhookMessages.find(m => m.messageId === msgId);
          if (msg && !msg.read) {
            msg.read = true;
            console.log(`👁 Msg lida no celular: "${(msg.text||"").slice(0,30)}" de ${msg.senderName}`);
          }
        }
        // Also mark all messages from this chat as read
        const chatPhone = String(p.phone || p.chatId || "").replace(/@\S+$/, "").replace(/:\d+$/, "").replace(/\D/g, "");
        if (chatPhone) {
          webhookMessages.forEach(m => {
            if (!m.fromMe && !m.read && phoneMatch(m.phone, chatPhone)) m.read = true;
          });
        }
        return json(res, { ok: true });
      }

      const isAudio = isAudioMessage(p);
      const isImage = !isAudio && isImageMessage(p);
      const isDoc = !isAudio && !isImage && isDocumentMessage(p);
      let text = typeof p.text === "object" ? (p.text?.message || "") : (p.text || p.caption || p.body || p.message || "");

      // Detect message type
      let msgType = "text";
      let mediaUrl = null, fileName = null, mimeType = null, caption = null, transcription = null;

      if (isAudio) {
        msgType = "audio";
        const audioUrl = extractAudioUrl(p);
        if (audioUrl && process.env.OPENAI_API_KEY) {
          try {
            console.log(`🎙 Transcrevendo áudio...`);
            const ext = (audioUrl.split("?")[0].split(".").pop() || "ogg").slice(0, 4);
            const buf = await downloadBuffer(audioUrl);
            const t = await transcribeAudio(buf, `audio.${ext}`);
            transcription = t || null;
            text = t ? t : "[Áudio]";
            if (t) console.log(`✓ Transcrição: ${t.slice(0, 100)}`);
          } catch (e) { text = "[Áudio]"; }
        } else if (!process.env.OPENAI_API_KEY) {
          text = "[Áudio]";
        }
        mediaUrl = extractAudioUrl(p);
      } else if (isImage) {
        msgType = "image";
        mediaUrl = extractImageUrl(p);
        caption = p.caption || "";
        text = caption || "[Imagem]";
        console.log(`📷 Imagem recebida: url=${mediaUrl?.slice(0,60)||"null"} caption="${caption}" listSize=${p.listOfMessages?.length||p.quotedMessages?.length||0}`);
      } else if (isDoc) {
        msgType = "document";
        const di = extractDocumentInfo(p);
        mediaUrl = di.url; fileName = di.name; mimeType = di.mimeType;
        caption = p.caption || "";
        text = `[Documento: ${fileName}]${caption ? " — " + caption : ""}`;
      }

      const needsText = text.trim() || msgType !== "text";
      if (needsText) {
        const chatId = p.chatId || p.phone || p.from || "";
        // Z-API marks groups with isGroup:true and/or @g.us in chatId
        const isGroup = p.isGroup === true || chatId.includes("@g.us");
        let groupId = null, groupName = null;
        if (isGroup) {
          groupId = chatId.replace(/@\S+$/, "").replace(/[^0-9-]/g, "");
          // In Z-API group webhooks: chatName = GROUP name, senderName = participant.
          groupName = p.chatName || p.groupName || p.group?.name || p.group?.subject
            || p.groupInfo?.subject || p.chat?.name || p.subject
            || (groupId ? `Grupo …${groupId.slice(-4)}` : "Grupo");
        }
        // Sender phone extraction:
        // - For groups: use participantPhone (the person who sent)
        // - For fromMe direct: chatId has the RECIPIENT number (p.phone may be a Z-API internal ID)
        // - For received direct: p.phone has the sender
        const fromMe = p.fromMe || false;
        let rawSender;
        if (isGroup) {
          rawSender = (p.participantPhone || p.author || p.participant || p.senderPhone || p.phone || "");
        } else if (fromMe) {
          // For sent messages: chatId = "5551999998888@c.us" (the recipient)
          // p.phone might be a Z-API internal ID — avoid it unless chatId is missing
          rawSender = (p.chatId || p.to || p.phone || p.from || "");
        } else {
          rawSender = (p.phone || p.from || p.chatId || "");
        }
        rawSender = String(rawSender).replace(/@\S+$/, "").replace(/:\d+$/, "");
        const senderFull = rawSender.replace(/[^0-9]/g, "");
        const senderPhone = senderFull.length > 12 ? senderFull.slice(0, 12) : senderFull;
        const phone = isGroup ? groupId : senderPhone;

        // LID mapping: learn from ALL messages (groups have participantLid→participantPhone)
        if (!fromMe) {
          learnLid(p, isGroup ? null : phone); // For groups, learnLid extracts participant data from payload
        }
        // Also learn from group fromMe messages (they still have participant info)
        if (isGroup) {
          learnLid(p, null); // Will extract participantLid→participantPhone if present
        }
        if (fromMe && !isGroup) {
          // Try to resolve the LID to a real phone using the map
          const resolved = resolveLid(p.chatId) || resolveLid(p.phone) || resolveLid(p.to);
          if (resolved) {
            console.log(`📱 LID→Phone: ${phone} → ${resolved}`);
          } else {
            console.log(`📱 fromMe: chatId=${p.chatId||"?"} phone=${p.phone||"?"} to=${p.to||"?"} → ${phone} (no LID mapping yet)`);
          }
        }
        let senderName;
        if (fromMe) {
          senderName = "Você";
        } else if (isGroup) {
          // In a group: senderName/participantName = the participant (the person).
          const raw = p.senderName || p.participantName || p.pushname || p.notifyName || "";
          const clean = String(raw).trim().replace(/^[.\-_\s]+$/, "");
          senderName = clean.length > 1 ? clean : (senderPhone.slice(-11) || "Participante");
        } else {
          const raw = p.senderName || p.pushname || p.notifyName || p.chatName || "";
          const clean = String(raw).trim().replace(/^[.\-_\s]+$/, "");
          senderName = clean.length > 1 ? clean : (senderPhone.slice(-11) || "Desconhecido");
        }

        // For fromMe direct chats: resolve LID to real phone number
        let finalPhone = phone;
        if (fromMe && !isGroup) {
          // 1. Try LID map (learned from received messages — most reliable)
          const resolved = resolveLid(p.chatId) || resolveLid(p.phone) || resolveLid(p.to) || resolveLid(phone);
          if (resolved) {
            finalPhone = resolved;
            console.log(`📱 LID resolved: ${phone} → ${finalPhone}`);
          } else {
            // 2. Fallback: phoneMatch against existing messages
            const existing = webhookMessages.find(m => !m.isGroup && phoneMatch(m.phone, phone) && m.phone !== phone);
            if (existing) {
              finalPhone = existing.phone;
              console.log(`📱 phoneMatch: ${phone} → ${finalPhone}`);
            }
          }
          // 3. Dedup: TEXT match against recently sent from platform
          const nowTs = Math.floor(Date.now() / 1000);
          const textTrimmed = (text || "").trim();
          const isDup = recentSends.some(s => s.text === textTrimmed && (nowTs - s.ts) < 120);
          if (isDup) {
            console.log(`🔄 Skip fromMe echo: "${textTrimmed.slice(0,40)}"`);
            return json(res, { ok: true });
          }
          // If LID wasn't resolved and phone doesn't look Brazilian, don't store it at all
          if (!isRealPhone(finalPhone)) {
            console.log(`⚠️ Drop LID fromMe: ${finalPhone} "${text.slice(0,30)}" — no mapping, not BR`);
            return json(res, { ok: true });
          }
        }

        const msgData = {
          id: Date.now() + Math.random(),
          messageId: p.messageId || p.id || p.messageID || null,
          phone: finalPhone, senderName, senderPhone, text,
          type: msgType, isAudio: msgType === "audio",
          mediaUrl, audioUrl: msgType === "audio" ? mediaUrl : null, transcription,
          fileName, mimeType, caption,
          isGroup, groupId, groupName,
          fromMe,
          timestamp: p.momentsAgo || p.messageTimestamp || Math.floor(Date.now() / 1000),
          receivedAt: new Date().toISOString(),
        };
        webhookMessages.unshift(msgData);
        if (webhookMessages.length > MAX_MESSAGES) webhookMessages.pop();
        console.log(`📨 ${new Date().toLocaleTimeString("pt-BR")} | ${fromMe?"📤":"📥"} ${isGroup ? "["+groupName+"] " : ""}${senderName}→${finalPhone}: ${text.slice(0, 80)}`);

        // Auto-reply — only direct chats, never groups
        if (!fromMe && !isGroup) {
          const cfg = autoReplyContacts.find(c => {
            const match = c.enabled && phoneMatch(phone, c.phone);
            if (match) console.log(`✅ Match: ${c.name} (${c.phone}) zapiInst=${!!c.zapiInst} zapiTok=${!!c.zapiTok} claude=${!!(c.claudeKey||process.env.CLAUDE_API_KEY)}`);
            return match;
          });
          if (!cfg) {
            if (autoReplyContacts.filter(c=>c.enabled).length > 0)
              console.log(`⚠️ Nenhum match para ${phone} (fp=${phoneFingerprint(phone)}) entre [${autoReplyContacts.filter(c=>c.enabled).map(c=>c.phone).join(',')}]`);
          }
          if (cfg) {
            // Use cfg.phone (clean configured phone) for sending — avoids LID format rejection
            const sendPhone = cfg.phone;
            setTimeout(() => generateAndSendAutoReply(cfg, msgData, sendPhone), 1500);
          }
        }
      }
    } catch (e) { console.error("Webhook parse error:", e.message); }
    return json(res, { ok: true });
  }

  // ── Webhook messages ──────────────────────────────────────────────────────
  if (url === "/webhook-messages" && req.method === "GET") {
    return json(res, webhookMessages.filter(m => !m.processed && (!m.fromMe || m.isGroup || isRealPhone(m.phone))));
  }
  if (url === "/webhook-messages/all" && req.method === "GET") {
    // Filter out fromMe messages with LID phones (not real Brazilian numbers)
    // This prevents ghost conversations regardless of frontend version
    const filtered = webhookMessages.filter(m => {
      if (!m.fromMe) return true; // received messages always pass
      if (m.isGroup) return true; // group messages always pass
      const p = String(m.phone || "").replace(/\D/g, "");
      // Keep only if phone starts with 55 (Brazil) and is 10-13 digits (real phone)
      return p.startsWith("55") && p.length >= 10 && p.length <= 13;
    });
    return json(res, filtered);
  }
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
      const { phone, zapiInst, zapiTok } = JSON.parse(body);
      let count = 0;
      webhookMessages.forEach(m => {
        if (!m.fromMe && !m.read && phoneMatch(m.phone, phone)) {
          m.read = true;
          count++;
        }
      });
      // Tell WhatsApp to mark this chat as read (so phone badge clears too)
      if (zapiInst && zapiTok && count > 0) {
        const clientToken = process.env.ZAPI_CLIENT_TOKEN || "";
        // Strategy 1: modify-chat marks entire chat as read
        try {
          const result = await httpsPost("api.z-api.io",
            `/instances/${zapiInst}/token/${zapiTok}/modify-chat`,
            { "Content-Type": "application/json", "Client-Token": clientToken },
            { phone, action: "read" });
          console.log(`👁 WhatsApp mark-read: ${phone} → ${JSON.stringify(result).slice(0,80)}`);
        } catch (e) {
          console.log(`⚠️ modify-chat failed: ${e.message}, trying read-message...`);
          // Strategy 2: read individual messages
          const unreadIds = webhookMessages.filter(m => !m.fromMe && m.messageId && phoneMatch(m.phone, phone)).map(m => m.messageId).slice(0, 5);
          for (const msgId of unreadIds) {
            try {
              await httpsPost("api.z-api.io",
                `/instances/${zapiInst}/token/${zapiTok}/read-message`,
                { "Content-Type": "application/json", "Client-Token": clientToken },
                { phone, messageId: msgId });
            } catch (e2) { /* continue */ }
          }
        }
      }
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
      const result = await httpsGet("api.z-api.io", zapiPath,
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
      const ts = Math.floor(Date.now() / 1000);
      webhookMessages.unshift({
        id: Date.now() + Math.random(),
        phone: d.phone || "manual", senderName: d.senderName || d.name || "Manual",
        text: d.text || d.message || "", type: d.type || "text",
        isAudio: false, isGroup: false, fromMe: d.fromMe || false,
        mediaUrl: d.mediaUrl || null, fileName: d.fileName || null,
        timestamp: ts, receivedAt: new Date().toISOString(),
      });
      // Track for dedup: when the Z-API webhook echoes this back, skip it
      if (d.fromMe) {
        recentSends.push({ text: (d.text || d.message || "").trim(), ts });
        // Cleanup old entries (>120s)
        while (recentSends.length > 0 && (ts - recentSends[0].ts) > 120) recentSends.shift();
      }
      return json(res, { ok: true });
    } catch(e) { return json(res, { error: e.message }, 400); }
  }

  // ── Debug endpoint ────────────────────────────────────────────────────────
  if (url.startsWith("/media-proxy") && req.method === "GET") {
    try {
      const u = new URL("http://x" + url);
      const target = u.searchParams.get("url");
      const fname = u.searchParams.get("name");
      if (!target) return json(res, { error: "missing url" }, 400);
      const buf = await downloadBuffer(decodeURIComponent(target));
      // Prefer the real content-type from the source; fall back to extension guess
      const ct = buf._contentType
        || (target.includes(".pdf") ? "application/pdf"
        : target.match(/\.(jpg|jpeg)/i) ? "image/jpeg"
        : target.includes(".png") ? "image/png"
        : target.match(/\.(ogg|oga)/i) ? "audio/ogg"
        : target.includes(".mp3") ? "audio/mpeg"
        : target.includes(".mp4") ? "video/mp4"
        : "application/octet-stream");
      const headers = { "Content-Type": ct, "Cache-Control": "private, max-age=300", "Vary": "url" };
      // For documents, suggest a filename so the browser downloads/opens correctly
      if (fname && !ct.startsWith("image/") && !ct.startsWith("audio/")) {
        headers["Content-Disposition"] = `inline; filename="${fname.replace(/"/g,"")}"`;
      }
      res.writeHead(200, headers);
      res.end(buf);
      return;
    } catch (e) {
      console.error("media-proxy error:", e.message);
      return json(res, { error: e.message }, 502);
    }
  }
  if (url === "/debug-raw" && req.method === "GET") {
    const recentByType = {};
    webhookMessages.slice(0, 20).forEach(m => {
      const t = m.type || "text";
      if (!recentByType[t]) recentByType[t] = 0;
      recentByType[t]++;
    });
    return json(res, {
      version: "2025-06-12-v5",
      lastRawWebhook,
      lidMapSize: Object.keys(lidToPhone).length,
      lidMap: lidToPhone,
      totalMessages: webhookMessages.length,
      recentByType,
      recent10: webhookMessages.slice(0, 10).map(m => ({
        phone: m.phone, type: m.type, fromMe: m.fromMe, text: (m.text||"").slice(0,40),
        hasMedia: !!(m.mediaUrl), time: m.receivedAt
      }))
    });
  }

  // ── Sync contacts from Z-API (builds LID→Phone map + contact names) ─────────
  if (url === "/sync-contacts" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const { zapiInst, zapiTok } = JSON.parse(body);
      if (!zapiInst || !zapiTok) return json(res, { error: "Z-API credentials required" }, 400);
      const clientToken = process.env.ZAPI_CLIENT_TOKEN || "";

      // 1. Fetch contacts list
      let contacts = [];
      try {
        const cData = await httpsGet("api.z-api.io",
          `/instances/${zapiInst}/token/${zapiTok}/contacts`,
          { "Content-Type": "application/json", "Client-Token": clientToken });
        contacts = Array.isArray(cData) ? cData : [];
        console.log(`📇 ${contacts.length} contatos obtidos da Z-API`);
      } catch (e) { console.log("⚠️ Erro ao buscar contatos:", e.message); }

      // 2. Fetch chats list (has chatId which may be LID format)
      let chats = [];
      try {
        const chData = await httpsGet("api.z-api.io",
          `/instances/${zapiInst}/token/${zapiTok}/chats`,
          { "Content-Type": "application/json", "Client-Token": clientToken });
        chats = Array.isArray(chData) ? chData : [];
        console.log(`💬 ${chats.length} chats obtidos da Z-API`);
      } catch (e) { console.log("⚠️ Erro ao buscar chats:", e.message); }

      // 3. Build contact name map (phone → name) from contacts
      const nameMap = {}; // phone → name
      let mapped = 0;
      contacts.forEach(c => {
        const phone = String(c.phone || c.jid || c.id || "").replace(/@\S+$/, "").replace(/:\d+$/, "").replace(/\D/g, "");
        const name = c.name || c.pushname || c.notify || c.short || "";
        if (phone && name) nameMap[phone] = name;
      });

      // 4. Map LIDs from chats (chatId may be LID format while phone has real number)
      chats.forEach(ch => {
        const chatId = String(ch.id || ch.chatId || ch.jid || "").replace(/@\S+$/, "").replace(/:\d+$/, "").replace(/\D/g, "");
        const phone = String(ch.phone || ch.contact || "").replace(/@\S+$/, "").replace(/:\d+$/, "").replace(/\D/g, "");
        const name = ch.name || ch.title || ch.contact || "";

        // If chatId looks like a LID and phone looks real, map it
        if (chatId && phone && chatId !== phone && phone.startsWith("55") && phone.length >= 10) {
          if (lidToPhone[chatId] !== phone) {
            lidToPhone[chatId] = phone;
            mapped++;
          }
        }
        // Also try: if chatId is real but has LID suffix, map the LID part
        if (chatId && phone && chatId.length > 13 && phone.startsWith("55")) {
          const lid = chatId.slice(12); // strip the phone prefix to get LID part
          if (lid.length >= 6 && lidToPhone[chatId] !== phone) {
            lidToPhone[chatId] = phone;
            mapped++;
          }
        }
        // Store name
        if (phone && name) nameMap[phone] = name;
      });

      // 5. Also try to match contacts with chats by name
      contacts.forEach(c => {
        const cPhone = String(c.phone || "").replace(/@\S+$/, "").replace(/\D/g, "");
        const cName = (c.name || c.pushname || "").toLowerCase().trim();
        if (!cPhone || !cName) return;
        chats.forEach(ch => {
          const chId = String(ch.id || ch.chatId || "").replace(/@\S+$/, "").replace(/:\d+$/, "").replace(/\D/g, "");
          const chName = (ch.name || ch.title || "").toLowerCase().trim();
          if (chId && chName && chName === cName && chId !== cPhone && !chId.startsWith("55")) {
            if (lidToPhone[chId] !== cPhone) {
              lidToPhone[chId] = cPhone;
              mapped++;
              console.log(`🔗 Contact→Chat LID: ${chId} → ${cPhone} (${cName})`);
            }
          }
        });
      });

      saveLidMap();
      console.log(`📇 Sync complete: ${mapped} new LID mapping(s), ${Object.keys(nameMap).length} names`);
      return json(res, { ok: true, contacts: contacts.length, chats: chats.length, newMappings: mapped, lidMapSize: Object.keys(lidToPhone).length, nameMap });
    } catch (e) { return json(res, { error: e.message }, 500); }
  }
  // Purge all messages with non-Brazilian phone numbers (LID ghosts)
  if (url === "/webhook-messages/purge-lids" && req.method === "POST") {
    const before = webhookMessages.length;
    const removed = [];
    for (let i = webhookMessages.length - 1; i >= 0; i--) {
      const m = webhookMessages[i];
      if (m.fromMe && !m.isGroup && m.phone && !String(m.phone).startsWith("55")) {
        removed.push({ phone: m.phone, text: (m.text||"").slice(0,30) });
        webhookMessages.splice(i, 1);
      }
    }
    console.log(`🧹 Purged ${removed.length} LID ghost messages (${before} → ${webhookMessages.length})`);
    return json(res, { ok: true, purged: removed.length, remaining: webhookMessages.length });
  }
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

  // ── Test auto-reply endpoint ─────────────────────────────────────────────
  if (url === "/auto-reply/test-send" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const d = JSON.parse(body);
      const phone = String(d.phone||"").replace(/\D/g,"");
      const cfg = (phone ? autoReplyContacts.find(c => c.enabled && phoneMatch(phone, c.phone)) : null)
        || autoReplyContacts.find(c => c.enabled);
      if (!cfg) return json(res, { error: "Nenhum contato com auto-reply ativo", total: autoReplyContacts.length }, 404);
      if (!cfg.zapiInst || !cfg.zapiTok) return json(res, { error: "Z-API não configurado neste contato", name: cfg.name, hint: "Abra Config > salve novamente com credenciais Z-API" }, 400);
      const msg = d.message || "✅ Teste de auto-reply funcionando!";
      const result = await zapiSend(cfg.zapiInst, cfg.zapiTok, cfg.phone, msg);
      return json(res, { ok: true, sentTo: cfg.phone, name: cfg.name, result });
    } catch(e) { return json(res, { error: e.message }, 500); }
  }

  if (url === "/auto-reply" && req.method === "GET") return json(res, autoReplyContacts);

  // ── Scheduling suggestions ──────────────────────────────────────────────────
  if (url === "/suggestions" && req.method === "GET") {
    return json(res, scheduleSuggestions.filter(s => s.status === "pending"));
  }
  if (url === "/suggestions/sync-slots" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const { slots } = JSON.parse(body);
      if (slots && typeof slots === "object") { availableSlots = slots; saveSlotsToDisk(); }
      return json(res, { ok: true, days: Object.keys(availableSlots).length });
    } catch(e) { return json(res, { error: e.message }, 400); }
  }
  if (url === "/suggestions/approve" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const { id, message, zapiInst, zapiTok } = JSON.parse(body);
      const sug = scheduleSuggestions.find(s => s.id === id);
      if (!sug) return json(res, { error: "Sugestão não encontrada" }, 404);
      const inst = zapiInst || sug.zapiInst, tok = zapiTok || sug.zapiTok;
      const text = message || sug.proposedDraft;
      if (inst && tok) {
        await zapiSend(inst, tok, sug.phone, text);
        storeAutoMsg(sug.phone, sug.contactName, text);
      }
      sug.status = "approved";
      saveSuggestionsToDisk();
      return json(res, { ok: true });
    } catch(e) { return json(res, { error: e.message }, 500); }
  }
  if (url === "/suggestions/reject" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const { id } = JSON.parse(body);
      const sug = scheduleSuggestions.find(s => s.id === id);
      if (sug) { sug.status = "rejected"; saveSuggestionsToDisk(); }
      return json(res, { ok: true });
    } catch(e) { return json(res, { error: e.message }, 400); }
  }

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
      saveAutoReplyToDisk();
      return json(res, { ok: true });
    } catch(e) { return json(res, { error: e.message }, 400); }
  }

  if (url === "/auto-reply/toggle" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const { phone, enabled } = JSON.parse(body);
      const c = autoReplyContacts.find(c => c.phone === phone);
      if (c) { c.enabled = enabled; saveAutoReplyToDisk(); return json(res, { ok: true }); }
      return json(res, { error: "Not found" }, 404);
    } catch(e) { return json(res, { error: e.message }, 400); }
  }

  if (url === "/auto-reply/remove" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const { phone } = JSON.parse(body);
      const idx = autoReplyContacts.findIndex(c => c.phone === phone);
      if (idx >= 0) autoReplyContacts.splice(idx, 1);
      saveAutoReplyToDisk();
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
