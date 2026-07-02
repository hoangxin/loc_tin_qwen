import { fetchCafeFNews } from '@/lib/cafef';
import { fetchVietstockNews } from '@/lib/vietstock';
// import { fetchVnexpressNews } from '@/lib/vnexpress'; // tạm thời bỏ vnexpress
import { summarizeWithQwen, type DigestGroup } from '@/lib/qwen';

export interface Digest {
  generatedAt: string;
  count: number;
  groups: DigestGroup[];
}

export async function buildDigest(): Promise<Digest> {
  const [cafeF, vietstock] = await Promise.all([
    fetchCafeFNews(),
    fetchVietstockNews(),
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

  const groups = allNews.length ? await summarizeWithQwen(allNews) : [];

  return { generatedAt: new Date().toISOString(), count: allNews.length, groups };
}
