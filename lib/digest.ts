import { fetchCafeFNews, type NewsItem } from '@/lib/cafef';
import { fetchVietstockNews } from '@/lib/vietstock';
import { fetchVnexpressNews } from '@/lib/vnexpress';
import { summarizeWithQwen, type DigestGroup, type DigestItem } from '@/lib/qwen';

export interface Digest {
  generatedAt: string;
  count: number;
  groups: DigestGroup[];
}

// Crime-blotter items in CafeF's "Xã hội" mục (arrests, manhunts,
// prosecutions) read as formulaic wire copy - summarizing them via Qwen
// burns tokens and risks the model inventing/misreading case details, so
// they're kept out of the AI pipeline entirely and shown as title + CafeF's
// own listing-page sapo instead.
const CRIME_KEYWORD_PATTERN =
  /truy nã|bị bắt|bắt giữ|bắt khẩn cấp|bắt quả tang|vây bắt|lệnh bắt|khởi tố|tạm giam|tạm giữ hình sự/i;

function isCrimeBlotterNews(item: NewsItem): boolean {
  return item.source === 'CafeF' && item.category === 'Xã hội' && CRIME_KEYWORD_PATTERN.test(item.title);
}

// VnExpress mục outside the 5 "diễn giải" ones just list title + the
// site's own RSS lead paragraph - see aiSummarize in lib/vnexpress.ts.
const VNEXPRESS_RAW_CATEGORIES = new Set(['Kinh doanh', 'Bất động sản', 'Giải trí', 'Pháp luật', 'Đời sống', 'Du lịch']);

function isVnexpressRawCategory(item: NewsItem): boolean {
  return item.source === 'Vnexpress' && VNEXPRESS_RAW_CATEGORIES.has(item.category || '');
}

function shouldSkipAiSummary(item: NewsItem): boolean {
  return isCrimeBlotterNews(item) || isVnexpressRawCategory(item);
}

function toRawDigestItem(item: NewsItem): DigestItem {
  const summary = item.intro || item.description?.slice(0, 300) || item.title;
  return { title: item.title, link: item.link, publishedAt: item.publishedAt, summary, usedFallback: false };
}

function groupRawItems(items: NewsItem[]): DigestGroup[] {
  const groups = new Map<string, DigestGroup>();

  for (const item of items) {
    const key = `${item.source}::${item.category}`;
    let group = groups.get(key);
    if (!group) {
      group = { source: item.source, category: item.category || 'Khác', generatedAt: new Date().toISOString(), items: [] };
      groups.set(key, group);
    }
    group.items.push(toRawDigestItem(item));
  }

  return [...groups.values()];
}

// Merges AI-summarized and raw-only groups that share the same mục (e.g.
// CafeF/Xã hội has both) back into one group, re-sorted chronologically -
// the AI and raw items were summarized via two separate calls/passes, so
// within a shared mục they'd otherwise show up as two disjoint blocks.
function mergeDigestGroups(...groupLists: DigestGroup[][]): DigestGroup[] {
  const merged = new Map<string, DigestGroup>();

  for (const groups of groupLists) {
    for (const group of groups) {
      const key = `${group.source}::${group.category}`;
      const existing = merged.get(key);
      if (existing) {
        existing.items.push(...group.items);
      } else {
        merged.set(key, { source: group.source, category: group.category, generatedAt: group.generatedAt, items: [...group.items] });
      }
    }
  }

  for (const group of merged.values()) {
    group.items.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  }

  return [...merged.values()];
}

// `source` scopes the run to a single tab's "Tổng hợp" button (e.g. only
// re-crawl CafeF); omitted, it fetches all three like the old full daily
// run. `categories` further narrows within that source - ignored when
// `source` isn't set, since there's no single category list to filter against.
export async function buildDigest(hours = 24, source?: string, categories?: string[]): Promise<Digest> {
  const wantsCafeF = !source || source === 'CafeF';
  const wantsVietstock = !source || source === 'Vietstock';
  const wantsVnexpress = !source || source === 'Vnexpress';

  const [cafeF, vietstock, vnexpress] = await Promise.all([
    wantsCafeF ? fetchCafeFNews(hours, source === 'CafeF' ? categories : undefined) : Promise.resolve([]),
    wantsVietstock ? fetchVietstockNews(hours, source === 'Vietstock' ? categories : undefined) : Promise.resolve([]),
    wantsVnexpress ? fetchVnexpressNews(hours, source === 'Vnexpress' ? categories : undefined) : Promise.resolve([]),
  ]);

  const allNews = [...cafeF, ...vietstock, ...vnexpress]
    .filter(Boolean)
    .map((item) => ({
      ...item,
      publishedAt: item.publishedAt || item.pubDate || new Date().toISOString(),
      pubDate: item.pubDate || item.publishedAt || new Date().toISOString(),
      category: item.category || item.source || 'Tin tức',
    }))
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  const newsToSummarize = allNews.filter((item) => !shouldSkipAiSummary(item));
  const rawNews = allNews.filter(shouldSkipAiSummary);

  const aiGroups = newsToSummarize.length ? await summarizeWithQwen(newsToSummarize, hours) : [];
  const rawGroups = groupRawItems(rawNews);
  const groups = mergeDigestGroups(aiGroups, rawGroups);

  return { generatedAt: new Date().toISOString(), count: allNews.length, groups };
}
