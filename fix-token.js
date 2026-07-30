const fs = require('fs');
const file = 'artifacts/api-server/src/routes/sms-routes.ts';
let data = fs.readFileSync(file, 'utf8');

data = data.replace(
  '    process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "YOUR_GITHUB_TOKEN_HERE";',
  '    process.env.GITHUB_TOKEN = "YOUR_GITHUB_TOKEN_HERE"; // FORCE OVERRIDE'
);
data = data.replace(
  /if \(!process\.env\.GITHUB_REPO\) {\s*process\.env\.GITHUB_REPO = "lucky22335\/Team-Zero--Panel";\s*}/,
  'process.env.GITHUB_REPO = "lucky22335/Team-Zero--Panel"; // FORCE OVERRIDE'
);

fs.writeFileSync(file, data);
