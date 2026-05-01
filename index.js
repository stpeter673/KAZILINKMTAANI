/**
 * KaziLink Mtaani — Firebase Cloud Functions
 * Complete backend: M-Pesa STK Push, Auto-Withdrawal, Gifts, Fraud Detection
 *
 * APP:       KAZILINKPROMTAANI (Sandbox)
 * TILL NAME: KAZILINK MTAANI
 * STORE NO:  8933038
 * TILL NO:   5725479
 *
 * TO GO LIVE — run these commands then redeploy:
 *   firebase functions:config:set mpesa.env="production"
 *   firebase functions:config:set mpesa.passkey="YOUR_LIVE_PASSKEY"
 *   firebase functions:config:set mpesa.initiator_password="YOUR_LIVE_INITIATOR_PASSWORD"
 */

const functions = require("firebase-functions");
const admin     = require("firebase-admin");
const axios     = require("axios");

admin.initializeApp();
const db = admin.firestore();

// ── CONFIG ───────────────────────────────────────────────────
const cfg = functions.config();

// KAZILINKPROMTAANI — Sandbox credentials (active)
const MPESA_KEY       = cfg.mpesa?.key       || "7fO8qShz29lZq1kAqBooZb2VZ6S0riJhsGYI8qgAl9s2XsMt";
const MPESA_SECRET    = cfg.mpesa?.secret    || "OLFJ4teT4suiw4ZiTsq2spnwaFbNN6aVDZhqJZJRcATpBsKMPxUMIRXdduFeO1Ti";
const MPESA_SHORTCODE = cfg.mpesa?.shortcode || "5725479";   // Till number
const MPESA_STORE     = cfg.mpesa?.store     || "8933038";   // Store number
// Sandbox uses Safaricom's standard test passkey
const MPESA_PASSKEY   = cfg.mpesa?.passkey   || "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
const IS_SANDBOX      = (cfg.mpesa?.env || "sandbox") === "sandbox";

const MPESA_BASE = IS_SANDBOX
  ? "https://sandbox.safaricom.co.ke"
  : "https://api.safaricom.co.ke";

// ── CALLBACK URLS (set your Firebase project ID here) ────────
// Run: firebase functions:config:set firebase.project="your-project-id"
const FIREBASE_PROJECT = cfg.firebase?.project || "YOUR_FIREBASE_PROJECT_ID";
const FUNCTIONS_BASE   = `https://us-central1-${FIREBASE_PROJECT}.cloudfunctions.net`;

// Each endpoint has its own URL — never concatenate strings onto a base URL
const STK_CALLBACK_URL = `${FUNCTIONS_BASE}/mpesaCallback`;
const B2C_RESULT_URL   = `${FUNCTIONS_BASE}/mpesaCallbackB2C`;
const B2C_TIMEOUT_URL  = `${FUNCTIONS_BASE}/mpesaCallbackB2CTimeout`;
const C2B_CONFIRM_URL  = `${FUNCTIONS_BASE}/mpesaC2BConfirm`;
const C2B_VALIDATE_URL = `${FUNCTIONS_BASE}/mpesaC2BValidate`;

// ── SANDBOX vs PRODUCTION SHORTCODE ──────────────────────────
// Safaricom sandbox STK Push ONLY works with their test shortcode 174379
// Your real till 5725479 is used in production only
const STK_SHORTCODE = IS_SANDBOX ? "174379" : MPESA_SHORTCODE;
const STK_PASSKEY   = IS_SANDBOX
  ? "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919"
  : MPESA_PASSKEY;

const TILL_NAME       = "KAZILINK MTAANI";
const MAX_AUTO_PAYOUT = 5000;   // Max KES for auto-processing
const MAX_FRAUD_SCORE = 79;     // Fraud score above this = manual review

