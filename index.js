const express = require("express");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "taskflow2024";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

// ✅ Verificação do webhook pela Meta
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// 📩 Recebe mensagens do WhatsApp
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object === "whatsapp_business_account") {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (messages && messages.length > 0) {
      const msg = messages[0];
      const from = msg.from;
      const text = msg.text?.body;

      if (text) {
        console.log(`📱 Mensagem de ${from}: ${text}`);

        // Envia para Claude extrair tarefas
        try {
          const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: "claude-sonnet-4-20250514",
              max_tokens: 1000,
              system: `Você é um assistente que extrai tarefas de mensagens do WhatsApp.
Analise a mensagem e responda APENAS em JSON no formato:
{
  "tem_tarefa": true/false,
  "tarefas": [
    {
      "titulo": "título da tarefa",
      "projeto": "Trabalho|Pessoal|Financeiro|Estudos|Geral",
      "prioridade": "alta|media|baixa",
      "prazo": "data se mencionada ou null"
    }
  ]
}
Se não houver tarefa, retorne { "tem_tarefa": false, "tarefas": [] }`,
              messages: [{ role: "user", content: text }],
            }),
          });

          const data = await response.json();
          const resultText = data.content?.[0]?.text || "{}";

          let result;
          try {
            result = JSON.parse(resultText.replace(/```json|```/g, "").trim());
          } catch {
            result = { tem_tarefa: false, tarefas: [] };
          }

          if (result.tem_tarefa && result.tarefas.length > 0) {
            console.log("✅ Tarefas extraídas:", JSON.stringify(result.tarefas, null, 2));
            // Aqui você pode salvar no banco de dados ou enviar para sua plataforma
          } else {
            console.log("ℹ️ Nenhuma tarefa identificada na mensagem.");
          }
        } catch (err) {
          console.error("Erro ao chamar Claude:", err);
        }
      }
    }
  }

  res.sendStatus(200);
});

// 🏠 Rota de status
app.get("/", (req, res) => {
  res.json({
    status: "TaskFlow Webhook rodando!",
    versao: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 TaskFlow Webhook rodando na porta ${PORT}`);
  console.log(`🔑 Verify Token: ${VERIFY_TOKEN}`);
});
