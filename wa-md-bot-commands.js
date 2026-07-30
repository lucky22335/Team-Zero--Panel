// ╔══════════════════════════════════════════════════════════════════╗
// ║   TEAM ZERO PANEL — WhatsApp MD Bot Plugin                      ║
// ║   Apne dusre WA MD bot mein ye commands add karo                ║
// ║   (XMD, Baileys-MD, Fatihah-MD, Pair-MD, sab ke sath kaam karta hai) ║
// ╚══════════════════════════════════════════════════════════════════╝
//
// SETUP: PANEL_URL mein apna Replit URL lagao
// Replit URL format: https://YOUR_REPL_NAME.YOUR_USERNAME.repl.co
//
// Ye file apne bot ki main plugin/index file mein paste karo
// ─────────────────────────────────────────────────────────────────

const PANEL_URL   = "https://YOUR-PANEL-URL/api"; // ← SIRF YE BADLO
const PANEL_SIG   = "IPRN-SMS-PANEL-SECURE-2026";

// Active number polls: numberClean → { jid, interval, smsIds }
const _tzActiveSessions = new Map();

// ── OTP Bot Config (in-memory, .otp set se save hota hai) ────────
// Ye config bot restart pe reset hogi — isliye permanent store ke liye
// apne bot ki config file mein save karo
let _otpConfig = {
  newsletter: "",      // .otp set se set hota hai
  offlink:    "",      // .otp offlink se set hota hai
  numlink:    "",      // .otp numlink se set hota hai
  dev:        "Team Zero™ 🇵🇰",  // .otp dev se set hota hai
  running:    false,   // .otp start/stop se control hota hai
  interval:   null,    // active OTP polling interval
  seenIds:    new Set() // already forwarded OTPs ka tracker
};

// ── Helper: Panel API call ────────────────────────────────────────
async function tzGet(endpoint) {
  const res = await fetch(`${PANEL_URL}${endpoint}`, {
    headers: { "x-app-request-signature": PANEL_SIG },
    signal: AbortSignal.timeout(10000)
  });
  return res.json();
}

// ── Country name/ISO/dialcode → standard name ─────────────────────
const _countryMap = {
  pk:"Pakistan",pakistan:"Pakistan",
  in:"India",india:"India",
  id:"Indonesia",indonesia:"Indonesia",
  bd:"Bangladesh",bangladesh:"Bangladesh",
  ng:"Nigeria",nigeria:"Nigeria",
  us:"United States","united states":"United States",
  gb:"United Kingdom","united kingdom":"United Kingdom",uk:"United Kingdom",
  ru:"Russia",russia:"Russia",
  ua:"Ukraine",ukraine:"Ukraine",
  kz:"Kazakhstan",kazakhstan:"Kazakhstan",
  vn:"Vietnam",vietnam:"Vietnam",
  ph:"Philippines",philippines:"Philippines",
  mx:"Mexico",mexico:"Mexico",
  br:"Brazil",brazil:"Brazil",
  ke:"Kenya",kenya:"Kenya",
  gh:"Ghana",ghana:"Ghana",
  et:"Ethiopia",ethiopia:"Ethiopia",
  tz:"Tanzania",tanzania:"Tanzania",
  za:"South Africa","south africa":"South Africa",
  np:"Nepal",nepal:"Nepal",
  lk:"Sri Lanka","sri lanka":"Sri Lanka",
  mm:"Myanmar",myanmar:"Myanmar",
  th:"Thailand",thailand:"Thailand",
  my:"Malaysia",malaysia:"Malaysia",
  kh:"Cambodia",cambodia:"Cambodia",
  mz:"Mozambique",mozambique:"Mozambique",
  zw:"Zimbabwe",zimbabwe:"Zimbabwe",
  ci:"Ivory Coast","ivory coast":"Ivory Coast",
  cm:"Cameroon",cameroon:"Cameroon",
  ao:"Angola",angola:"Angola",
  de:"Germany",germany:"Germany",
  fr:"France",france:"France",
  it:"Italy",italy:"Italy",
  es:"Spain",spain:"Spain",
  pl:"Poland",poland:"Poland",
  uz:"Uzbekistan",uzbekistan:"Uzbekistan",
  // Dial code overrides
  "92":"Pakistan","91":"India","62":"Indonesia","880":"Bangladesh",
  "234":"Nigeria","1":"United States","44":"United Kingdom",
  "7":"Russia","380":"Ukraine","84":"Vietnam","63":"Philippines",
  "52":"Mexico","55":"Brazil","254":"Kenya","233":"Ghana",
  "977":"Nepal","94":"Sri Lanka","95":"Myanmar","66":"Thailand",
  "60":"Malaysia","855":"Cambodia","258":"Mozambique","263":"Zimbabwe",
  "225":"Ivory Coast","237":"Cameroon","244":"Angola",
  "49":"Germany","33":"France","39":"Italy","34":"Spain",
  "48":"Poland","998":"Uzbekistan",
};