// ── TIERED GIFT COMMISSIONS ───────────────────────────────────
// giftType must be sent from the frontend: "sticker" | "virtual" | "livestream"
// Platform takes a cut; creator keeps the rest.
const GIFT_COMMISSION = {
  sticker:    { platform: 0.15, creator: 0.85 }, // Small gifts / stickers
  virtual:    { platform: 0.20, creator: 0.80 }, // Premium virtual gifts
  livestream: { platform: 0.25, creator: 0.75 }, // VIP / live-stream gifts
};
// Fallback if giftType is missing or unrecognised
const DEFAULT_COMMISSION = GIFT_COMMISSION.virtual;

function getCommission(giftType) {
  return GIFT_COMMISSION[giftType] || DEFAULT_COMMISSION;
}

// ── RATE LIMIT HELPER (Firestore-backed, multi-instance safe) ──
async function checkRateLimit(uid, action, limitMs) {
  const ref = db.collection("rateLimits").doc(`${uid}_${action}`);
  return db.runTransaction(async (t) => {
    const doc = await t.get(ref);
    const last = doc.exists ? (doc.data().last || 0) : 0;
    if (Date.now() - last < limitMs) return false;
    t.set(ref, { last: Date.now() }, { merge: true });
    return true;
  });
}

// ── M-PESA TOKEN ─────────────────────────────────────────────
async function getMpesaToken() {
  const auth = Buffer.from(`${MPESA_KEY}:${MPESA_SECRET}`).toString("base64");
  const res = await axios.get(
    `${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return res.data.access_token;
}

// ── STK PUSH PASSWORD ────────────────────────────────────────
function getStkPassword() {
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  const password = Buffer.from(
    `${STK_SHORTCODE}${STK_PASSKEY}${timestamp}`
  ).toString("base64");
  return { password, timestamp };
}

// ── STK PUSH (Callable) ──────────────────────────────────────
exports.stkPush = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const uid   = context.auth.uid;
  const phone = String(data.phone || "").replace(/^0/, "254").replace(/\+/, "");
  const amount = parseInt(data.amount);
  const type   = data.type; // "subscription" | "coins"

  // Rate limit: max 1 STK push per 10 seconds
  if (!(await checkRateLimit(uid, "stk", 10000))) {
    throw new functions.https.HttpsError("resource-exhausted", "Please wait before retrying");
  }

  // Validate inputs
  if (!phone.match(/^254[0-9]{9}$/)) throw new functions.https.HttpsError("invalid-argument", "Invalid phone number. Use format 0712345678");
  if (!amount || amount < 10 || amount > 100000) throw new functions.https.HttpsError("invalid-argument", "Amount must be between KES 10 and 100,000");
  if (!["subscription", "coins"].includes(type)) throw new functions.https.HttpsError("invalid-argument", "Invalid payment type");

  // Fraud check — block frozen accounts
  const userDoc = await db.collection("users").doc(uid).get();
  if (userDoc.exists && userDoc.data().frozen) {
    throw new functions.https.HttpsError("permission-denied", "Account is suspended. Contact support.");
  }

  try {
    const token = await getMpesaToken();
    const { password, timestamp } = getStkPassword();

    const stkRes = await axios.post(
      `${MPESA_BASE}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: STK_SHORTCODE,
        Password:          password,
        Timestamp:         timestamp,
        TransactionType:   "CustomerBuyGoodsOnline",
        Amount:            amount,
        PartyA:            phone,
        PartyB:            STK_SHORTCODE,
        PhoneNumber:       phone,
        CallBackURL:       STK_CALLBACK_URL,
        AccountReference:  "KAZILINKPROMTAANI",
        TransactionDesc:   `KaziLink ${type}`
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const checkoutId = stkRes.data.CheckoutRequestID;
    const merchantId = stkRes.data.MerchantRequestID;

    if (!checkoutId) {
      throw new Error("M-Pesa did not return a CheckoutRequestID");
    }

    // Save pending payment — used by callback + status query
    await db.collection("pendingPayments").doc(checkoutId).set({
      uid, phone, amount, type,
      checkoutId, merchantId,
      status: "pending",
      processed: false,           // idempotency guard
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      checkoutId,
      message: "Check your phone for the M-Pesa payment prompt"
    };

  } catch (err) {
    const mpesaError = err.response?.data;
    console.error("STK Push error:", mpesaError || err.message);

    // Return readable error to frontend
    const msg = mpesaError?.errorMessage || mpesaError?.ResponseDescription || "M-Pesa push failed. Please try again.";
    throw new functions.https.HttpsError("internal", msg);
  }
});

