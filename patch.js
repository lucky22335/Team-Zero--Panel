const fs = require('fs');
const file = 'artifacts/api-server/src/routes/sms-routes.ts';
let data = fs.readFileSync(file, 'utf8');

const target = `    const allNewSms = [...api1Logs, ...api2Logs, ...api3Logs, ...api4Logs, ...api5Logs, ...api6Logs, ...api7Logs];`;
const replacement = `    let allNewSms = [...api1Logs, ...api2Logs, ...api3Logs, ...api4Logs, ...api5Logs, ...api6Logs, ...api7Logs];
    
    // STRICT FILTER: Keep only real OTPs (ignore spam, promotional, or messages without codes)
    // This applies to both the Panel (/Api) and Telegram forwarding.
    allNewSms = allNewSms.filter(sms => extractOtp(sms.message || "") !== "PENDING");`;

data = data.replace(target, replacement);

const target2 = `    const list = await fetchAggregatedSms();
    const db = readDb();`;
const replacement2 = `    const list = await fetchAggregatedSms();
    // Extra safety filter for the /Api route to only serve real OTPs
    const realOtpsList = list.filter((o: any) => extractOtp(o.message || "") !== "PENDING");
    const db = readDb();`;

data = data.replace(target2, replacement2);
data = data.replace(
  `const augmentedList = list.map((o: any) => {`,
  `const augmentedList = realOtpsList.map((o: any) => {`
);

fs.writeFileSync(file, data);
