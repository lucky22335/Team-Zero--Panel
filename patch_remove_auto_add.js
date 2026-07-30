const fs = require('fs');
const file = 'artifacts/api-server/src/routes/sms-routes.ts';
let data = fs.readFileSync(file, 'utf8');

// Remove SMS auto add from runFastUserApiPoller
const autoAddFastStart = data.indexOf('// ── Auto-Number-Add Feature');
const autoAddFastEnd = data.indexOf('// ─────────────────────────────────────────────────────────────────────', autoAddFastStart);
if (autoAddFastStart !== -1 && autoAddFastEnd !== -1) {
    data = data.substring(0, autoAddFastStart) + data.substring(autoAddFastEnd);
    console.log("Removed auto-add from fast poller");
} else {
    console.log("Could not find auto-add in fast poller");
}

// Remove SMS auto add from fetchAggregatedSms
const autoAddSlowStr = `      const workerAutoAddBlocked = ["API 2"];
      if (autoAddConfig.enabled && !workerAutoAddBlocked.includes(smsSource)) {
        const workerApiSource = smsSource;
        const apiMatch = autoAddConfig.apis.includes("all") || autoAddConfig.apis.includes(workerApiSource);
        if (apiMatch) {
          if (!db.manualNumbers) db.manualNumbers = [];
          const alreadyIn = db.manualNumbers.some((n: any) => n.number.replace(/[\\s\\-\\+]/g, "") === numberClean);
          if (!alreadyIn) {
            db.manualNumbers.push({
              id: "num_auto_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
              number: otp.number,
              country: country || "Unknown",
              server: service || workerApiSource,
              addedAt: new Date().toISOString(),
              autoAdded: true,
              apiSource: workerApiSource
            });
            dbUpdated = true;
            console.log(\`[AutoAdd-Worker] ✅ Added \${otp.number} → service: \${service || workerApiSource} | API: \${workerApiSource}\`);
          }
        }
      }`;

if (data.includes(autoAddSlowStr)) {
    data = data.replace(autoAddSlowStr, '');
    console.log("Removed auto-add from worker/slow poller");
} else {
    console.log("Could not find auto-add in worker poller");
}

fs.writeFileSync(file, data);
