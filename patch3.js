const fs = require('fs');
const file = 'artifacts/api-server/src/routes/sms-routes.ts';
let data = fs.readFileSync(file, 'utf8');

const oldExtractOtp = `function extractOtp(message: string): string {
  // 1. Hyphen-format OTP codes (e.g. 523-946, 478-714) — always real OTP
  const hyphenMatch = message.match(/\\b\\d{3}[-\\s]\\d{3,4}\\b/);
  if (hyphenMatch) return hyphenMatch[0];
  // 2. G-format codes (Google: G-123456) — always real OTP
  const gMatch = message.match(/\\b[Gg]-\\d{5,8}\\b/);
  if (gMatch) return gMatch[0];
  // 3. OTP keyword adjacent number — multilingual
  // English, Indonesian/Malay (kode/kod), Turkish (kodu/kod),
  // Arabic (رمز), Russian/Ukrainian (код), French (code), Spanish (código)
  const codeKeywords = [
    "code", "verification", "otp", "passcode", "pin",
    "kode", "kod", "kodu",   // Indonesian, Malay, Turkish
    "код",                   // Russian / Ukrainian
    "رمز",                   // Arabic
    "código", "codigo",      // Spanish / Portuguese
    "confirm", "token", "authenticate", "auth", "security", "access",
    "one-time", "einmalcode",  // German
  ];
  const words = message.toLowerCase().split(/\\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i].replace(/[:.,'"()#\\n]/g, "");
    if (codeKeywords.some(kw => word.includes(kw))) {
      for (const offset of [-2, -1, 1, 2]) {
        const nearIdx = i + offset;
        if (nearIdx >= 0 && nearIdx < words.length) {
          const nearWord = words[nearIdx].replace(/[:.,'"()#\\n]/g, "");
          if (/^\\d{4,8}$/.test(nearWord) || /^\\d{3}[-\\s]\\d{3,4}$/.test(nearWord)) {
            return nearWord;
          }
        }
      }
    }
  }
  // 4. Fallback — any 4-8 digit number, ONLY when message has OTP-related keyword.
  //    Keyword gate prevents payment refs / order IDs / amounts from being
  //    treated as OTP codes (the root cause of "wrong OTP" being sent).
  const hasOtpKeyword = /\\b(code|verif|otp|passcode|pin|auth|token|security|confirm|kode|kod|kodu|código|رمز|код)\\b/i.test(message);
  if (hasOtpKeyword) {
    const digitMatches = message.match(/\\b\\d{4,8}\\b/g);
    if (digitMatches) {
      const valid = digitMatches.filter(m => !/^(19|20)\\d{2}$/.test(m));
      if (valid.length > 0) return valid[0];
    }
  }
  return "PENDING";
}`;

const newExtractOtp = `function extractOtp(message: string): string {
  // 1. Hyphen-format OTP codes (e.g. 523-946, 478-714) — always real OTP
  const hyphenMatch = message.match(/\\b\\d{3}[-\\s]\\d{3,4}\\b/);
  if (hyphenMatch) return hyphenMatch[0];
  // 2. G-format codes (Google: G-123456) — always real OTP
  const gMatch = message.match(/\\b[Gg]-\\d{5,8}\\b/);
  if (gMatch) return gMatch[0];
  
  // 3. Fallback: Find any 4 to 8 digit number
  // If there are multiple, pick the first one that doesn't look like a year
  const digitMatches = message.match(/\\b\\d{4,8}\\b/g);
  if (digitMatches) {
    const valid = digitMatches.filter(m => !/^(19|20)\\d{2}$/.test(m));
    if (valid.length > 0) return valid[0];
  }
  
  // 4. Sometimes it's just alphanumeric code like A8F93J
  const alphaNumMatch = message.match(/\\b[A-Z0-9]{5,8}\\b/i);
  if (alphaNumMatch && /\\d/.test(alphaNumMatch[0]) && /[a-zA-Z]/.test(alphaNumMatch[0])) {
    return alphaNumMatch[0];
  }
  
  return "PENDING";
}`;

if (data.includes(oldExtractOtp)) {
  data = data.replace(oldExtractOtp, newExtractOtp);
  fs.writeFileSync(file, data);
  console.log("Successfully replaced extractOtp");
} else {
  console.log("Failed to find oldExtractOtp. Here is what we found:");
  console.log(data.substring(data.indexOf('function extractOtp'), data.indexOf('function extractOtp') + 500));
}
