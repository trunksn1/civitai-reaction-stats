import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectStatsData } from './lib/stats-validation.js';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node validate-stats-file.js /path/to/stats.json');
  process.exit(2);
}

try {
  const content = await readFile(inputPath, 'utf8');
  const data = JSON.parse(content);
  const summary = inspectStatsData(data);
  const sha256 = createHash('sha256').update(content).digest('hex');
  console.log(JSON.stringify({
    file: path.resolve(inputPath),
    bytes: Buffer.byteLength(content),
    sha256,
    username: data.username || null,
    lastUpdated: data.lastUpdated || null,
    ...summary
  }, null, 2));
} catch (error) {
  console.error(`Invalid stats file: ${error.message}`);
  process.exit(1);
}
