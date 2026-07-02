import digestJson from '@/data/latest-digest.json';
import type { Digest } from '@/lib/digest';

// The client polls this after triggering a run: `data/latest-digest.json` is
// bundled at build time, so `generatedAt` only changes once a *new* Vercel
// deployment (built from the workflow's commit) goes live - which is exactly
// the moment the page actually has something new to show.
export const dynamic = 'force-dynamic';

const digest = digestJson as Digest;

export async function GET() {
  return Response.json({ generatedAt: digest.generatedAt });
}
