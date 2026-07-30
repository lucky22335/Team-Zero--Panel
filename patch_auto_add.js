const fs = require('fs');
const file = 'artifacts/api-server/src/routes/sms-routes.ts';
let data = fs.readFileSync(file, 'utf8');

const newStr = `async function autoAddNumbersFromApis() {
  if (isAutoAddingNumbers) return;
  isAutoAddingNumbers = true;
  try {
    const db = readDb();
    if (!db.manualNumbers) db.manualNumbers = [];
    if (!db.claimedNumbers) db.claimedNumbers = [];
    
    let addedCount = 0;
    const nowStr = new Date().toISOString();
    
    // Original aggregator logic (for API_ENDPOINTS)
    console.log("[AutoNumberAdder] Polling API aggregators...");
    const activeApiNumbers = await fetchAggregatedNumbers(undefined, true);
    for (const item of activeApiNumbers) {
      const cleanNum = item.number.replace(/[\\s\\-\\+]/g, "");
      if (!cleanNum || db.claimedNumbers.includes(cleanNum)) continue;
      const exists = db.manualNumbers.some((n: any) => n.number.replace(/[\\s\\-\\+]/g, "") === cleanNum);
      if (!exists) {
        const newNumObj = {
          id: "num_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
          number: item.number,
          country: item.country || "Unknown",
          server: item.source || "API Aggregator",
          addedAt: nowStr,
          autoAdded: true
        };
        db.manualNumbers.push(newNumObj);
        addedCount++;
      }
    }
    
    // New specific target APIs logic as requested by user
    if (autoAddConfig.enabled) {
      console.log("[AutoNumberAdder] Polling explicit target APIs for numbers...");
      const targetApis = [
        { label: "API 1", url: "http://147.135.212.197/crapi/st/viewstats", type: "array", auth: "SE5XREZBUzRfTpVnX2dQh3NQcYB2dZBWQ4JpXVxmblp2alCDi25oZg==" },
        { label: "API 2", url: "http://147.135.212.197/crapi/st/viewstats", type: "array", auth: "RVdWRElBUzRGcW9WeneNcmd2cGV9ZJd8e29PVlyPcFxeamxSgWVXfw==" },
        { label: "API 3", url: "https://pscall.net/restapi/smsreport", type: "pscall", auth: "SFNYSj1SS16DgYdyf4KIgA==" },
        { label: "API 4", url: "http://147.135.212.197/crapi/time/viewstats", type: "array", auth: "RldRNEVBYIFbkYpaY19udX53hX1DZnZhiI9iRkGEjGGFdXZKfmw==" },
        { label: "Api 5", url: "https://api-junaid-production.up.railway.app/api/ps?type=sms", type: "junaid" },
        { label: "Api 6", url: "https://api-junaid-production.up.railway.app/api/np?type=sms", type: "junaid" },
        { label: "API 7", url: "http://147.135.212.197/crapi/had/viewstats", type: "array", auth: "SlJSQjRSQldcko9XYX9Yh4p4eX5kl2tlRGKHYWhgWEhGgph7Undu" }
      ];

      for (const api of targetApis) {
        if (autoAddConfig.apis.includes("all") || autoAddConfig.apis.includes(api.label)) {
          let numberUrl = api.url.replace(/sms/g, "number");
          try {
            let parsed = [];
            if (api.type === "junaid") {
              const res = await fetchWithTimeout(numberUrl, {}, 4000);
              if (res.ok) {
                const text = await res.text();
                parsed = parseJunaidNumbers(text, api.label);
              }
            } else {
              const headers = api.auth ? { "Authorization": \`Basic \${api.auth}\` } : {};
              const res = await fetchWithTimeout(numberUrl, { method: "POST", headers }, 4000);
              if (res.ok) {
                const text = await res.text();
                parsed = parseSmsList(text, api.label);
              }
            }
            
            for (const item of parsed) {
              const cleanNum = item.number.replace(/[\\s\\-\\+]/g, "");
              if (!cleanNum || db.claimedNumbers.includes(cleanNum)) continue;
              const exists = db.manualNumbers.some((n: any) => n.number.replace(/[\\s\\-\\+]/g, "") === cleanNum);
              if (!exists) {
                db.manualNumbers.push({
                  id: "num_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
                  number: item.number,
                  country: item.country || "Unknown",
                  server: item.source || api.label,
                  addedAt: nowStr,
                  autoAdded: true
                });
                addedCount++;
              }
            }
          } catch (e) {
            // Ignore if endpoint fails
          }
        }
      }
    }

    if (addedCount > 0) {
      writeDb(db);
      console.log(\`[AutoNumberAdder] Successfully auto-added \${addedCount} new numbers.\`);
    } else {
      console.log("[AutoNumberAdder] No new unique numbers found to auto-add.");
    }
  } catch (err: any) {
    console.error("[AutoNumberAdder] Error:", err.message);
  } finally {
    isAutoAddingNumbers = false;
    if (!process.env.VERCEL) {
      setTimeout(autoAddNumbersFromApis, 60 * 1000);
    }
  }
}`;

const oldFuncStart = data.indexOf("async function autoAddNumbersFromApis() {");
const oldFuncEnd = data.indexOf("// Cleanup stale claimed numbers every 30 minutes");

if (oldFuncStart !== -1 && oldFuncEnd !== -1) {
  data = data.substring(0, oldFuncStart) + newStr + "\n\n" + data.substring(oldFuncEnd);
  fs.writeFileSync(file, data);
  console.log("Successfully replaced autoAddNumbersFromApis");
} else {
  console.log("Could not find autoAddNumbersFromApis limits");
}
