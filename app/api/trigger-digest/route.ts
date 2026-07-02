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

  const response = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'content-type': 'application/json',
      },
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

  return Response.json({ ok: true, hours, source, categories });
}
