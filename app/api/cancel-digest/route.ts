// Cancels a workflow run that was just triggered from the site - for when
// the user picked the wrong mục/hours and wants to bail before the job
// reaches the Claude/Qwen summarization step and actually spends tokens.
const OWNER = 'hoangxin';
const REPO = 'loc_tin_qwen';

export async function POST(request: Request) {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    return Response.json({ error: 'Server chưa cấu hình GITHUB_DISPATCH_TOKEN' }, { status: 500 });
  }

  let runId: number | null = null;
  try {
    const body = await request.json();
    const parsed = Number(body?.runId);
    if (Number.isFinite(parsed)) runId = parsed;
  } catch {
    // no/invalid JSON body
  }

  if (!runId) {
    return Response.json({ error: 'Thiếu runId' }, { status: 400 });
  }

  const response = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/runs/${runId}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  // 409 means the run already finished (or is already being cancelled) -
  // nothing left to cancel, so treat it as a successful no-op rather than
  // an error the user needs to see.
  if (!response.ok && response.status !== 409) {
    console.error('github cancel failed', response.status, await response.text());
    return Response.json({ error: 'Không huỷ được workflow' }, { status: 502 });
  }

  return Response.json({ ok: true });
}
