const fs = require('fs');
const cp = require('child_process');

const catalog = {
  '@replit/vite-plugin-cartographer': '^0.5.21',
  '@replit/vite-plugin-dev-banner': '^0.1.1',
  '@replit/vite-plugin-runtime-error-modal': '^0.0.6',
  '@tailwindcss/vite': '^4.1.14',
  '@tanstack/react-query': '^5.90.21',
  '@types/node': '^25.3.3',
  '@types/react': '^19.2.0',
  '@types/react-dom': '^19.2.0',
  '@vitejs/plugin-react': '^5.0.4',
  'class-variance-authority': '^0.7.1',
  'clsx': '^2.1.1',
  'drizzle-orm': '^0.45.2',
  'framer-motion': '^12.23.24',
  'lucide-react': '^0.545.0',
  'react': '19.1.0',
  'react-dom': '19.1.0',
  'tailwind-merge': '^3.3.1',
  'tailwindcss': '^4.1.14',
  'tsx': '^4.21.0',
  'vite': '^7.3.2',
  'wouter': '^3.3.5',
  'zod': '^3.25.76'
};

function processPackage(filePath) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return;
  }
  
  let changed = false;
  
  if (pkg.packageManager) {
    delete pkg.packageManager;
    changed = true;
  }

  const sections = ['dependencies', 'devDependencies', 'peerDependencies'];
  for (const section of sections) {
    if (pkg[section]) {
      for (const [name, ver] of Object.entries(pkg[section])) {
        if (ver === 'catalog:') {
          if (catalog[name]) {
            pkg[section][name] = catalog[name];
            changed = true;
          } else {
            pkg[section][name] = '*'; // fallback
            changed = true;
          }
        } else if (ver.startsWith('workspace:')) {
          pkg[section][name] = '*';
          changed = true;
        }
      }
    }
  }

  // Also replace pnpm with npm in scripts
  if (pkg.scripts) {
    for (const [name, script] of Object.entries(pkg.scripts)) {
      if (typeof script === 'string') {
        const newScript = script.replace(/pnpm/g, 'npm');
        if (newScript !== script) {
          pkg.scripts[name] = newScript;
          changed = true;
        }
      }
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('Updated ' + filePath);
  }
}

const files = cp.execSync('find . -name package.json -not -path "*/node_modules/*"').toString().trim().split('\n');
files.forEach(f => processPackage(f));
