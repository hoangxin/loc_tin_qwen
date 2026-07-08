// Throwaway experiment: same summarization task as lib/qwen.ts, but asks for
// a JSON object instead of the "N) title|||summary\n@@@" delimiter format,
// to see if structured output survives Mistral's format-compliance issues
// at CHUNK_SIZE=15 (see scripts/test-mistral.ts findings). Fully self-
// contained - does NOT touch lib/qwen.ts, so Qwen's pipeline is untouched
// until/unless this proves out. Not meant to be committed.
import { fetchCafeFNews, type NewsItem } from '../lib/cafef';

const CHUNK_SIZE = 15;
const MAX_TOKENS = 24576;
const RETRY_DELAY_MS = 1500;
const MAX_RETRIES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fallbackSummary(item: NewsItem): string {
  return item.description ? item.description.slice(0, 300) : item.title;
}

function capitalizeFirst(text: string): string {
  return text.charAt(0).toLocaleUpperCase('vi-VN') + text.slice(1);
}

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

function buildJsonPrompt(
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
- Viết mỗi ý/dữ kiện thành một câu riêng, kết thúc bằng dấu chấm. TUYỆT ĐỐI KHÔNG nối nhiều câu/mệnh đề lại với nhau bằng dấu chấm phẩy ";" thành một câu dài.
- Với các tin càng quan trọng thì tóm tắt càng gần mức tối đa 5 câu, tin ít quan trọng thì tóm tắt ngắn gọn hơn (vd 1-3 câu).
- Riêng với các tin PR, native ads (tin quảng cáo trá hình dưới dạng tin tức), không bỏ qua nhưng mở đầu đoạn tóm tắt bằng "(PR/Native Ads)" rồi tóm tắt sơ lược 1-2 câu.
- Tiêu đề gốc hay giấu tên cụ thể (vd "một cổ phiếu", "một ngân hàng"). Phần "Nội dung" bên dưới mỗi tin là trích đoạn bài viết gốc - BẮT BUỘC đọc kỹ và nêu rõ tên/mã cụ thể nếu trích đoạn có đề cập.
- Không viết các câu nhận xét sáo rỗng, chung chung, không bổ sung thông tin mới.
- BẮT BUỘC trả lời bằng đúng một JSON object, không thêm bất kỳ text/markdown/code fence nào khác trước hoặc sau JSON đó. JSON object có field "items" là một mảng, mỗi phần tử là 1 object gồm:
  + "index": số thứ tự của tin đó trong danh sách dưới đây (bắt đầu từ 1, đúng theo thứ tự liệt kê).
  + "title": nếu tiêu đề gốc đã đủ ngắn gọn rõ nghĩa thì chép lại y nguyên; nếu quá dài/mập mờ thì viết tiêu đề mới ngắn gọn hơn, có chứa từ khóa cụ thể lấy từ nội dung tóm tắt.
  + "summary": đoạn văn tóm tắt thực sự, không lặp lại tiêu đề, không thêm gạch đầu dòng/link/lời dẫn. Nếu tin thuộc diện PR/Native Ads, chữ "(PR/Native Ads)" PHẢI nằm ở đầu chuỗi text của field "summary" này - tuyệt đối không được tạo thêm field JSON mới tên "(PR/Native Ads)" hay bất kỳ tên nào khác ngoài đúng 3 field index/title/summary.
- Mảng "items" phải có đúng ${chunk.length} phần tử, index chạy từ 1 đến ${chunk.length} không thiếu không lặp. Mỗi object CHỈ được có đúng 3 field: index, title, summary - không thêm field nào khác.

Chunk ${chunkIndex + 1}/${chunkCount} của mục này.

Danh sách tin cần xử lý:
${chunk
  .map((item, index) => `${index + 1}. ${item.title}${item.description ? `\n   Nội dung: ${item.description}` : ''}`)
  .join('\n')}`;
}

const usageTotals = { prompt: 0, completion: 0, total: 0, calls: 0 };

async function callMistralJson(apiKey: string, prompt: string): Promise<string> {
  const response = await fetch(`${process.env.QWEN_BASE_URL || 'https://openrouter.ai/api/v1'}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.QWEN_MODEL || 'qwen/qwen-plus',
      max_tokens: MAX_TOKENS,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || 'request failed');
  }
  if (data?.usage) {
    usageTotals.prompt += data.usage.prompt_tokens || 0;
    usageTotals.completion += data.usage.completion_tokens || 0;
    usageTotals.total += data.usage.total_tokens || 0;
    usageTotals.calls += 1;
  }
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('empty content');
  return text;
}

