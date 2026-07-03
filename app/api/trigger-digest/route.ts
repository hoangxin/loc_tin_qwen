// Triggers the existing news-digest GitHub Actions workflow instead of
// running the scrape/summarize job inline - it takes several minutes
// (Puppeteer + many Qwen calls), well past what a Vercel serverless
// function can hold open.
const OWNER = 'hoangxin';
const REPO = 'loc_tin_qwen';
const WORKFLOW_FILE = 'news-digest.yml';
const MIN_HOURS = 1;
const MAX_HOURS = 168;
const VALID_SOURCES = ['CafeF', 'Vietstock'];

const GITHUB_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// workflow_dispatch itself returns 204 with no run id, so the freshly queued
// run has to be located by listing runs and taking the newest one created
// after we dispatched - good enough for a single-user tool with no
// concurrent triggers. Lets the client cancel a mis-clicked run before it
// burns Claude/Qwen tokens.
async function findDispatchedRunId(token: string, dispatchedAt: number): Promise<number | null> {
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(500);
    const runsResponse = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=5`,
      { headers: GITHUB_HEADERS(token) }
    );
    if (!runsResponse.ok) continue;

    const runsData = await runsResponse.json();
    const match = (runsData?.workflow_runs || []).find(
      (run: { created_at: string }) => new Date(run.created_at).getTime() >= dispatchedAt - 5000
    );
    if (match) return match.id;
  }
  return null;
}

export async function POST(request: Request) {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    return Response.json({ error: 'Server chưa cấu hình GITHUB_DISPATCH_TOKEN' }, { status: 500 });
  }

  let hours = 24;
  let source = '';
  let categories: string[] = [];
  try {
    const body = await request.json();
    const parsedHours = Number(body?.hours);
    if (Number.isFinite(parsedHours)) {
      hours = Math.min(Math.max(Math.round(parsedHours), MIN_HOURS), MAX_HOURS);
    }
    if (typeof body?.source === 'string' && VALID_SOURCES.includes(body.source)) {
      source = body.source;
    }
    if (Array.isArray(body?.categories)) {
      categories = body.categories.filter((c: unknown): c is string => typeof c === 'string' && c.length > 0);
    }
  } catch {
    // no/invalid JSON body
  }

  if (!source) {
    return Response.json({ error: 'Thiếu nguồn tin (source)' }, { status: 400 });
  }
  if (categories.length === 0) {
    return Response.json({ error: 'Chọn ít nhất một mục' }, { status: 400 });
  }

  const dispatchedAt = Date.now();
  const response = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: 'POST',
      headers: { ...GITHUB_HEADERS(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        ref: 'main',
        inputs: { hours: String(hours), source, categories: categories.join(',') },
      }),
    }
  );

  if (!response.ok) {
    console.error('github dispatch failed', response.status, await response.text());
    return Response.json({ error: 'Không kích hoạt được workflow' }, { status: 502 });
  }

  const runId = await findDispatchedRunId(token, dispatchedAt);

  return Response.json({ ok: true, hours, source, categories, runId });
}
