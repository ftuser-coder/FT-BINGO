const { onCall, HttpsError, onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const crypto = require("crypto");
const { getCard, hasBingo } = require("./cartela");
const { sendMessage, answerCallbackQuery, editMessageText } = require("./telegram");

admin.initializeApp();
const db = admin.database();

// ============ FT BINGO CONFIGURATION ============
const TELEGRAM_BOT_TOKEN = "8287316935:AAEYYEYDMlG_ZODZFJKvgBnRiivbNK4tuNE";
const ADMIN_TELEGRAM_ID = 6502378631; 
const DEFAULT_TELEBIRR_NUMBER = "0969437501"; 
const FIRST_DEPOSIT_BONUS = 10;
const HOUSE_CUT = 0.2;
const CALL_INTERVAL_MS = 3000;
const MAX_CARTELAS_PER_PLAYER = 2;

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toPositiveInteger(value) {
  const number = toFiniteNumber(value);
  return number !== null && Number.isInteger(number) && number > 0 ? number : null;
}

async function getTelegramProfile(uid) {
  if (typeof uid !== "string" || !/^tg_\d+$/.test(uid)) return null;
  const snapshot = await db.ref(`users/${uid}`).once("value");
  const profile = snapshot.val();
  return profile && String(profile.telegramId) === uid.slice(3) ? profile : null;
}

async function getTelebirrNumber() {
  const snap = await db.ref("settings/telebirrNumber").once("value");
  return snap.val() || DEFAULT_TELEBIRR_NUMBER;
}

// ============ LOGIN ============
exports.verifyTelegramLogin = onCall(async (request) => {
  const { initData } = request.data;
  if (!initData) throw new HttpsError("invalid-argument", "initData required");

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDateValue = params.get("auth_date");
  const userValue = params.get("user");
  if (!hash || !authDateValue || !userValue) throw new HttpsError("invalid-argument", "Invalid Telegram WebApp data");
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(TELEGRAM_BOT_TOKEN).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const computedHashBuffer = Buffer.from(computedHash, "hex");
  const providedHashBuffer = Buffer.from(hash, "hex");
  if (providedHashBuffer.length !== computedHashBuffer.length || !crypto.timingSafeEqual(computedHashBuffer, providedHashBuffer)) {
    throw new HttpsError("permission-denied", "Invalid Telegram signature");
  }

  const authDate = Number(authDateValue);
  const ageSeconds = Date.now() / 1000 - authDate;
  if (!Number.isFinite(authDate) || ageSeconds > 300 || ageSeconds < -30) {
    throw new HttpsError("permission-denied", "initData expired, reopen the app");
  }

  let user;
  try { user = JSON.parse(userValue); } catch { throw new HttpsError("invalid-argument", "Invalid Telegram user data"); }
  if (!user || !user.id) throw new HttpsError("invalid-argument", "Telegram user is required");
  const uid = `tg_${user.id}`;

  const userRef = db.ref(`users/${uid}`);
  const snapshot = await userRef.once("value");
  if (!snapshot.exists()) {
    await userRef.set({
      mainWallet: 0,
      playWallet: 0,
      bonus: 0,
      firstDepositBonusGiven: false,
      name: user.first_name || "Player",
      telegramId: user.id,
      createdAt: admin.database.ServerValue.TIMESTAMP,
    });
  }

  const finalSnap = await userRef.once("value");
  const profile = finalSnap.val();
  const customToken = await admin.auth().createCustomToken(uid);
  return {
    customToken,
    uid,
    mainWallet: toFiniteNumber(profile.mainWallet) || 0,
    playWallet: toFiniteNumber(profile.playWallet) || 0,
    bonus: toFiniteNumber(profile.bonus) || 0,
  };
});

// ============ JOIN ROOM ============
exports.joinRoom = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first");
  if (!(await getTelegramProfile(uid))) throw new HttpsError("permission-denied", "Telegram user verification required");

  const { stake, cartelaNumbers } = request.data;
  const parsedStake = toPositiveInteger(stake);
  if (parsedStake === null) throw new HttpsError("invalid-argument", "Invalid room stake");

  if (!Array.isArray(cartelaNumbers) || cartelaNumbers.length < 1 || cartelaNumbers.length > MAX_CARTELAS_PER_PLAYER) {
    throw new HttpsError("invalid-argument", `Choose 1 to ${MAX_CARTELAS_PER_PLAYER} cartelas`);
  }
  const parsedNumbers = [...new Set(cartelaNumbers.map(toPositiveInteger))];
  if (parsedNumbers.includes(null) || parsedNumbers.some((n) => n > 100) || parsedNumbers.length !== cartelaNumbers.length) {
    throw new HttpsError("invalid-argument", "Invalid cartela number(s)");
  }

  const totalCost = parsedStake * parsedNumbers.length;
  const roomId = `stake_${parsedStake}_open`;
  const roomRef = db.ref(`rooms/${roomId}`);
  const playWalletRef = db.ref(`users/${uid}/playWallet`);

  const balanceResult = await playWalletRef.transaction((current) => {
    const balance = toFiniteNumber(current);
    if (balance === null || balance < totalCost) return;
    return balance - totalCost;
  });
  if (!balanceResult.committed) {
    const balance = toFiniteNumber(balanceResult.snapshot.val());
    throw new HttpsError("failed-precondition", `Insufficient play wallet balance. You have ${balance === null ? 0 : balance} ETB; ${totalCost} ETB required.`);
  }

  const joinResult = await roomRef.transaction((room) => {
    room = room || { stake: parsedStake, state: "waiting", players: {}, taken: {}, cartelaCount: 0 };
    if (room.state !== "waiting") return;
    if (Number(room.stake) !== parsedStake) return;
    room.taken = room.taken || {};
    for (const num of parsedNumbers) {
      if (room.taken[num]) return;
    }
    room.players = room.players || {};
    room.players[uid] = { cartelaNumbers: parsedNumbers, joinedAt: Date.now() };
    for (const num of parsedNumbers) room.taken[num] = true;
    room.cartelaCount = (room.cartelaCount || 0) + parsedNumbers.length;
    return room;
  });

  if (!joinResult.committed) {
    await playWalletRef.transaction((current) => (toFiniteNumber(current) || 0) + totalCost);
    throw new HttpsError("failed-precondition", "Could not join room (a cartela is already taken or room started)");
  }

  const room = joinResult.snapshot.val();
  const playerCount = Object.keys(room.players).length;

  if (playerCount >= 2 && room.state === "waiting") {
    await roomRef.child("state").set("running");
    await roomRef.child("startedAt").set(admin.database.ServerValue.TIMESTAMP);
    await roomRef.child("calledNumbers").set({});
  }

  const balanceSnapshot = await playWalletRef.once("value");
  return {
    roomId,
    playerCount,
    yourCards: parsedNumbers.map((n) => ({ number: n, card: getCard(n) })),
    playWallet: toFiniteNumber(balanceSnapshot.val()) || 0,
  };
});