function tzResolveCountry(input) {
  if (!input) return null;
  const k = input.trim().toLowerCase().replace(/^\+/, "");
  return _countryMap[k] || (input.trim().charAt(0).toUpperCase() + input.trim().slice(1));
}

const _flags = {
  Pakistan:"🇵🇰",India:"🇮🇳",Indonesia:"🇮🇩",Bangladesh:"🇧🇩",Nigeria:"🇳🇬",
  "United States":"🇺🇸","United Kingdom":"🇬🇧",Russia:"🇷🇺",Ukraine:"🇺🇦",
  Kazakhstan:"🇰🇿",Vietnam:"🇻🇳",Philippines:"🇵🇭",Mexico:"🇲🇽",Brazil:"🇧🇷",
  Kenya:"🇰🇪",Ghana:"🇬🇭",Ethiopia:"🇪🇹",Tanzania:"🇹🇿","South Africa":"🇿🇦",
  Nepal:"🇳🇵","Sri Lanka":"🇱🇰",Myanmar:"🇲🇲",Thailand:"🇹🇭",Malaysia:"🇲🇾",
  Cambodia:"🇰🇭",Mozambique:"🇲🇿",Zimbabwe:"🇿🇼","Ivory Coast":"🇨🇮",
  Cameroon:"🇨🇲",Angola:"🇦🇴",Germany:"🇩🇪",France:"🇫🇷",Italy:"🇮🇹",
  Spain:"🇪🇸",Poland:"🇵🇱",Uzbekistan:"🇺🇿",
};
function tzFlag(country) { return _flags[country] || "🏳️"; }

// ── SMS poller: check panel every 4s for 3 minutes ────────────────
function tzStartSmsPoller(numberClean, jid, sendFn) {
  // Stop old poller for same number if exists
  if (_tzActiveSessions.has(numberClean)) {
    clearInterval(_tzActiveSessions.get(numberClean).interval);
  }

  const seenIds = new Set();
  let attempts = 0;
  const MAX_ATTEMPTS = 45; // 4s × 45 = 3 minutes

  const interval = setInterval(async () => {
    attempts++;
    if (attempts > MAX_ATTEMPTS) {
      clearInterval(interval);
      _tzActiveSessions.delete(numberClean);
      await sendFn(jid, `⏰ *Time Out!*\nNumber *${numberClean}* ka SMS 3 minute mein nahi aaya.\nDobara try karo: *.getnumber*`);
      return;
    }

    try {
      const data = await tzGet(`/sms/by-number?number=${numberClean}`);
      if (data?.success && data.sms?.length > 0) {
        for (const sms of data.sms) {
          const uid = sms.id || `${sms.number}:${sms.message}`;
          if (!seenIds.has(uid)) {
            seenIds.add(uid);
            const otp = extractTzOtp(sms.message || "");
            const msg =
              `✅ *OTP Received! — Team Zero*\n\n` +
              `📱 *Number:* \`${sms.number}\`\n` +
              `🌍 *Country:* ${tzFlag(sms.country)} ${sms.country || "-"}\n\n` +
              `🔑 *OTP:* \`${otp}\`\n\n` +
              `💬 *Full Message:*\n${sms.message}\n\n` +
              `_Powered by ${_otpConfig.dev}_`;
            await sendFn(jid, msg);
            // Keep polling — more OTPs might arrive
          }
        }
      }
    } catch (_) {}
  }, 4000);

  _tzActiveSessions.set(numberClean, { jid, interval, seenIds });
}

function extractTzOtp(msg) {
  const m = msg.match(/\b(\d{4,8})\b/);
  return m ? m[1] : "⏳ Pending...";
}

