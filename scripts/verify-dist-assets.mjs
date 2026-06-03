import fs from 'node:fs';
import path from 'node:path';

const distAssetsDir = path.resolve('dist', 'assets');
const forbiddenToken = 'GEMINI_API_KEY';
const forbiddenBytes = Buffer.from(forbiddenToken, 'utf8');

function collectFiles(directory, accumulator = []) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, accumulator);
      continue;
    }

    accumulator.push(fullPath);
  }

  return accumulator;
}

if (!fs.existsSync(distAssetsDir)) {
  console.error(`Expected build output directory was not found: ${distAssetsDir}`);
  process.exit(1);
}

const offendingFiles = collectFiles(distAssetsDir)
  .filter(filePath => fs.readFileSync(filePath).includes(forbiddenBytes))
  .map(filePath => path.relative(process.cwd(), filePath));

if (offendingFiles.length > 0) {
  console.error(`Forbidden token ${forbiddenToken} found in built assets:`);
  for (const filePath of offendingFiles) {
    console.error(` - ${filePath}`);
  }
  process.exit(1);
}

console.log(`Verified ${path.relative(process.cwd(), distAssetsDir)} contains no ${forbiddenToken} references.`);