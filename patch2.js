const fs = require('fs');
const file = 'artifacts/api-server/src/routes/sms-routes.ts';
let data = fs.readFileSync(file, 'utf8');

const target1 = `    let allNewSms = [...api1Logs, ...api2Logs, ...api3Logs, ...api4Logs, ...api5Logs, ...api6Logs, ...api7Logs];
    
    // STRICT FILTER: Keep only real OTPs (ignore spam, promotional, or messages without codes)
    // This applies to both the Panel (/Api) and Telegram forwarding.
    allNewSms = allNewSms.filter(sms => extractOtp(sms.message || "") !== "PENDING");`;
const replacement1 = `    const allNewSms = [...api1Logs, ...api2Logs, ...api3Logs, ...api4Logs, ...api5Logs, ...api6Logs, ...api7Logs];`;

const target2 = `    const list = await fetchAggregatedSms();
    // Extra safety filter for the /Api route to only serve real OTPs
    const realOtpsList = list.filter((o: any) => extractOtp(o.message || "") !== "PENDING");
    const db = readDb();
    
    const augmentedList = realOtpsList.map((o: any) => {`;
const replacement2 = `    const list = await fetchAggregatedSms();
    const db = readDb();
    
    const augmentedList = list.map((o: any) => {`;

data = data.replace(target1, replacement1);
data = data.replace(target2, replacement2);

fs.writeFileSync(file, data);
