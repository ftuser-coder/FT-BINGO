const crypto = require("crypto");
const express = require("express");
const appServer = express();

// Adjusting the relative path imports since index.js moved up one level
const { getCard, hasBingo } = require("./functions/cartela");
const { sendMessage, answerCallbackQuery, editMessageText } = require("./functions/telegram");

// ============ FT BINGO CONFIGURATION ============
const TELEGRAM_BOT_TOKEN = "8313850405:AAHZis31QfYGr3RF6_YfkMXn4ZEVQNmeA44";
const ADMIN_TELEGRAM_ID = 6502378631; 
const DEFAULT_TELEBIRR_NUMBER = "0969437501"; 
const FIRST_DEPOSIT_BONUS = 10;
const HOUSE_CUT = 0.2;
const MAX_CARTELAS_PER_PLAYER = 2;

// ============ IN-MEMORY STORAGE ============
const localDatabase = {
  users: {},
  rooms: {}
};

appServer.use(express.json());

// Serving your root index.html file to users launching the mini-app interface
appServer.use(express.static(__dirname));

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toPositiveInteger(value) {
  const number = toFiniteNumber(value);
  return number !== null && Number.isInteger(number) && number > 0 ? number : null;
}

// ============ WEB LOGIN ROUTINE ============
async function verifyTelegramLogin(reqData) {
  const { initData } = reqData;
  if (!initData) throw new Error("initData required");
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDateValue = params.get("auth_date");
  const userValue = params.get("user");
  if (!hash || !authDateValue || !userValue) throw new Error("Invalid Telegram WebApp data");
  params.delete("hash");
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(TELEGRAM_BOT_TOKEN).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (hash !== computedHash) throw new Error("Invalid Telegram signature");

  let user = JSON.parse(userValue);
  const uid = `tg_${user.id}`;
  
  let profile = localDatabase.users[uid];
  if (!profile) {
    profile = { mainWallet: 0, playWallet: 1000, bonus: 0, firstDepositBonusGiven: false, name: user.first_name || "Player", telegramId: user.id };
    localDatabase.users[uid] = profile;
  }
  return { uid, mainWallet: profile.mainWallet || 0, playWallet: profile.playWallet || 0, bonus: profile.bonus || 0 };
}

// ============ MULTIPLAYER JOIN MATCH ROUTINE ============
async function joinRoom(reqData, uid) {
  if (!uid) throw new Error("Unauthenticated");
  const { stake, cartelaNumbers } = reqData;
  const parsedStake = toPositiveInteger(stake);
  if (parsedStake === null || !Array.isArray(cartelaNumbers)) throw new Error("Invalid arguments");
  
  const totalCost = parsedStake * cartelaNumbers.length;
  let profile = localDatabase.users[uid];
  if (!profile || (profile.playWallet || 0) < totalCost) throw new Error("Insufficient balance");

  const roomId = `stake_${parsedStake}_open`;
  let room = localDatabase.rooms[roomId];
  if (!room) room = { stake: parsedStake, state: "waiting", players: {}, taken: {}, cartelaCount: 0 };

  cartelaNumbers.forEach(num => {
    room.taken[num] = true;
    room.players[uid] = { cartelaNumbers, joinedAt: Date.now() };
  });
  room.cartelaCount = (room.cartelaCount || 0) + cartelaNumbers.length;

  profile.playWallet -= totalCost;
  localDatabase.users[uid] = profile;

  if (Object.keys(room.players).length >= 2) room.state = "running";
  localDatabase.rooms[roomId] = room;

  return { roomId, playerCount: Object.keys(room.players).length, playWallet: profile.playWallet };
}

// ============ EXPRESS HANDLERS ============
appServer.post("/verifyTelegramLogin", async (req, res) => {
  try {
    const result = await verifyTelegramLogin(req.body);
    res.status(200).json({ result });
  } catch (err) {
    res.status(403).json({ error: { message: err.message } });
  }
});

appServer.post("/joinRoom", async (req, res) => {
  try {
    const uid = req.headers.uid || "tg_test";
    const result = await joinRoom(req.body, uid);
    res.status(200).json({ result });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

// ============ CLEAN ROOT TELEGRAM WEBHOOK ROUTE ============
appServer.post("/telegram", async (req, res) => {
  try {
    const { message, callback_query } = req.body;

    if (message && message.text) {
      const chatId = message.chat.id;
      const text = message.text;

      if (text === "/start") {
        const welcomeText = "<b>Welcome to FT BINGO!</b> 🎮\n\nReady to play and win? Tap the button below to open your bingo card!";
        const replyMarkup = {
          inline_keyboard: [
            [{ text: "🚀 Play Bingo", web_app: { url: "https://onrender.com" } }]
          ]
        };
        await sendMessage(chatId, welcomeText, replyMarkup);
      }
    }

    if (callback_query) {
      await answerCallbackQuery(callback_query.id, "Loading...");
    }
    res.status(200).send("OK");
  } catch (err) {
    console.error("Telegram webhook error:", err);
    res.status(200).send("OK");
  }
});

const PORT = process.env.PORT || 3000;
appServer.listen(PORT, () => { console.log("FT BINGO backend cluster is running live on root level."); });
