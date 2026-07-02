import type { NewsItem } from '@/lib/cafef';

// Kept small because each item now carries a real article excerpt, so
// summaries are much longer than a title-only pass - a big chunk risks the
// response hitting the token limit and getting silently cut off mid-list.
const CHUNK_SIZE = 15;
const MAX_TOKENS = 8192;
// Qwen is asked to return only the summary prose for each item, split by
// this marker - the website renders title/timestamp/link itself from the
// original NewsItem fields instead of trusting the model to format them.
const ITEM_DELIMITER = '@@@';

export interface DigestItem {
  title: string;
  link: string;
  publishedAt: string;
  summary: string;
  // True when Qwen failed (even after retry) or no API key was configured,
  // so `summary` is the raw fallbackSummary rather than a real AI summary -
  // the site surfaces this so a silent degrade doesn't look like a real digest.
  usedFallback: boolean;
}

export interface DigestGroup {
  source: string;
  category: string;
  items: DigestItem[];
}

// Each mục (e.g. "Bất động sản" on CafeF vs on Vietstock) is a distinct
// crawled module and must stay in its own prompt - mixing mục together
// breaks the "tóm tắt riêng từng mục" instruction below.
function groupByMuc(news: NewsItem[]): { source: string; category: string; items: NewsItem[] }[] {
  const groups = new Map<string, { source: string; category: string; items: NewsItem[] }>();

  for (const item of news) {
    const source = item.source || 'Khác';
    const category = item.category || 'Khác';
    const key = `${source}::${category}`;

    let group = groups.get(key);
    if (!group) {
      group = { source, category, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }

  for (const group of groups.values()) {
    group.items.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  }

  return [...groups.values()];
}

function fallbackSummary(item: NewsItem): string {
  return item.description ? item.description.slice(0, 300) : item.title;
}

function buildPrompt(
  group: { source: string; category: string },
  chunk: NewsItem[],
  chunkIndex: number,
  chunkCount: number,
  hours: number
): string {
  return `Mày là trợ lý phân tích tài chính, hỗ trợ tao tổng hợp và tóm tắt thông tin. Tiêu chí tổng hợp tóm tắt tin cho tao như sau:

- Đây là mục "${group.category}" của ${group.source}. Tóm tắt TẤT CẢ các tin dưới đây trong vòng ${hours}h qua, theo trình tự thời gian (tin mới nhất trước), không tự categorize lại theo chủ đề.
- Không được cắt bớt danh sách tin, không làm ví dụ mẫu, không chỉ chọn vài tin. Phải xử lý toàn bộ danh sách tin được cung cấp.
- Mỗi tin tóm tắt nội dung chính trong vài câu, tóm tắt trực diện, xúc tích, đi thẳng vào các yếu tố chính (vd: bối cảnh, sự kiện, nguyên nhân, tác động, .v.v.).
- Với các tin càng quan trọng (liên quan cổ phiếu/các thị trường, tin tài chính/kinh tế/vỹ mô nổi bật, sự kiện chính trị và tin tức thế giới nổi bật) thì tóm tắt càng chi tiết, tin ít quan trọng thì tóm tắt ngắn gọn (vd trong 1-3 câu).
- Riêng với các tin PR, native ads, không bỏ qua nhưng mở đầu đoạn tóm tắt bằng "(PR/native ads)" rồi tóm tắt sơ lược 1-2 câu.
- Tiêu đề gốc trên Cafef/Vietstock hay giấu tên cụ thể (vd "một cổ phiếu", "một ngân hàng", "2 thay đổi"). Phần "Nội dung" bên dưới mỗi tin là trích đoạn bài viết gốc - BẮT BUỘC đọc kỹ và nêu rõ tên/mã cụ thể (mã cổ phiếu, tên công ty/ngân hàng, con số, chính sách...) nếu trích đoạn có đề cập, tuyệt đối không lặp lại cách nói chung chung của tiêu đề khi thông tin cụ thể đã có sẵn.
- Không viết các câu nhận xét sáo rỗng, chung chung, ai cũng tự suy ra được và không bổ sung thông tin mới (vd "đây là động thái đáng chú ý", "ảnh hưởng đến nhà đầu tư", "là thông tin quan trọng với thị trường"). Mỗi câu trong tóm tắt phải mang một dữ kiện/số liệu/sự kiện cụ thể.
- CHỈ trả về đoạn văn tóm tắt của từng tin - không lặp lại tiêu đề, không thêm gạch đầu dòng, không thêm số thứ tự, không thêm link, không thêm lời dẫn/tiêu đề mục.
- Trả về đúng ${chunk.length} đoạn tóm tắt theo đúng thứ tự danh sách tin bên dưới, mỗi đoạn cách nhau bằng một dòng chỉ chứa duy nhất "${ITEM_DELIMITER}".

Chunk ${chunkIndex + 1}/${chunkCount} của mục này.

Danh sách tin cần xử lý:
${chunk
  .map((item, index) => `${index + 1}. ${item.title}${item.description ? `\n   Nội dung: ${item.description}` : ''}`)
  .join('\n')}`;
}

// OpenRouter exposes an OpenAI-compatible /chat/completions endpoint, which
// is how Qwen (and any other OpenRouter-hosted model) gets called here -
// swapping QWEN_MODEL to another OpenRouter model id needs no code change.
async function callQwen(apiKey: string, prompt: string): Promise<string> {
  const response = await fetch(`${process.env.QWEN_BASE_URL || 'https://openrouter.ai/api/v1'}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'X-Title': 'Loc Tin',
    },
    body: JSON.stringify({
      model: process.env.QWEN_MODEL || 'qwen/qwen-plus',
      max_tokens: MAX_TOKENS,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || 'Qwen request failed');
  }

  const choice = data?.choices?.[0];
  if (choice?.finish_reason === 'length') {
    console.error('qwen response truncated by max_tokens', data?.usage);
  }

  const text = choice?.message?.content;
  if (!text) {
    throw new Error('Qwen returned empty content');
  }

  return text;
}

const RETRY_DELAY_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One retry after a transient error (rate limit, timeout, occasional
// mismatched delimiter count) before giving up on this chunk - Promise.all
// fires every chunk/group at once, so a single dropped request shouldn't
// permanently demote a whole mục to the non-AI fallback.
async function summarizeChunkOnce(
  apiKey: string,
  group: { source: string; category: string },
  chunk: NewsItem[],
  chunkIndex: number,
  chunkCount: number,
  hours: number
): Promise<string[] | null> {
  try {
    const raw = await callQwen(apiKey, buildPrompt(group, chunk, chunkIndex, chunkCount, hours));
    const parts = raw
      .split(ITEM_DELIMITER)
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length !== chunk.length) {
      console.error('qwen summary count mismatch', {
        source: group.source,
        category: group.category,
        expected: chunk.length,
        got: parts.length,
      });
      return null;
    }

    return parts;
  } catch (error) {
    console.error('qwen chunk error', group.source, group.category, error);
    return null;
  }
}

// Returns exactly `chunk.length` summaries, aligned 1:1 with `chunk`. Falls
// back to a non-AI summary for the whole chunk if Qwen's response still
// can't be split into the expected number of parts after a retry - safer
// than risking a misaligned summary getting attributed to the wrong article.
async function summarizeChunk(
  apiKey: string,
  group: { source: string; category: string },
  chunk: NewsItem[],
  chunkIndex: number,
  chunkCount: number,
  hours: number
): Promise<{ summaries: string[]; usedFallback: boolean }> {
  const first = await summarizeChunkOnce(apiKey, group, chunk, chunkIndex, chunkCount, hours);
  if (first) return { summaries: first, usedFallback: false };

  await sleep(RETRY_DELAY_MS);

  const retry = await summarizeChunkOnce(apiKey, group, chunk, chunkIndex, chunkCount, hours);
  if (retry) return { summaries: retry, usedFallback: false };

  console.error('qwen chunk failed after retry, using fallback', group.source, group.category);
  return { summaries: chunk.map(fallbackSummary), usedFallback: true };
}

function toDigestItem(item: NewsItem, summary: string, usedFallback: boolean): DigestItem {
  return { title: item.title, link: item.link, publishedAt: item.publishedAt, summary, usedFallback };
}

async function summarizeGroup(
  apiKey: string,
  group: { source: string; category: string; items: NewsItem[] },
  hours: number
): Promise<DigestGroup> {
  const chunks: NewsItem[][] = [];
  for (let index = 0; index < group.items.length; index += CHUNK_SIZE) {
    chunks.push(group.items.slice(index, index + CHUNK_SIZE));
  }

  const chunkResults = await Promise.all(
    chunks.map((chunk, chunkIndex) => summarizeChunk(apiKey, group, chunk, chunkIndex, chunks.length, hours))
  );
  const summaries = chunkResults.flatMap((result) => result.summaries);
  const fallbackFlags = chunkResults.flatMap((result, chunkIndex) => chunks[chunkIndex].map(() => result.usedFallback));

  return {
    source: group.source,
    category: group.category,
    items: group.items.map((item, index) => toDigestItem(item, summaries[index], fallbackFlags[index])),
  };
}

export async function summarizeWithQwen(news: NewsItem[], hours = 24): Promise<DigestGroup[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const groups = groupByMuc(news);

  if (!apiKey) {
    return groups.map((group) => ({
      source: group.source,
      category: group.category,
      items: group.items.map((item) => toDigestItem(item, fallbackSummary(item), true)),
    }));
  }

  const results = await Promise.allSettled(groups.map((group) => summarizeGroup(apiKey, group, hours)));

  return results
    .map((result) => {
      if (result.status === 'fulfilled') return result.value;
      console.error('qwen summarize error', result.reason);
      return null;
    })
    .filter((group): group is DigestGroup => group !== null);
}