// ─────────────────────────────────────────────────────────────────
//  .getnumber COMMAND HANDLER
// ─────────────────────────────────────────────────────────────────
async function handleGetNumber(args, senderJid, sendFn) {
  // args = "" → list countries  |  args = "Pakistan" / "pk" / "92" → get number
  try {
    const data = await tzGet("/numbers");
    if (!data?.success || !data.numbers?.length) {
      return sendFn(senderJid, "⚠️ Panel se numbers fetch nahi ho sake. Baad mein try karo.");
    }

    if (!args || !args.trim()) {
      // ── No argument: show country list ──────────────────────────
      const counts = {};
      for (const n of data.numbers) {
        const c = n.country || "Unknown";
        counts[c] = (counts[c] || 0) + 1;
      }
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      let msg = `🌍 *TEAM ZERO — Virtual Numbers Panel*\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `📊 *Total Numbers:* ${data.numbers.length}\n`;
      msg += `🗺️ *Countries:* ${sorted.length}\n\n`;
      msg += `*Available Countries:*\n`;
      for (const [c, n] of sorted) {
        msg += `${tzFlag(c)} *${c}*: ${n} numbers\n`;
      }
      msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `*Number lene ke liye:*\n`;
      msg += `*.getnumber Pakistan*\n*.getnumber India*\n*.getnumber pk*\n*.getnumber 92*`;
      return sendFn(senderJid, msg);
    }

    // ── With argument: get a number from that country ─────────────
    const resolved = tzResolveCountry(args.trim());
    if (!resolved) {
      return sendFn(senderJid, `❌ Country *"${args.trim()}"* nahi mili.\n\nList dekhne ke liye: *.getnumber*`);
    }

    const available = data.numbers.filter(n => n.country === resolved && !n.claimed);
    if (!available.length) {
      return sendFn(senderJid, `😔 *${tzFlag(resolved)} ${resolved}* mein abhi koi number available nahi.\n\nDusra country try karo: *.getnumber*`);
    }

    // Pick random available number
    const picked = available[Math.floor(Math.random() * available.length)];
    const numberClean = picked.number.replace(/[\s\-\+]/g, "");

    let msg =
      `✅ *Number Mila — ${tzFlag(resolved)} ${resolved}*\n\n` +
      `📱 *Number:* \`${picked.number}\`\n` +
      `🌍 *Country:* ${tzFlag(resolved)} ${resolved}\n\n` +
      `⏳ *OTP ka wait kar raha hoon...*\n` +
      `_3 minute tak automatically milega_\n\n` +
      `_Powered by ${_otpConfig.dev}_`;
    await sendFn(senderJid, msg);

    // Start auto-SMS poller
    tzStartSmsPoller(numberClean, senderJid, sendFn);

  } catch (err) {
    sendFn(senderJid, `❌ Error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────
//  .otp COMMAND HANDLER (complete system)
// ─────────────────────────────────────────────────────────────────
//
//  .otp set <newsletter_jid>   → OTP newsletter JID set karo
//  .otp offlink <url>          → Official channel link set karo
//  .otp numlink <url>          → Number channel link set karo
//  .otp dev <brand_name>       → Powered By text set karo
//  .otp download <country>     → Us country ke numbers download karo (.txt file)
//  .otp start                  → Panel se OTPs newsletter mein aana shuru karo
//  .otp stop                   → OTP forwarding band karo
//  .otp status                 → Current config aur status dikho
//
async function handleOtpCommand(args, senderJid, sendFn, sock) {
  const parts = args.trim().split(/\s+/);
  const subCmd = (parts[0] || "").toLowerCase();
  const rest = parts.slice(1).join(" ").trim();

  // ── .otp set <newsletter_jid> ─────────────────────────────────
  if (subCmd === "set") {
    if (!rest) {
      return sendFn(senderJid,
        `❌ *Usage:* *.otp set <newsletter_jid>*\n\n` +
        `Example: *.otp set 120363426165980012@newsletter*\n\n` +
        `Newsletter JID WhatsApp Channel settings se milta hai.`
      );
    }
    _otpConfig.newsletter = rest;
    return sendFn(senderJid,
      `✅ *OTP Newsletter Set!*\n\n` +
      `📢 *Newsletter JID:* \`${rest}\`\n\n` +
      `Ab *.otp start* likhne ke baad sab OTPs is newsletter mein jayenge.\n` +
      `_Powered by ${_otpConfig.dev}_`
    );
  }

  // ── .otp offlink <url> ────────────────────────────────────────
  if (subCmd === "offlink") {
    if (!rest) {
      return sendFn(senderJid, `❌ *Usage:* *.otp offlink <official_channel_url>*\n\nExample: *.otp offlink https://whatsapp.com/channel/xxxx*`);
    }
    _otpConfig.offlink = rest;
    return sendFn(senderJid,
      `✅ *Official Channel Link Set!*\n\n` +
      `🔗 *Link:* ${rest}\n\n` +
      `Ye link OTP messages mein dikhega.\n` +
      `_Powered by ${_otpConfig.dev}_`
    );
  }

  // ── .otp numlink <url> ────────────────────────────────────────
  if (subCmd === "numlink") {
    if (!rest) {
      return sendFn(senderJid, `❌ *Usage:* *.otp numlink <number_channel_url>*\n\nExample: *.otp numlink https://whatsapp.com/channel/yyyy*`);
    }
    _otpConfig.numlink = rest;
    return sendFn(senderJid,
      `✅ *Number Channel Link Set!*\n\n` +
      `🔗 *Link:* ${rest}\n\n` +
      `Ye link numbers channel ke liye hai.\n` +
      `_Powered by ${_otpConfig.dev}_`
    );
  }

  // ── .otp dev <brand_name> ─────────────────────────────────────
  if (subCmd === "dev") {
    if (!rest) {
      return sendFn(senderJid, `❌ *Usage:* *.otp dev <brand_name>*\n\nExample: *.otp dev Team Zero™ 🇵🇰*`);
    }
    _otpConfig.dev = rest;
    return sendFn(senderJid,
      `✅ *Brand Name Set!*\n\n` +
      `🏷️ *Powered By:* ${rest}\n\n` +
      `Ab sab OTP messages mein "${rest}" dikhega.`
    );
  }

  // ── .otp download <country> ───────────────────────────────────
  if (subCmd === "download") {
    if (!rest) {
      return sendFn(senderJid,
        `❌ *Usage:* *.otp download <country>*\n\n` +
        `Example: *.otp download Pakistan*\n` +
        `         *.otp download pk*\n` +
        `         *.otp download 92*\n\n` +
        `Pehle *.getnumber* se available countries dekho.`
      );
    }
    const resolved = tzResolveCountry(rest);
    try {
      await sendFn(senderJid, `⏳ *${tzFlag(resolved)} ${resolved} numbers fetch kar raha hoon...*`);
      const data = await tzGet("/numbers");
      if (!data?.success || !data.numbers?.length) {
        return sendFn(senderJid, "⚠️ Panel se numbers fetch nahi ho sake.");
      }
      const countryNums = data.numbers.filter(n =>
        (n.country || "").toLowerCase() === resolved.toLowerCase()
      );
      if (!countryNums.length) {
        return sendFn(senderJid, `😔 *${tzFlag(resolved)} ${resolved}* ke numbers panel mein available nahi hain.\n\n*.getnumber* se list dekho.`);
      }

      // Format numbers as text
      const lines = countryNums.map(n => n.number).join("\n");
      const summary =
        `📥 *${tzFlag(resolved)} ${resolved} Numbers — Team Zero Panel*\n\n` +
        `📊 *Total:* ${countryNums.length} numbers\n\n` +
        `\`\`\`\n${lines}\n\`\`\`\n\n` +
        `_Powered by ${_otpConfig.dev}_`;

      // Send as text (MD bots can handle long messages)
      await sendFn(senderJid, summary);

      // Also try to send as document if sock is available
      if (sock && typeof sock.sendMessage === "function") {
        try {
          const fileName = `${resolved.replace(/\s+/g, "_")}_numbers.txt`;
          const fileContent = `# ${resolved} Numbers — Team Zero Panel\n# Total: ${countryNums.length}\n# Generated: ${new Date().toISOString()}\n\n${lines}\n`;
          await sock.sendMessage(senderJid, {
            document: Buffer.from(fileContent, "utf8"),
            mimetype: "text/plain",
            fileName
          });
        } catch (fileErr) {
          // File send fail hoi toh text already bhej di hai, theek hai
        }
      }
    } catch (err) {
      sendFn(senderJid, `❌ Error: ${err.message}`);
    }
    return;
  }

  // ── .otp start ────────────────────────────────────────────────
  if (subCmd === "start") {
    if (!_otpConfig.newsletter) {
      return sendFn(senderJid,
        `❌ *Pehle newsletter set karo!*\n\n` +
        `*.otp set <newsletter_jid>* likho\n\n` +
        `Example: *.otp set 120363426165980012@newsletter*`
      );
    }
    if (_otpConfig.running) {
      return sendFn(senderJid,
        `⚠️ *OTP forwarding pehle se chal rahi hai!*\n\n` +
        `Band karne ke liye: *.otp stop*\n` +
        `Status: *.otp status*`
      );
    }

    _otpConfig.running = true;
    _otpConfig.seenIds = new Set();

    // Start polling panel every 5 seconds and forward new OTPs to newsletter
    _otpConfig.interval = setInterval(async () => {
      if (!_otpConfig.running) return;
      try {
        const data = await tzGet("/sms");
        const smsList = data?.sms || data?.otps || [];
        if (!smsList.length) return;

        for (const sms of smsList) {
          const uid = sms.id || `${sms.number}:${(sms.message || "").slice(0, 40)}`;
          if (_otpConfig.seenIds.has(uid)) continue;
          _otpConfig.seenIds.add(uid);

          // Keep seen IDs from growing too large
          if (_otpConfig.seenIds.size > 500) {
            const arr = Array.from(_otpConfig.seenIds);
            _otpConfig.seenIds = new Set(arr.slice(200));
          }

          const otp = extractTzOtp(sms.message || "");
          const flag = tzFlag(sms.country || "");
          let msg =
            `🔑 *OTP — ${flag} ${sms.country || "Unknown"}*\n\n` +
            `📱 *Number:* \`${sms.number}\`\n` +
            `🔑 *OTP:* \`${otp}\`\n\n` +
            `💬 *Message:*\n${sms.message || ""}`;

          if (_otpConfig.offlink) msg += `\n\n📢 *Official Channel:* ${_otpConfig.offlink}`;
          if (_otpConfig.numlink) msg += `\n🔢 *Number Channel:* ${_otpConfig.numlink}`;
          msg += `\n\n_Powered by ${_otpConfig.dev}_`;

          // Send to newsletter
          if (sock && typeof sock.sendMessage === "function") {
            try {
              await sock.sendMessage(_otpConfig.newsletter, { text: msg });
            } catch (_) {}
          }
        }
      } catch (_) {}
    }, 5000);

    return sendFn(senderJid,
      `✅ *OTP Forwarding Started!*\n\n` +
      `📢 *Newsletter:* \`${_otpConfig.newsletter}\`\n` +
      `⏱️ Panel se har 5 second mein OTPs check hongi\n\n` +
      `Band karne ke liye: *.otp stop*\n` +
      `_Powered by ${_otpConfig.dev}_`
    );
  }

  // ── .otp stop ─────────────────────────────────────────────────
  if (subCmd === "stop") {
    if (!_otpConfig.running) {
      return sendFn(senderJid, `⚠️ *OTP forwarding pehle se band hai.*\n\nShuru karne ke liye: *.otp start*`);
    }
    _otpConfig.running = false;
    if (_otpConfig.interval) {
      clearInterval(_otpConfig.interval);
      _otpConfig.interval = null;
    }
    return sendFn(senderJid,
      `🛑 *OTP Forwarding Stopped!*\n\n` +
      `Newsletter mein OTPs aana band ho gayi hain.\n\n` +
      `Dobara shuru karne ke liye: *.otp start*\n` +
      `_Powered by ${_otpConfig.dev}_`
    );
  }

  // ── .otp status ───────────────────────────────────────────────
  if (subCmd === "status" || subCmd === "") {
    const statusEmoji = _otpConfig.running ? "🟢" : "🔴";
    return sendFn(senderJid,
      `📊 *OTP Bot Status — Team Zero*\n\n` +
      `${statusEmoji} *Forwarding:* ${_otpConfig.running ? "RUNNING" : "STOPPED"}\n` +
      `📢 *Newsletter:* ${_otpConfig.newsletter || "❌ Not set (use .otp set)"}\n` +
      `🔗 *Off Link:* ${_otpConfig.offlink || "Not set"}\n` +
      `🔢 *Num Link:* ${_otpConfig.numlink || "Not set"}\n` +
      `🏷️ *Powered By:* ${_otpConfig.dev}\n\n` +
      `*Commands:*\n` +
      `*.otp set <newsletter_jid>* — Newsletter set karo\n` +
      `*.otp offlink <url>* — Official channel link\n` +
      `*.otp numlink <url>* — Number channel link\n` +
      `*.otp dev <name>* — Brand name set karo\n` +
      `*.otp download <country>* — Numbers download karo\n` +
      `*.otp start* — OTP forwarding shuru karo\n` +
      `*.otp stop* — OTP forwarding band karo\n` +
      `_Powered by ${_otpConfig.dev}_`
    );
  }

  // ── Unknown subcommand ─────────────────────────────────────────
  return sendFn(senderJid,
    `❓ *Ye command nahi pehchani:* .otp ${subCmd}\n\n` +
    `*.otp status* likhein sab commands dekhne ke liye.`
  );
}

// ═══════════════════════════════════════════════════════════════════
//  HOW TO ADD TO YOUR BOT — COPY BELOW INTO YOUR BOT'S HANDLER
// ═══════════════════════════════════════════════════════════════════

/*
───────────────────────────────────────────────────────────
FORMAT 1: XMD / Fatihah-MD / BHAI-MD style (switch-case)
───────────────────────────────────────────────────────────

// Put this near the top of your main file:
const PANEL_URL = "https://YOUR-PANEL-URL/api";
const PANEL_SIG = "IPRN-SMS-PANEL-SECURE-2026";

// In your switch-case message handler:
const body = m.body?.toLowerCase() || "";
const args = m.body?.slice(body.split(" ")[0].length).trim() || "";

case ".getnumber":
  await handleGetNumber(args, m.from, async (jid, text) => {
    await client.sendMessage(jid, { text });
  });
  break;

case ".otp":
  await handleOtpCommand(args, m.from, async (jid, text) => {
    await client.sendMessage(jid, { text });
  }, client);
  break;

───────────────────────────────────────────────────────────
FORMAT 2: Plugin-style (addCmd / module.exports)
───────────────────────────────────────────────────────────

module.exports = {
  name: "otp",
  alias: ["otpbot"],
  category: "tools",
  desc: "Team Zero panel ka OTP forwarding bot — newsletter mein OTPs bhejo",
  usage: ".otp [set|offlink|numlink|dev|download|start|stop|status]",
  handler: async ({ m, client, text }) => {
    await handleOtpCommand(text, m.from || m.chat, async (jid, msg) => {
      await client.sendMessage(jid, { text: msg });
    }, client);
  }
};

───────────────────────────────────────────────────────────
FORMAT 3: if-else style (inline check)
───────────────────────────────────────────────────────────

if (body.startsWith(".otp")) {
  const args = body.slice(4).trim();
  await handleOtpCommand(args, from, async (jid, text) => {
    await sock.sendMessage(jid, { text });
  }, sock);
}

if (body.startsWith(".getnumber")) {
  const args = body.slice(".getnumber".length).trim();
  await handleGetNumber(args, from, async (jid, text) => {
    await sock.sendMessage(jid, { text });
  });
}

*/

// ═══════════════════════════════════════════════════════════════════
//  COMPLETE STANDALONE EXAMPLE (ek file mein sab kuch)
//  Apne bot ki main file (index.js) mein ye section add karo
// ═══════════════════════════════════════════════════════════════════

/*

// ─── TEAM ZERO PANEL INTEGRATION ────────────────────────────────
const TZ_PANEL_URL = "https://YOUR-PANEL-URL/api"; // ← APNA URL
const TZ_PANEL_SIG = "IPRN-SMS-PANEL-SECURE-2026";
const _tzSessions  = new Map();

// OTP Config (in-memory)
let _tzOtpCfg = {
  newsletter: "", offlink: "", numlink: "", dev: "Team Zero™ 🇵🇰",
  running: false, interval: null, seenIds: new Set()
};

async function _tzGet(ep) {
  const r = await fetch(`${TZ_PANEL_URL}${ep}`, {
    headers: { "x-app-request-signature": TZ_PANEL_SIG },
    signal: AbortSignal.timeout(10000)
  });
  return r.json();
}

const _tzCountryMap = {
  pk:"Pakistan",pakistan:"Pakistan","92":"Pakistan",
  in:"India",india:"India","91":"India",
  id:"Indonesia",indonesia:"Indonesia","62":"Indonesia",
  bd:"Bangladesh",bangladesh:"Bangladesh","880":"Bangladesh",
  ng:"Nigeria",nigeria:"Nigeria","234":"Nigeria",
  us:"United States","united states":"United States","1":"United States",
  gb:"United Kingdom",uk:"United Kingdom","44":"United Kingdom",
  ru:"Russia",russia:"Russia","7":"Russia",
  vn:"Vietnam",vietnam:"Vietnam","84":"Vietnam",
  ph:"Philippines",philippines:"Philippines","63":"Philippines",
  ke:"Kenya",kenya:"Kenya","254":"Kenya",
  gh:"Ghana",ghana:"Ghana","233":"Ghana",
  np:"Nepal",nepal:"Nepal","977":"Nepal",
  lk:"Sri Lanka","sri lanka":"Sri Lanka","94":"Sri Lanka",
  mm:"Myanmar",myanmar:"Myanmar","95":"Myanmar",
  th:"Thailand",thailand:"Thailand","66":"Thailand",
  my:"Malaysia",malaysia:"Malaysia","60":"Malaysia",
  uz:"Uzbekistan",uzbekistan:"Uzbekistan","998":"Uzbekistan",
  ua:"Ukraine",ukraine:"Ukraine","380":"Ukraine",
  mx:"Mexico",mexico:"Mexico","52":"Mexico",
  br:"Brazil",brazil:"Brazil","55":"Brazil",
};
const _tzFlags = {
  Pakistan:"🇵🇰",India:"🇮🇳",Indonesia:"🇮🇩",Bangladesh:"🇧🇩",Nigeria:"🇳🇬",
  "United States":"🇺🇸","United Kingdom":"🇬🇧",Russia:"🇷🇺",Ukraine:"🇺🇦",
  Vietnam:"🇻🇳",Philippines:"🇵🇭",Kenya:"🇰🇪",Ghana:"🇬🇭",
  Nepal:"🇳🇵","Sri Lanka":"🇱🇰",Myanmar:"🇲🇲",Thailand:"🇹🇭",Malaysia:"🇲🇾",
  Uzbekistan:"🇺🇿",Mexico:"🇲🇽",Brazil:"🇧🇷",
};

function _tzResolve(inp) {
  const k = String(inp||"").trim().toLowerCase().replace(/^\+/,"");
  return _tzCountryMap[k] || (inp.trim().charAt(0).toUpperCase() + inp.trim().slice(1));
}

function _tzExtractOtp(msg) {
  const m = String(msg||"").match(/\b(\d{4,8})\b/);
  return m ? m[1] : "⏳ Pending";
}

function _tzPollSms(num, jid, sock) {
  if (_tzSessions.has(num)) clearInterval(_tzSessions.get(num).iv);
  const seen = new Set();
  let tries = 0;
  const iv = setInterval(async () => {
    if (++tries > 45) {
      clearInterval(iv);
      _tzSessions.delete(num);
      await sock.sendMessage(jid, { text: `⏰ *Time Out!*\n\`${num}\` ka SMS 3 minute mein nahi aaya.\nDobara try karo: *.getnumber*` });
      return;
    }
    try {
      const d = await _tzGet(`/sms/by-number?number=${num}`);
      if (d?.sms?.length) {
        for (const s of d.sms) {
          const uid = s.id || s.message;
          if (!seen.has(uid)) {
            seen.add(uid);
            const flag = _tzFlags[s.country] || "🏳️";
            await sock.sendMessage(jid, { text:
              `✅ *OTP Received! — Team Zero*\n\n` +
              `📱 *Number:* \`${s.number}\`\n` +
              `${flag} *Country:* ${s.country||"-"}\n\n` +
              `🔑 *OTP:* \`${_tzExtractOtp(s.message)}\`\n\n` +
              `💬 *Full Message:*\n${s.message}\n\n` +
              `_Powered by ${_tzOtpCfg.dev}_`
            });
          }
        }
      }
    } catch(_) {}
  }, 4000);
  _tzSessions.set(num, { jid, iv });
}

// ─── In your sock.ev.on("messages.upsert") handler: ─────────────
// const body  = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
// const from  = msg.key.remoteJid;
// const isCmd = body.startsWith(".");

// .getnumber handler
if (body.toLowerCase().startsWith(".getnumber")) {
  const arg = body.slice(".getnumber".length).trim();
  (async () => {
    try {
      const data = await _tzGet("/numbers");
      if (!data?.success || !data.numbers?.length) {
        return sock.sendMessage(from, { text: "⚠️ Panel se numbers nahi mile. Baad mein try karo." });
      }
      if (!arg) {
        const counts = {};
        for (const n of data.numbers) counts[n.country||"Unknown"] = (counts[n.country||"Unknown"]||0)+1;
        const rows = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
        let txt = `🌍 *TEAM ZERO — Virtual Numbers*\n━━━━━━━━━━━━━━━━━\n📊 Total: ${data.numbers.length} | Countries: ${rows.length}\n\n`;
        for (const [c,n] of rows) txt += `${_tzFlags[c]||"🏳️"} *${c}*: ${n}\n`;
        txt += `\n━━━━━━━━━━━━━━━━━\n*.getnumber Pakistan* ya *.getnumber pk*`;
        return sock.sendMessage(from, { text: txt });
      }
      const country = _tzResolve(arg);
      const avail = data.numbers.filter(n=>n.country===country && !n.claimed);
      if (!avail.length) return sock.sendMessage(from, { text: `😔 *${_tzFlags[country]||""} ${country}* mein numbers nahi hain.\nDusra try karo: *.getnumber*` });
      const picked = avail[Math.floor(Math.random()*avail.length)];
      const numClean = picked.number.replace(/[\s\-\+]/g,"");
      await sock.sendMessage(from, { text:
        `✅ *${_tzFlags[country]||""} ${country} Number Mila!*\n\n` +
        `📱 *Number:* \`${picked.number}\`\n\n` +
        `⏳ *OTP auto-forward on hai...*\n_3 minute mein milega_\n\n` +
        `_Powered by ${_tzOtpCfg.dev}_`
      });
      _tzPollSms(numClean, from, sock);
    } catch(e) {
      sock.sendMessage(from, { text: `❌ Error: ${e.message}` });
    }
  })();
}

// .otp handler
if (body.toLowerCase().startsWith(".otp")) {
  const args = body.slice(4).trim();
  const parts = args.split(/\s+/);
  const sub = (parts[0]||"").toLowerCase();
  const val = parts.slice(1).join(" ").trim();

  (async () => {
    const send = (txt) => sock.sendMessage(from, { text: txt });

    if (sub === "set") {
      if (!val) return send("❌ *Usage:* .otp set <newsletter_jid>\nExample: .otp set 120363426165980012@newsletter");
      _tzOtpCfg.newsletter = val;
      return send(`✅ *Newsletter Set!*\n📢 JID: \`${val}\`\n\nAb *.otp start* kar dein!`);
    }
    if (sub === "offlink") {
      _tzOtpCfg.offlink = val;
      return send(`✅ *Official Link Set!*\n🔗 ${val}`);
    }
    if (sub === "numlink") {
      _tzOtpCfg.numlink = val;
      return send(`✅ *Number Link Set!*\n🔗 ${val}`);
    }
    if (sub === "dev") {
      _tzOtpCfg.dev = val || "Team Zero™ 🇵🇰";
      return send(`✅ *Brand Name Set!*\n🏷️ ${_tzOtpCfg.dev}`);
    }
    if (sub === "download") {
      if (!val) return send("❌ *Usage:* .otp download <country>\nExample: .otp download Pakistan");
      await send(`⏳ Fetching ${val} numbers...`);
      const data = await _tzGet("/numbers");
      const nums = (data?.numbers||[]).filter(n=>(n.country||"").toLowerCase()===val.toLowerCase());
      if (!nums.length) return send(`😔 ${val} ke numbers nahi mile.`);
      const lines = nums.map(n=>n.number).join("\n");
      await send(`📥 *${val} Numbers (${nums.length})*\n\n\`\`\`\n${lines}\n\`\`\`\n\n_Powered by ${_tzOtpCfg.dev}_`);
      try {
        await sock.sendMessage(from, {
          document: Buffer.from(`# ${val} Numbers\n\n${lines}\n`, "utf8"),
          mimetype: "text/plain",
          fileName: `${val.replace(/\s+/g,"_")}_numbers.txt`
        });
      } catch(_) {}
      return;
    }
    if (sub === "start") {
      if (!_tzOtpCfg.newsletter) return send("❌ Pehle newsletter set karo: .otp set <jid>");
      if (_tzOtpCfg.running) return send("⚠️ Pehle se chal rahi hai! .otp stop se band karo.");
      _tzOtpCfg.running = true;
      _tzOtpCfg.seenIds = new Set();
      _tzOtpCfg.interval = setInterval(async () => {
        if (!_tzOtpCfg.running) return;
        try {
          const d = await _tzGet("/sms");
          const list = d?.sms || d?.otps || [];
          for (const s of list) {
            const uid = s.id || `${s.number}:${(s.message||"").slice(0,40)}`;
            if (_tzOtpCfg.seenIds.has(uid)) continue;
            _tzOtpCfg.seenIds.add(uid);
            if (_tzOtpCfg.seenIds.size > 500) {
              const a = Array.from(_tzOtpCfg.seenIds);
              _tzOtpCfg.seenIds = new Set(a.slice(200));
            }
            const otp = _tzExtractOtp(s.message||"");
            const flag = _tzFlags[s.country]||"🏳️";
            let msg = `🔑 *OTP — ${flag} ${s.country||"Unknown"}*\n\n📱 \`${s.number}\`\n🔑 \`${otp}\`\n\n💬 ${s.message||""}`;
            if (_tzOtpCfg.offlink) msg += `\n\n📢 ${_tzOtpCfg.offlink}`;
            if (_tzOtpCfg.numlink) msg += `\n🔢 ${_tzOtpCfg.numlink}`;
            msg += `\n\n_Powered by ${_tzOtpCfg.dev}_`;
            try { await sock.sendMessage(_tzOtpCfg.newsletter, { text: msg }); } catch(_) {}
          }
        } catch(_) {}
      }, 5000);
      return send(`✅ *OTP Forwarding Started!*\n📢 Newsletter: \`${_tzOtpCfg.newsletter}\`\n\nBand karne ke liye: *.otp stop*`);
    }
    if (sub === "stop") {
      if (!_tzOtpCfg.running) return send("⚠️ Pehle se band hai. .otp start se shuru karo.");
      _tzOtpCfg.running = false;
      if (_tzOtpCfg.interval) { clearInterval(_tzOtpCfg.interval); _tzOtpCfg.interval = null; }
      return send(`🛑 *OTP Forwarding Stopped!*\nNewsletter mein OTPs aana band ho gayi.`);
    }
    // status (default)
    return send(
      `📊 *OTP Bot Status*\n\n` +
      `${_tzOtpCfg.running?"🟢 RUNNING":"🔴 STOPPED"}\n` +
      `📢 Newsletter: ${_tzOtpCfg.newsletter||"❌ Not set"}\n` +
      `🔗 Off Link: ${_tzOtpCfg.offlink||"Not set"}\n` +
      `🔢 Num Link: ${_tzOtpCfg.numlink||"Not set"}\n` +
      `🏷️ Dev: ${_tzOtpCfg.dev}\n\n` +
      `Commands: .otp set | .otp offlink | .otp numlink | .otp dev | .otp download | .otp start | .otp stop`
    );
  })();
}
// ─────────────────────────────────────────────────────────────────

*/
