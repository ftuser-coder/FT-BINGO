const https = require("https");
const TELEGRAM_BOT_TOKEN = "8287316935:AAEYYEYDMlG_ZODZFJKvgBnRiivbNK4tuNE";

function callTelegramApi(method, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_BOT_TOKEN}/${method}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(JSON.parse(body)));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

module.exports = {
  sendMessage: (chatId, text, replyMarkup) => callTelegramApi("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup: replyMarkup }),
  answerCallbackQuery: (id, text) => callTelegramApi("answerCallbackQuery", { callback_query_id: id, text }),
  editMessageText: (chatId, msgId, text) => callTelegramApi("editMessageText", { chat_id: chatId, message_id: msgId, text, parse_mode: "HTML" })
};