// ============ NUMBER CALLER ============
exports.advanceGames = onSchedule({ schedule: "every 1 minutes" }, async () => {
  const roomsSnap = await db.ref("rooms").orderByChild("state").equalTo("running").once("value");
  const rooms = roomsSnap.val() || {};

  for (const [roomId, room] of Object.entries(rooms)) {
    const roomRef = db.ref(`rooms/${roomId}`);
    const calledBefore = Object.keys(room.calledNumbers || {}).map(Number);
    const remaining = [];
    for (let n = 1; n <= 75; n++) if (!calledBefore.includes(n)) remaining.push(n);

    if (remaining.length === 0) {
      await roomRef.child("state").set("finished");
      continue;
    }

    const next = remaining[Math.floor(Math.random() * remaining.length)];
    await roomRef.child(`calledNumbers/${next}`).set(true);
    await roomRef.child("lastCalled").set(next);

    const calledSet = new Set([...calledBefore, next]);
    const players = room.players || {};
    const winners = [];
    for (const [uid, player] of Object.entries(players)) {
      const cards = player.cartelaNumbers || [];
      const won = cards.some((num) => hasBingo(num, calledSet));
      if (won) winners.push(uid);
    }

    if (winners.length > 0) {
      const totalCartelas = room.cartelaCount || Object.values(players).reduce((sum, p) => sum + (p.cartelaNumbers || []).length, 0);
      const gross = room.stake * totalCartelas;
      const totalPrize = Math.floor(gross * (1 - HOUSE_CUT));
      const share = Math.floor(totalPrize / winners.length);

      await roomRef.child("state").set("finished");
      await roomRef.child("winners").set(winners);
      await roomRef.child("prizePerWinner").set(share);

      for (const winnerUid of winners) {
        await db.ref(`users/${winnerUid}/mainWallet`).transaction((current) => (toFiniteNumber(current) || 0) + share);
        const telegramId = winnerUid.replace("tg_", "");
        await sendMessage(telegramId, `🎉 BINGO! You won ${share} ETB! It has been added to your Main Wallet.`);
      }
    }
  }
});

// ============ TELEGRAM WEBHOOK MANAGER ============
exports.telegramWebhook = onRequest(async (req, res) => {
  const update = req.body;
  if (update.message && update.message.text) {
    const message = update.message;
    if (String(message.from.id) === String(ADMIN_TELEGRAM_ID)) {
      const match = message.text.match(/^\/setphone\s+(\d{9,15})$/);
      if (match) {
        await db.ref("settings/telebirrNumber").set(match[1]);
        await sendMessage(ADMIN_TELEGRAM_ID, `✅ Deposit Telebirr number updated to ${match[1]}`);
      }
    }
    res.status(200).send("ok");
    return;
  }

  const callback = update.callback_query;
  if (!callback) { res.status(200).send("ok"); return; }

  if (String(callback.from.id) !== String(ADMIN_TELEGRAM_ID)) {
