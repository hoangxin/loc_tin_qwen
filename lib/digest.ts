import { fetchCafeFNews } from '@/lib/cafef';
import { fetchVietstockNews } from '@/lib/vietstock';
// import { fetchVnexpressNews } from '@/lib/vnexpress'; // tạm thời bỏ vnexpress
import { summarizeWithQwen, type DigestGroup } from '@/lib/qwen';

export interface Digest {
  generatedAt: string;
  count: number;
  groups: DigestGroup[];
}

// `source` scopes the run to a single tab's "Tổng hợp" button (e.g. only
// re-crawl CafeF); omitted, it fetches both like the old full daily run.
// `categories` further narrows within that source - ignored when `source`
// isn't set, since there's no single category list to filter against.
export async function buildDigest(hours = 24, source?: string, categories?: string[]): Promise<Digest> {
  const wantsCafeF = !source || source === 'CafeF';
  const wantsVietstock = !source || source === 'Vietstock';

  const [cafeF, vietstock] = await Promise.all([
    wantsCafeF ? fetchCafeFNews(hours, source === 'CafeF' ? categories : undefined) : Promise.resolve([]),
    wantsVietstock ? fetchVietstockNews(hours, source === 'Vietstock' ? categories : undefined) : Promise.resolve([]),
  ]);

  const allNews = [...cafeF, ...vietstock]
    .filter(Boolean)
    .map((item) => ({
      ...item,
      publishedAt: item.publishedAt || item.pubDate || new Date().toISOString(),
      pubDate: item.pubDate || item.publishedAt || new Date().toISOString(),
      category: item.category || item.source || 'Tin tức',
    }))
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  const groups = allNews.length ? await summarizeWithQwen(allNews, hours) : [];

  return { generatedAt: new Date().toISOString(), count: allNews.length, groups };
}