// ── M-PESA STK CALLBACK (HTTP) ───────────────────────────────
// Safaricom calls this URL after the customer approves/cancels payment
exports.mpesaCallback = functions.https.onRequest(async (req, res) => {
  // Always respond 200 immediately — M-Pesa will retry if we don't
  res.status(200).send("OK");

  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) return;

    const checkoutId = callback.CheckoutRequestID;
    const resultCode = callback.ResultCode;   // 0 = success, anything else = failed
    const resultDesc = callback.ResultDesc || "";
    const meta       = callback.CallbackMetadata?.Item || [];

    // Reference the pending payment doc (keyed by checkoutId)
    const pendRef = db.collection("pendingPayments").doc(checkoutId);

    // ── IDEMPOTENCY GUARD ─────────────────────────────────────
    // Wrap everything in a transaction so double callbacks can't
    // credit the user twice
    await db.runTransaction(async (t) => {
      const pendDoc = await t.get(pendRef);

      if (!pendDoc.exists) {
        console.warn(`Callback for unknown checkoutId: ${checkoutId}`);
        return;
      }

      const pend = pendDoc.data();

      // Already processed — bail out (idempotency)
      if (pend.processed === true) {
        console.log(`Duplicate callback ignored for ${checkoutId}`);
        return;
      }

      if (resultCode === 0) {
        // ── PAYMENT SUCCESSFUL ──────────────────────────────
        const amount    = meta.find(i => i.Name === "Amount")?.Value || 0;
        const phone     = String(meta.find(i => i.Name === "PhoneNumber")?.Value || "");
        const mpesaRef  = meta.find(i => i.Name === "MpesaReceiptNumber")?.Value || "";
        const txDate    = meta.find(i => i.Name === "TransactionDate")?.Value || "";

        // Mark as processed (idempotency) + confirmed
        t.update(pendRef, {
          status: "confirmed",
          processed: true,
          mpesaRef, phone, amount, txDate,
          confirmedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Write to transactions collection (receipt)
        const userSnap = await db.collection("users").doc(pend.uid).get();
        const txRef = db.collection("transactions").doc(mpesaRef || checkoutId);
        t.set(txRef, {
          uid:       pend.uid,
          userEmail: userSnap.data()?.email || "",
          phone, amount, type: pend.type,
          mpesaRef, checkoutId,
          status: "confirmed",
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Update user record based on payment type
        const userRef = db.collection("users").doc(pend.uid);
        if (pend.type === "subscription") {
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + 30); // 30-day subscription
          t.set(userRef, {
            subscribed:    true,
            subscribedAt:  admin.firestore.FieldValue.serverTimestamp(),
            subscriptionExpires: admin.firestore.Timestamp.fromDate(expiresAt)
          }, { merge: true });
        } else if (pend.type === "coins") {
          // 1 KES = 1 coin
          t.set(userRef, {
            coins: admin.firestore.FieldValue.increment(amount)
          }, { merge: true });
        }

        // Update admin revenue dashboard
        t.set(db.collection("admin").doc("main"), {
          totalRevenue:   admin.firestore.FieldValue.increment(amount),
          paymentRevenue: admin.firestore.FieldValue.increment(amount)
        }, { merge: true });

        console.log(`✅ Payment confirmed: ${mpesaRef} | KES ${amount} | uid: ${pend.uid}`);

      } else {
        // ── PAYMENT FAILED / CANCELLED ──────────────────────
        // ResultCode meanings:
        // 1001 = wrong PIN  |  1032 = cancelled by user
        // 1037 = timeout    |  2001 = wrong credentials
        t.update(pendRef, {
          status:     "failed",
          processed:  true,
          resultCode, resultDesc,
          failedAt:   admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`❌ Payment failed: ${checkoutId} | Code: ${resultCode} | ${resultDesc}`);
      }
    });

  } catch (err) {
    // Don't re-throw — M-Pesa already got 200, retrying won't help
    console.error("Callback processing error:", err);
  }
});

// ── STK STATUS QUERY (Callable) ──────────────────────────────
// Frontend polls this if callback hasn't arrived after ~15 seconds
exports.stkQuery = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const { checkoutId } = data;
  if (!checkoutId) throw new functions.https.HttpsError("invalid-argument", "checkoutId required");

  // First check Firestore (callback may have already arrived)
  const pendDoc = await db.collection("pendingPayments").doc(checkoutId).get();
  if (pendDoc.exists && pendDoc.data().status !== "pending") {
    return { status: pendDoc.data().status, source: "firestore" };
  }

  // Ask Safaricom directly
  try {
    const token = await getMpesaToken();
    const { password, timestamp } = getStkPassword();

    const queryRes = await axios.post(
      `${MPESA_BASE}/mpesa/stkpushquery/v1/query`,
      {
        BusinessShortCode: STK_SHORTCODE,
        Password:          password,
        Timestamp:         timestamp,
        CheckoutRequestID: checkoutId
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const code = queryRes.data.ResultCode;
    const desc = queryRes.data.ResultDesc || "";

    // Sync result to Firestore if terminal
    if (code !== undefined && pendDoc.exists) {
      const finalStatus = code === 0 ? "confirmed" : "failed";
      await db.collection("pendingPayments").doc(checkoutId).update({
        status: finalStatus, resultCode: code, resultDesc: desc,
        processed: true,
        queriedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { status: finalStatus, resultCode: code, resultDesc: desc, source: "safaricom" };
    }

    return { status: "pending", source: "safaricom" };

  } catch (err) {
    console.error("STK query error:", err.response?.data || err.message);
    return { status: "unknown", error: "Could not reach Safaricom" };
  }
});

// ── C2B VALIDATION URL (HTTP) ─────────────────────────────────
// M-Pesa calls this BEFORE accepting a C2B payment
// Return 0 to accept, non-zero to reject
exports.mpesaC2BValidate = functions.https.onRequest(async (req, res) => {
  console.log("C2B Validate:", JSON.stringify(req.body));
  // Accept all payments — add custom logic here if needed
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

// ── C2B CONFIRMATION URL (HTTP) ───────────────────────────────
// M-Pesa calls this AFTER a C2B payment completes
exports.mpesaC2BConfirm = functions.https.onRequest(async (req, res) => {
  res.status(200).send("OK"); // Respond immediately

  try {
    const body = req.body;
    console.log("C2B Confirm:", JSON.stringify(body));

    const mpesaRef = body.TransID;
    const amount   = parseFloat(body.TransAmount) || 0;
    const phone    = String(body.MSISDN || "");
    const account  = String(body.BillRefNumber || "").trim().toLowerCase();

    // Save to c2bPayments — admin can reconcile manually
    await db.collection("c2bPayments").doc(mpesaRef).set({
      mpesaRef, amount, phone, account,
      raw: body,
      status: "received",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Update admin revenue
    await db.collection("admin").doc("main").set({
      c2bRevenue:   admin.firestore.FieldValue.increment(amount),
      totalRevenue: admin.firestore.FieldValue.increment(amount)
    }, { merge: true });

  } catch (err) {
    console.error("C2B Confirm error:", err);
  }
});

// ── REGISTER C2B URLS (Callable — run once after deploy) ─────
// Call this ONCE from your admin panel after first deploy
exports.registerC2BUrls = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");
  const ADMIN_EMAILS = (cfg.admin?.emails || "admin@kazilink.com,pitahwambuajr@gmail.com").split(",");
  if (!ADMIN_EMAILS.includes(context.auth.token.email)) {
    throw new functions.https.HttpsError("permission-denied", "Admin only");
  }

  try {
    const token = await getMpesaToken();
    const regRes = await axios.post(
      `${MPESA_BASE}/mpesa/c2b/v1/registerurl`,
      {
        ShortCode:       MPESA_SHORTCODE,
        ResponseType:    "Completed",
        ConfirmationURL: C2B_CONFIRM_URL,
        ValidationURL:   C2B_VALIDATE_URL
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log("C2B registration:", regRes.data);
    return { success: true, data: regRes.data };
  } catch (err) {
    console.error("C2B reg error:", err.response?.data || err.message);
    throw new functions.https.HttpsError("internal", "C2B URL registration failed");
  }
});

// ── SEND GIFT (Callable) ─────────────────────────────────────
exports.sendGift = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const senderUid     = context.auth.uid;
  const { emoji, name, cost, creatorHandle, giftType } = data;

  if (!cost || cost < 1) throw new functions.https.HttpsError("invalid-argument", "Invalid gift cost");
  if (!["sticker","virtual","livestream"].includes(giftType)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid giftType. Must be sticker, virtual, or livestream");
  }

  // Rate limit: max 1 gift per second
  if (!(await checkRateLimit(senderUid, "gift", 1000))) {
    throw new functions.https.HttpsError("resource-exhausted", "Sending too fast");
  }

  const senderRef = db.collection("users").doc(senderUid);

  // Find creator by handle
  const creatorSnap = await db.collection("users")
    .where("handle", "==", creatorHandle)
    .limit(1).get();

  return db.runTransaction(async (t) => {
    const senderDoc = await t.get(senderRef);
    if (!senderDoc.exists) throw new Error("User not found");

    const senderData = senderDoc.data();

    // Fraud: self-gifting detection
    if (senderData.handle === creatorHandle) {
      // Log fraud attempt
      await db.collection("fraudAlerts").add({
        userId: senderUid, reason: "Self-gifting attempt",
        resolved: false, createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      t.update(senderRef, { selfGiftAttempts: admin.firestore.FieldValue.increment(1) });
      throw new Error("Self-gifting is not allowed");
    }

    // Fraud: velocity check
    const giftsLastHour = (senderData.giftsInLastHour || 0);
    if (giftsLastHour >= 50) {
      await db.collection("fraudAlerts").add({
        userId: senderUid, reason: "Velocity: >50 gifts/hr",
        resolved: false, createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      throw new Error("Unusual activity detected. Account flagged for review.");
    }

    const coins = senderData.coins || 0;
    if (coins < cost) throw new Error("Insufficient coins");

    const commission        = getCommission(giftType);
    const creatorEarnings   = Math.floor(cost * commission.creator);
    const platformEarnings  = cost - creatorEarnings;

    // Deduct coins from sender
    t.update(senderRef, {
      coins: admin.firestore.FieldValue.increment(-cost),
      giftsInLastHour: admin.firestore.FieldValue.increment(1)
    });

    // Credit creator
    if (!creatorSnap.empty) {
      const creatorRef = creatorSnap.docs[0].ref;
      t.update(creatorRef, {
        balance:         admin.firestore.FieldValue.increment(creatorEarnings),
        coinsEarned:     admin.firestore.FieldValue.increment(creatorEarnings),
        giftsReceived:   admin.firestore.FieldValue.increment(1)
      });
    }

    // Record gift
    const giftRef = db.collection("gifts").doc();
    t.set(giftRef, {
      senderUid, creatorHandle, emoji, name, cost,
      giftType,
      commissionRate: commission.platform,
      creatorEarnings, platformEarnings,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Update admin balance
    const adminRef = db.collection("admin").doc("main");
    t.set(adminRef, {
      giftRevenue: admin.firestore.FieldValue.increment(platformEarnings),
      totalRevenue: admin.firestore.FieldValue.increment(platformEarnings)
    }, { merge: true });

    return { success: true, emoji, name, cost };
  });
});

// ── BUY COINS (Callable) ─────────────────────────────────────
exports.buyCoins = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");
  const uid   = context.auth.uid;
  const coins = parseInt(data.coins);
  const kes   = parseInt(data.kes);
  if (!coins || coins < 1) throw new functions.https.HttpsError("invalid-argument", "Invalid coins");
  await db.collection("users").doc(uid).update({
    coins: admin.firestore.FieldValue.increment(coins)
  });
  await db.collection("transactions").add({
    uid, type: "coins", amount: kes, coinsAdded: coins,
    status: "confirmed", createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  await db.collection("admin").doc("main").set({
    totalRevenue:   admin.firestore.FieldValue.increment(kes),
    totalCoinsSold: admin.firestore.FieldValue.increment(coins)
  }, { merge: true });
  return { success: true };
});

// ── REQUEST WITHDRAWAL (Callable) ────────────────────────────
exports.requestWithdrawal = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const uid   = context.auth.uid;
  const phone = String(data.phone || "").replace(/^0/, "254");
  const amount = parseInt(data.amount);

  if (!phone.match(/^254[0-9]{9}$/)) throw new functions.https.HttpsError("invalid-argument", "Invalid phone");
  if (!amount || amount < 50) throw new functions.https.HttpsError("invalid-argument", "Min withdrawal KES 50");
  if (!(await checkRateLimit(uid, "withdraw", 60000))) throw new functions.https.HttpsError("resource-exhausted", "Wait 1 min between requests");

  // Fraud check
  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.data() || {};
  if (userData.frozen) throw new functions.https.HttpsError("permission-denied", "Account suspended");

  const fraudScore = calcFraudScore(userData);
  // balance is already the creator's post-commission earnings (set directly in sendGift)
  const withdrawable = Math.floor(userData.balance || 0);

  if (amount > withdrawable) throw new functions.https.HttpsError("invalid-argument", "Insufficient earned balance");

  const withdrawRef = await db.collection("withdrawals").add({
    userId: uid,
    userName: userData.name || "",
    userEmail: userData.email || "",
    phone, amount, fraudScore,
    status: fraudScore > MAX_FRAUD_SCORE ? "held_fraud_review" : "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // Auto-process if low fraud score and under limit
  if (fraudScore <= MAX_FRAUD_SCORE && amount <= MAX_AUTO_PAYOUT) {
    await processB2C(phone, amount, withdrawRef.id, uid);
  }

  return { success: true, held: fraudScore > MAX_FRAUD_SCORE };
});

// ── PROCESS WITHDRAWAL — B2C (Internal) ──────────────────────
async function processB2C(phone, amount, withdrawalId, uid) {
  try {
    const token = await getMpesaToken();
    const { timestamp } = getStkPassword();

    const b2cRes = await axios.post(
      `${MPESA_BASE}/mpesa/b2c/v1/paymentrequest`,
      {
        InitiatorName:      cfg.mpesa?.initiator          || "testapi",
        SecurityCredential: cfg.mpesa?.security_credential || "YOUR_ENCRYPTED_INITIATOR_PASSWORD",
        CommandID:          "BusinessPayment",
        Amount:             amount,
        PartyA:             MPESA_SHORTCODE,
        PartyB:             phone,
        Remarks:            "KaziLink Earnings",
        QueueTimeOutURL:    B2C_TIMEOUT_URL,
        ResultURL:          B2C_RESULT_URL,
        Occassion:          "Creator withdrawal"
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    await db.collection("withdrawals").doc(withdrawalId).update({
      status: "processing",
      mpesaConvId: b2cRes.data?.ConversationID || null,
      mpesaOriginatorId: b2cRes.data?.OriginatorConversationID || null,
      processedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Deduct from user balance
    await db.collection("users").doc(uid).update({
      balance:     admin.firestore.FieldValue.increment(-amount),
      coinsEarned: admin.firestore.FieldValue.increment(-amount)
    });

  } catch (err) {
    console.error("B2C error:", err.response?.data || err.message);
    await db.collection("withdrawals").doc(withdrawalId).update({ status: "failed" });
  }
}

// ── ADMIN: PROCESS WITHDRAWAL (Callable) ─────────────────────
exports.processWithdrawal = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");
  const ADMIN_EMAILS = (cfg.admin?.emails || "admin@kazilink.com,pitahwambuajr@gmail.com").split(",");
  if (!ADMIN_EMAILS.includes(context.auth.token.email)) {
    throw new functions.https.HttpsError("permission-denied", "Admin only");
  }

  const { withdrawalId, phone, amount } = data;
  if (!withdrawalId || !phone || !amount) {
    throw new functions.https.HttpsError("invalid-argument", "Missing fields");
  }
  await processB2C(phone, amount, withdrawalId, data.userId || "admin");

  return { success: true };
});

// Same admin guard on autoProcessWithdrawals
const _origAuto = exports.autoProcessWithdrawals;

// ── ADMIN: AUTO-PROCESS ALL PENDING (Callable) ───────────────
exports.autoProcessWithdrawals = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");
  const ADMIN_EMAILS = (cfg.admin?.emails || "admin@kazilink.com,pitahwambuajr@gmail.com").split(",");
  if (!ADMIN_EMAILS.includes(context.auth.token.email)) {
    throw new functions.https.HttpsError("permission-denied", "Admin only");
  }

  const snap = await db.collection("withdrawals")
    .where("status", "==", "pending")
    .where("fraudScore", "<=", MAX_FRAUD_SCORE)
    .get();

  let processed = 0;
  const promises = [];

  snap.forEach(doc => {
    const d = doc.data();
    if (d.amount <= MAX_AUTO_PAYOUT) {
      promises.push(
        processB2C(d.phone, d.amount, doc.id, d.userId)
          .then(() => processed++)
          .catch(e => console.error(`B2C failed for ${doc.id}:`, e))
      );
    }
  });

  await Promise.all(promises);
  return { success: true, processed };
});

// ── FRAUD SCORE HELPER ───────────────────────────────────────
function calcFraudScore(userData) {
  let score = 0;
  if ((userData.giftsInLastHour   || 0) > 20) score += 40;
  if ((userData.withdrawalAttempts24h || 0) > 3) score += 25;
  if ((userData.selfGiftAttempts  || 0) > 0)  score += 30;
  if ((userData.coins || 0) > 10000 && (userData.coinsEarned || 0) === 0) score += 20;
  return Math.min(score, 100);
}

// ── SCHEDULED: RESET HOURLY COUNTERS ─────────────────────────
exports.resetHourlyCounters = functions.pubsub
  .schedule("every 60 minutes")
  .onRun(async () => {
    const snap = await db.collection("users").where("giftsInLastHour", ">", 0).get();
    const batch = db.batch();
    snap.forEach(doc => batch.update(doc.ref, { giftsInLastHour: 0 }));
    await batch.commit();
    console.log(`Reset hourly counters for ${snap.size} users`);
  });

// ── SCHEDULED: DAILY FRAUD AUDIT ─────────────────────────────
exports.dailyFraudAudit = functions.pubsub
  .schedule("every 24 hours")
  .onRun(async () => {
    const users = await db.collection("users").get();
    const batch = db.batch();
    let flagged = 0;

    users.forEach(doc => {
      const d = doc.data();
      const score = calcFraudScore(d);
      if (score >= 80 && !d.frozen) {
        batch.update(doc.ref, { frozen: true, frozenAt: admin.firestore.FieldValue.serverTimestamp() });
        const alertRef = db.collection("fraudAlerts").doc();
        batch.set(alertRef, {
          userId: doc.id, reason: `Daily audit: score ${score}`,
          resolved: false, createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        flagged++;
      }
    });

    await batch.commit();
    console.log(`Daily fraud audit: ${flagged} accounts flagged`);
  });

// ── B2C RESULT CALLBACK ───────────────────────────────────────
exports.mpesaCallbackB2C = functions.https.onRequest(async (req, res) => {
  const result = req.body?.Result;
  if (!result) return res.send("OK");

  const convId = result.ConversationID;
  const code   = result.ResultCode;

  const snap = await db.collection("withdrawals")
    .where("mpesaConvId", "==", convId).get();

  if (!snap.empty) {
    await snap.docs[0].ref.update({
      status: code === 0 ? "paid" : "failed",
      resultDesc: result.ResultDesc || ""
    });
  }

  res.send("OK");
});

module.exports.calcFraudScore = calcFraudScore;

// ── B2C TIMEOUT CALLBACK ──────────────────────────────────────
exports.mpesaCallbackB2CTimeout = functions.https.onRequest(async (req, res) => {
  const result = req.body?.Result || req.body;
  const convId = result?.ConversationID || result?.OriginatorConversationID;
  if (convId) {
    const snap = await db.collection("withdrawals")
      .where("mpesaConvId", "==", convId).get();
    if (!snap.empty) {
      const wd = snap.docs[0];
      const d = wd.data();
      // Refund the user's balance since the payment timed out
      await db.runTransaction(async (t) => {
        t.update(wd.ref, { status: "timeout", resultDesc: "Queue timeout" });
        if (d.userId && d.amount) {
          t.update(db.collection("users").doc(d.userId), {
            balance:     admin.firestore.FieldValue.increment(d.amount),
            coinsEarned: admin.firestore.FieldValue.increment(d.amount)
          });
        }
      });
    }
  }
  res.send("OK");
});

// ── SCHEDULED: RECONCILE STALE PENDING PAYMENTS ──────────────
exports.reconcileStalePayments = functions.pubsub
  .schedule("every 15 minutes")
  .onRun(async () => {
    const cutoff = Date.now() - 10 * 60 * 1000; // 10 minutes old
    const snap = await db.collection("pendingPayments")
      .where("status", "==", "pending")
      .get();
    const batch = db.batch();
    let n = 0;
    snap.forEach(doc => {
      const created = doc.data().createdAt?.toMillis?.() || 0;
      if (created && created < cutoff) {
        batch.update(doc.ref, { status: "expired" });
        n++;
      }
    });
    if (n > 0) await batch.commit();
    console.log(`Expired ${n} stale STK payments`);
  });

// ── SCHEDULED: RESET DAILY WITHDRAWAL ATTEMPT COUNTERS ───────
exports.resetDailyCounters = functions.pubsub
  .schedule("every 24 hours")
  .onRun(async () => {
    const snap = await db.collection("users")
      .where("withdrawalAttempts24h", ">", 0).get();
    const batch = db.batch();
    snap.forEach(doc => batch.update(doc.ref, { withdrawalAttempts24h: 0 }));
    if (!snap.empty) await batch.commit();
    console.log(`Reset 24h withdrawal counters for ${snap.size} users`);
  });

// ── HEALTH CHECK ──────────────────────────────────────────────
exports.health = functions.https.onRequest((req, res) => {
  res.json({ ok: true, env: IS_SANDBOX ? "sandbox" : "production", time: Date.now() });
});
