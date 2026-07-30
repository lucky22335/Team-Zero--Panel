const fs = require('fs');
const file = 'artifacts/api-server/src/routes/sms-routes.ts';
let data = fs.readFileSync(file, 'utf8');

const startIndex = data.indexOf("function extractOtp(message: string): string {");
const endIndex = data.indexOf("function escapeTelegramHtml(str: string): string {");

if (startIndex !== -1 && endIndex !== -1) {
  const oldExtractOtp = data.substring(startIndex, endIndex);
  
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
}

`;

  data = data.replace(oldExtractOtp, newExtractOtp);
  fs.writeFileSync(file, data);
  console.log("Replaced using indices.");
} else {
  console.log("Could not find start/end indices.");
}
