import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { buildDigest } from '../lib/digest';

const OUTPUT_PATH = join(__dirname, '..', 'data', 'latest-digest.json');
const hours = Number(process.env.DIGEST_HOURS) || 24;

buildDigest(hours)
  .then((digest) => {
    mkdirSync(join(__dirname, '..', 'data'), { recursive: true });
    writeFileSync(OUTPUT_PATH, JSON.stringify(digest, null, 2), 'utf-8');
    console.log(`Wrote ${digest.count} items across ${digest.groups.length} mục to ${OUTPUT_PATH}`);
  })
  .catch((error) => {
    console.error('news digest failed', error);
    process.exitCode = 1;
  });
