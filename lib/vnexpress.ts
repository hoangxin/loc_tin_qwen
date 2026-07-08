import axios from 'axios';
import * as cheerio from 'cheerio';
import Parser from 'rss-parser';
import type { NewsItem } from '@/lib/cafef';

// VnExpress mục pages render most of their list client-side (only ~1 item
// in ~58 carries a real timestamp in the static HTML), so scraping the
// category page like cafef.ts/vietstock.ts do won't give a reliable
// publishedAt to filter by. The public RSS feed has title/link/pubDate/lead
// for every item instead, so that's the source of truth here.
interface CategoryConfig {
  feedSlug: string;
  category: string;
  // Mục "diễn giải" (Thời sự, Thế giới, Khoa học công nghệ, Sức khỏe, Thể
  // thao) go through Qwen like CafeF/Vietstock; the rest just list title +
  // VnExpress's own RSS lead paragraph - see isVnexpressRawCategory in
  // lib/digest.ts, which reads this same category name.
  aiSummarize: boolean;
}

const CATEGORY_SOURCES: CategoryConfig[] = [
  { feedSlug: 'thoi-su', category: 'Thời sự', aiSummarize: true },
  { feedSlug: 'the-gioi', category: 'Thế giới', aiSummarize: true },
  { feedSlug: 'kinh-doanh', category: 'Kinh doanh', aiSummarize: false },
  { feedSlug: 'khoa-hoc-cong-nghe', category: 'Khoa học công nghệ', aiSummarize: true },
  { feedSlug: 'bat-dong-san', category: 'Bất động sản', aiSummarize: false },
  { feedSlug: 'giai-tri', category: 'Giải trí', aiSummarize: false },
  { feedSlug: 'phap-luat', category: 'Pháp luật', aiSummarize: false },
  { feedSlug: 'du-lich', category: 'Du lịch', aiSummarize: false },
  { feedSlug: 'suc-khoe', category: 'Sức khỏe', aiSummarize: true },
  { feedSlug: 'the-thao', category: 'Thể thao', aiSummarize: true },
  { feedSlug: 'doi-song', category: 'Đời sống', aiSummarize: false },
];

const REQUEST_TIMEOUT_MS = 30000;
const REQUEST_HEADERS = { 'User-Agent': 'Mozilla/5.0' };
const ARTICLE_BODY_SELECTOR = '.fck_detail';
// Only the AI-summarized mục need the full article body (to match CafeF's
// requirement of surfacing specific names/numbers a vague title hides) - the
// non-AI mục show the RSS lead as-is, so there's nothing to fetch for them.
// Lower than cafef.ts/vietstock.ts's 8 - VnExpress started returning 429s at
// that concurrency during testing.
const ARTICLE_FETCH_CONCURRENCY = 4;

const parser = new Parser();

type FeedItem = { title?: string; link?: string; pubDate?: string; contentSnippet?: string };

async function fetchArticleExcerpt(link: string): Promise<string> {
  try {
    const { data } = await axios.get<string>(link, {
      headers: REQUEST_HEADERS,
      timeout: REQUEST_TIMEOUT_MS,
    });
    const $ = cheerio.load(data);
    const paragraphs = $(`${ARTICLE_BODY_SELECTOR} p`)
      .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter(Boolean);

    return paragraphs.join(' ');
  } catch (error) {
    console.error('vnexpress article body error', link, error);
    return '';
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchCategoryFeed(config: CategoryConfig, cutoff: number): Promise<NewsItem[]> {
  try {
    const feed = await parser.parseURL(`https://vnexpress.net/rss/${config.feedSlug}.rss`);

    return feed.items.flatMap((entry: FeedItem) => {
      if (!entry.link || !entry.title || !entry.pubDate) return [];
      const publishedAt = new Date(entry.pubDate);
      if (Number.isNaN(publishedAt.getTime()) || publishedAt.getTime() < cutoff) return [];

      return [
        {
          title: entry.title,
          link: entry.link,
          description: '',
          intro: (entry.contentSnippet || '').trim(),
          source: 'Vnexpress',
          publishedAt: publishedAt.toISOString(),
          pubDate: publishedAt.toISOString(),
          category: config.category,
        },
      ];
    });
  } catch (error) {
    console.error('vnexpress feed error', config.feedSlug, error);
    return [];
  }
}

export async function fetchVnexpressNews(hours = 24, categories?: string[]): Promise<NewsItem[]> {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const sources = categories?.length
    ? CATEGORY_SOURCES.filter((source) => categories.includes(source.category))
    : CATEGORY_SOURCES;

  const results = await Promise.allSettled(sources.map((config) => fetchCategoryFeed(config, cutoff)));

  const items = results.flatMap((result) => {
    if (result.status === 'fulfilled') return result.value;
    console.error('vnexpress crawl error', result.reason);
    return [];
  });

  const aiItemIndexes = items.reduce<number[]>((indexes, item, index) => {
    const config = CATEGORY_SOURCES.find((source) => source.category === item.category);
    if (config?.aiSummarize) indexes.push(index);
    return indexes;
  }, []);

  const excerpts = await mapWithConcurrency(aiItemIndexes, ARTICLE_FETCH_CONCURRENCY, (index) =>
    fetchArticleExcerpt(items[index].link)
  );
  aiItemIndexes.forEach((itemIndex, resultIndex) => {
    items[itemIndex].description = excerpts[resultIndex];
  });

  return items;
}
