import type { NewsItem } from '@/lib/cafef';

// Kept small because each item now carries a real article excerpt, so
// summaries are much longer than a title-only pass - a big chunk risks the
// response hitting the token limit and getting silently cut off mid-list.
const CHUNK_SIZE = 15;
// qwen-plus on OpenRouter allows up to 32768 completion tokens - content-dense
// mục (Tài chính ngân hàng, Doanh nghiệp) routinely need detailed summaries
// that blew past the old 8192 cap, truncating mid-list every single retry
// (temperature 0 means retries reproduce the same over-length response).
const MAX_TOKENS = 24576;
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
  // When this mục's summaries were (re)built - lets the UI highlight tabs
  // that were just refreshed vs. ones that are hours stale.
  generatedAt: string;
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

function capitalizeFirst(text: string): string {
  return text.charAt(0).toLocaleUpperCase('vi-VN') + text.slice(1);
}

// Safety net for the prompt instruction above: Qwen still occasionally
// chains several facts into one run-on sentence joined by ";" instead of
// splitting them into separate sentences - break those back into sentences
// ending in "." so the digest doesn't render a giant semicolon-spliced clause.
function normalizeSummaryPunctuation(summary: string): string {
  const sentences = summary
    .split(/;\s*/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (sentences.length <= 1) return summary;

  return sentences
    .map((sentence, index) => {
      const withPeriod = /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
      return index === 0 ? withPeriod : capitalizeFirst(withPeriod);
    })
    .join(' ');
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
- Mỗi tin tóm tắt nội dung chính, tóm tắt trực diện, xúc tích, đi thẳng vào các yếu tố chính (vd: bối cảnh, sự kiện, nguyên nhân, tác động, .v.v.). TỐI ĐA 5 câu cho mỗi tin, không được vượt quá dù tin có nhiều thông tin đến đâu - chỉ chọn giữ lại những dữ kiện/số liệu quan trọng nhất, bỏ bớt chi tiết phụ.
- Viết mỗi ý/dữ kiện thành một câu riêng, kết thúc bằng dấu chấm. TUYỆT ĐỐI KHÔNG nối nhiều câu/mệnh đề lại với nhau bằng dấu chấm phẩy ";" thành một câu dài - chỉ dùng dấu phẩy trong nội bộ một câu khi liệt kê ngắn, còn giữa các câu/ý khác nhau bắt buộc ngắt câu bằng dấu chấm.
- Với các tin càng quan trọng (liên quan cổ phiếu/các thị trường, tin tài chính/kinh tế/vỹ mô nổi bật, sự kiện chính trị và tin tức thế giới nổi bật) thì tóm tắt càng gần mức tối đa 5 câu, tin ít quan trọng thì tóm tắt ngắn gọn hơn (vd 1-3 câu).
- Riêng với các tin PR, native ads (tin quảng cáo trá hình dưới dạng tin tức - thường gặp ở mục bất động sản/doanh nghiệp: bài giới thiệu/ca ngợi tiện ích, vị trí, ưu đãi mở bán của một dự án/sản phẩm/thương hiệu cụ thể mà không có góc nhìn phân tích hay phản biện khách quan, đọc như thông cáo báo chí của doanh nghiệp), không bỏ qua nhưng mở đầu đoạn tóm tắt bằng "(PR/Native Ads)" rồi tóm tắt sơ lược 1-2 câu. Không gắn tag này cho tin phân tích xu hướng, tin tức doanh nghiệp/kinh tế/công nghệ thông thường dù có nhắc tên công ty cụ thể - chỉ gắn khi tin đó chủ yếu quảng bá cho một dự án/sản phẩm/thương hiệu, không mang giá trị tin tức khách quan nào khác.
- Tiêu đề gốc trên Cafef/Vietstock hay giấu tên cụ thể (vd "một cổ phiếu", "một ngân hàng", "2 thay đổi"). Phần "Nội dung" bên dưới mỗi tin là trích đoạn bài viết gốc - BẮT BUỘC đọc kỹ và nêu rõ tên/mã cụ thể (mã cổ phiếu, tên công ty/ngân hàng, con số, chính sách...) nếu trích đoạn có đề cập, tuyệt đối không lặp lại cách nói chung chung của tiêu đề khi thông tin cụ thể đã có sẵn.
- Không viết các câu nhận xét sáo rỗng, chung chung, ai cũng tự suy ra được và không bổ sung thông tin mới (vd "đây là động thái đáng chú ý", "ảnh hưởng đến nhà đầu tư", "là thông tin quan trọng với thị trường"). Mỗi câu trong tóm tắt phải mang một dữ kiện/số liệu/sự kiện cụ thể.
- CHỈ trả về đoạn văn tóm tắt của từng tin - không lặp lại tiêu đề, không thêm gạch đầu dòng, không thêm link, không thêm lời dẫn/lời kết/ghi chú nào khác, tuyệt đối không nhắc lại hay diễn giải lại các tiêu chí/yêu cầu ở trên dưới bất kỳ hình thức nào.
- Mỗi đoạn tóm tắt BẮT BUỘC bắt đầu bằng đúng số thứ tự của tin đó trong danh sách dưới đây theo định dạng "N)" (vd tin thứ 3 bắt đầu bằng "3)"), ngay sau đó mới đến nội dung tóm tắt - dùng để đối chiếu đúng tin, không được bỏ qua hay đánh sai số.
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
const MAX_RETRIES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A chunk that succeeds on the first try needs none of this - retries only
// kick in once summarizeChunkOnce actually fails (rate limit, timeout,
// occasional mismatched delimiter count). Promise.all fires every chunk/group
// at once, so a single dropped request shouldn't permanently demote a whole
// mục to the non-AI fallback.
// Strips the mandatory "N)" index prefix the prompt requires on every item,
// but only if it matches this item's actual position - a plain item-count
// check can't catch a model that inserts a stray preamble/meta-commentary
// sentence (e.g. restating the instructions) ahead of an item's real
// summary, since the @@@-delimiter count still comes out right even though
// that one item's content is now garbled and misattributed. Requiring - and
// verifying - a sequential index turns that into a detectable failure
// instead of silently shipping the wrong text under the right title.
function stripIndexPrefix(part: string, expectedIndex: number): string | null {
  const match = part.match(new RegExp(`^\\s*${expectedIndex}[).]\\s*`));
  if (!match) return null;
  return part.slice(match[0].length).trim();
}

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
    const rawParts = raw
      .split(ITEM_DELIMITER)
      .map((part) => part.trim())
      .filter(Boolean);

    if (rawParts.length !== chunk.length) {
      console.error('qwen summary count mismatch', {
        source: group.source,
        category: group.category,
        expected: chunk.length,
        got: rawParts.length,
      });
      return null;
    }

    const parts: string[] = [];
    for (let index = 0; index < rawParts.length; index++) {
      const stripped = stripIndexPrefix(rawParts[index], index + 1);
      if (stripped === null) {
        console.error('qwen summary missing/mismatched index prefix', {
          source: group.source,
          category: group.category,
          expectedIndex: index + 1,
          gotPreview: rawParts[index].slice(0, 100),
        });
        return null;
      }
      parts.push(normalizeSummaryPunctuation(stripped));
    }

    return parts;
  } catch (error) {
    console.error('qwen chunk error', group.source, group.category, error);
    return null;
  }
}

// Returns exactly `chunk.length` summaries, aligned 1:1 with `chunk`. Falls
// back to a non-AI summary for the whole chunk only after MAX_RETRIES extra
// attempts still can't get a clean response - safer than risking a
// misaligned summary getting attributed to the wrong article.
async function summarizeChunk(
  apiKey: string,
  group: { source: string; category: string },
  chunk: NewsItem[],
  chunkIndex: number,
  chunkCount: number,
  hours: number
): Promise<{ summaries: string[]; usedFallback: boolean }> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS);

    const result = await summarizeChunkOnce(apiKey, group, chunk, chunkIndex, chunkCount, hours);
    if (result) return { summaries: result, usedFallback: false };
  }

  console.error('qwen chunk failed after', MAX_RETRIES, 'retries, using fallback', group.source, group.category);
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
    generatedAt: new Date().toISOString(),
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
      generatedAt: new Date().toISOString(),
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
