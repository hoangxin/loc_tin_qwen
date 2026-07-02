import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { buildDigest, type Digest } from '../lib/digest';

const OUTPUT_PATH = join(__dirname, '..', 'data', 'latest-digest.json');
const hours = Number(process.env.DIGEST_HOURS) || 24;
const source = process.env.DIGEST_SOURCE?.trim() || undefined;
const categories = process.env.DIGEST_CATEGORIES?.trim()
  ? process.env.DIGEST_CATEGORIES.split(',').map((category) => category.trim()).filter(Boolean)
  : undefined;

// A run scoped to one source (triggered from a single tab's "Tổng hợp"
// button) only fetches that source's mục - everything else must be kept
// as-is from the previous digest instead of getting wiped out.
function mergeDigest(existing: Digest | null, fresh: Digest): Digest {
  if (!existing || !source) return fresh;

  const freshKeys = new Set(fresh.groups.map((group) => `${group.source}::${group.category}`));
  const untouchedGroups = existing.groups.filter((group) => !freshKeys.has(`${group.source}::${group.category}`));
  const groups = [...untouchedGroups, ...fresh.groups];

  return {
    generatedAt: fresh.generatedAt,
    count: groups.reduce((sum, group) => sum + group.items.length, 0),
    groups,
  };
}

async function main() {
  const fresh = await buildDigest(hours, source, categories);

  let existing: Digest | null = null;
  if (existsSync(OUTPUT_PATH)) {
    try {
      existing = JSON.parse(readFileSync(OUTPUT_PATH, 'utf-8')) as Digest;
    } catch (error) {
      console.error('failed to read existing digest, will overwrite it', error);
    }
  }

  const digest = mergeDigest(existing, fresh);

  mkdirSync(join(__dirname, '..', 'data'), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(digest, null, 2), 'utf-8');
  console.log(`Wrote ${digest.count} items across ${digest.groups.length} mục to ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error('news digest failed', error);
  process.exitCode = 1;
});
