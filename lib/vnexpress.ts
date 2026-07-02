import axios from 'axios';
import * as cheerio from 'cheerio';
import type { NewsItem } from '@/lib/cafef';

export async function fetchVnexpressNews(): Promise<NewsItem[]> {
  try {
    const { data } = await axios.get('https://vnexpress.net/', {
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
      timeout: 30000,
    });

    const $ = cheerio.load(data);
    const items: NewsItem[] = [];
    const seen = new Set<string>();

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const title = $(el).text().trim();
      if (!href || !title || title.length > 120) return;

      const normalizedHref = href.startsWith('http') ? href : `https://vnexpress.net${href}`;
      if (!normalizedHref.includes('vnexpress.net')) return;
      if (seen.has(normalizedHref)) return;

      seen.add(normalizedHref);
      items.push({
        title,
        link: normalizedHref,
        description: '',
        source: 'Vnexpress',
        publishedAt: new Date().toISOString(),
      });
    });

    return items;
  } catch (error) {
    console.error('vnexpress fetch error', error);
    return [];
  }
}