interface ParsedItem {
  displayTitle: string;
  summary: string;
}

function parseJsonResponse(raw: string, expectedCount: number): ParsedItem[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('json parse failed', raw.slice(0, 200));
    return null;
  }

  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.length !== expectedCount) {
    console.error('json item count mismatch', { expected: expectedCount, got: Array.isArray(items) ? items.length : typeof items });
    return null;
  }

  const result: ParsedItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i] as { index?: number; title?: string; summary?: string };
    if (entry?.index !== i + 1 || !entry.title || !entry.summary) {
      console.error('json entry invalid', { expectedIndex: i + 1, entry });
      return null;
    }
    result.push({ displayTitle: entry.title, summary: normalizeSummaryPunctuation(entry.summary) });
  }
  return result;
}

async function summarizeChunk(
  apiKey: string,
  group: { source: string; category: string },
  chunk: NewsItem[],
  chunkIndex: number,
  chunkCount: number,
  hours: number
): Promise<{ items: ParsedItem[]; usedFallback: boolean }> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS);
    try {
      const raw = await callMistralJson(apiKey, buildJsonPrompt(group, chunk, chunkIndex, chunkCount, hours));
      const result = parseJsonResponse(raw, chunk.length);
      if (result) return { items: result, usedFallback: false };
    } catch (error) {
      console.error('chunk error', error);
    }
  }
  console.error('chunk failed after retries, using fallback');
  return { items: chunk.map((item) => ({ displayTitle: item.title, summary: fallbackSummary(item) })), usedFallback: true };
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY!;
  const hours = 24;
  const fetchStart = Date.now();
  const news = await fetchCafeFNews(hours, ['Tài chính quốc tế']);
  const fetchMs = Date.now() - fetchStart;
  console.error(`Fetched ${news.length} items in ${fetchMs}ms`);

  const group = { source: 'CafeF', category: 'Tài chính quốc tế' };
  const chunks: NewsItem[][] = [];
  for (let i = 0; i < news.length; i += CHUNK_SIZE) chunks.push(news.slice(i, i + CHUNK_SIZE));

  const summarizeStart = Date.now();
  const results = await Promise.all(chunks.map((chunk, idx) => summarizeChunk(apiKey, group, chunk, idx, chunks.length, hours)));
  const summarizeMs = Date.now() - summarizeStart;

  const successCount = results.reduce((sum, r) => sum + (r.usedFallback ? 0 : r.items.length), 0);
  console.error(`Success: ${successCount}/${news.length}`);
  console.error(`Summarize time: ${summarizeMs}ms across ${chunks.length} chunks`);
  console.error(`Token usage (successful calls only): ${JSON.stringify(usageTotals)}`);

  const flat = results.flatMap((r, idx) =>
    chunks[idx].map((item, i) => ({
      title: item.title,
      displayTitle: r.items[i].displayTitle !== item.title ? r.items[i].displayTitle : undefined,
      link: item.link,
      publishedAt: item.publishedAt,
      summary: r.items[i].summary,
      usedFallback: r.usedFallback,
    }))
  );

  console.log(JSON.stringify(flat, null, 2));
}

main().catch((error) => {
  console.error('failed', error);
  process.exitCode = 1;
});
