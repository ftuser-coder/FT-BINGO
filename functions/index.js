const crypto = require("crypto");
const https = require("https");
const { getCard, hasBingo } = require("./cartela");
const { sendMessage, answerCallbackQuery, editMessageText } = require("./telegram");

// ============ FT BINGO CONFIGURATION ============
const TELEGRAM_BOT_TOKEN = "8618935818:AAFTP-2-s-5vlamwcYPVDB4STTR19VdHiVg";
const ADMIN_TELEGRAM_ID = 6502378631; 
const DEFAULT_TELEBIRR_NUMBER = "0969437501"; 
const FIRST_DEPOSIT_BONUS = 10;
const HOUSE_CUT = 0.2;
const MAX_CARTELAS_PER_PLAYER = 2;
const DB_URL = "https://firebaseio.com";

// ============ DATABASE HELPER FUNCTION ============
function dbCall(path, method = "GET", data = null) {
  return new Promise((resolve, reject) => {
    const url = `${DB_URL}/${path}.json`;
    const payload = data ? JSON.stringify(data) : "";
    const options = {
      method: method,
      headers: { "Content-Type": "application/json" }
    };
    const req = https.request(url, options, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => resolve(body ? JSON.parse(body) : null));
    });
    req.on("error", reject);
    if (data) req.write(payload);
    req.end();
  });
}

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
  
  let profile = await dbCall(`users/${uid}`);
  if (!profile) {
    profile = { mainWallet: 0, playWallet: 0, bonus: 0, firstDepositBonusGiven: false, name: user.first_name || "Player", telegramId: user.id };
    await dbCall(`users/${uid}`, "PUT", profile);
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
  let profile = await dbCall(`users/${uid}`);
  if (!profile || (profile.playWallet || 0) < totalCost) throw new Error("Insufficient balance");

  const roomId = `stake_${parsedStake}_open`;
  let room = await dbCall(`rooms/${roomId}`);
  if (!room) room = { stake: parsedStake, state: "waiting", players: {}, taken: {}, cartelaCount: 0 };

  cartelaNumbers.forEach(num => {
    room.taken[num] = true;
    room.players[uid] = { cartelaNumbers, joinedAt: Date.now() };
  });
  room.cartelaCount = (room.cartelaCount || 0) + cartelaNumbers.length;

  profile.playWallet -= totalCost;
  await dbCall(`users/${uid}`, "PUT", profile);

  if (Object.keys(room.players).length >= 2) room.state = "running";
  await dbCall(`rooms/${roomId}`, "PUT", room);

  return { roomId, playerCount: Object.keys(room.players).length, playWallet: profile.playWallet };
}

// ============ COMPACT GAME ENGINE DRAW LOOP ============
async function advanceGames() {
  const rooms = await dbCall("rooms") || {};
  for (const [roomId, room] of Object.entries(rooms)) {
    if (room.state !== "running") continue;
    const calledBefore = Object.keys(room.calledNumbers || {}).map(Number);
    const remaining = [];
    for (let n = 1; n <= 75; n++) if (!calledBefore.includes(n)) remaining.push(n);

    if (remaining.length === 0) {
      room.state = "finished";
      await dbCall(`rooms/${roomId}`, "PUT", room);
      continue;
    }

    const next = remaining[Math.floor(Math.random() * remaining.length)];
    room.calledNumbers = room.calledNumbers || {};
    room.calledNumbers[next] = true;
    room.lastCalled = next;

    await dbCall(`rooms/${roomId}`, "PUT", room);
  }
}

// ============ EXPRESS RENDER LIVE BINDINGS ============
const express = require("express");
const appServer = express();
appServer.use(express.json());

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

// ============ TELEGRAM WEBHOOK ROUTE ============
appServer.post("/api/telegram", async (req, res) => {
  try {
    const { message, callback_query } = req.body;

    // Handle normal text messages (like /start)
    if (message && message.text) {
      const chatId = message.chat.id;
      const text = message.text;

      if (text === "/start") {
        const welcomeText = "<b>Welcome to FT BINGO!</b> 🎮\n\nReady to play and win? Tap the button below to open your bingo card!";
        
        // Sets up the Inline Keyboard Button to launch the Telegram WebApp interface
        const replyMarkup = {
          inline_keyboard: [
            [
              { 
                text: "🚀 Play Bingo", 
                web_app: { url: "https://onrender.com" } 
              }
            ]
          ]
        };
        
        await sendMessage(chatId, welcomeText, replyMarkup);
      }
    }

    // Handle button clicks (Callback Queries)
    if (callback_query) {
      await answerCallbackQuery(callback_query.id, "Loading...");
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("Telegram webhook error:", err);
    res.status(200).send("OK"); // Always reply 200 so Telegram doesn't break loop-retrying
  }
});

setInterval(async () => {
  try { await advanceGames(); } catch (err) { console.error(err); }
}, 60000);

const PORT = process.env.PORT || 3000;
appServer.listen(PORT, () => { console.log("FT BINGO backend cluster is running live."); });
