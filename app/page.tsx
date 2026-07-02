import digest from '@/data/latest-digest.json';
import type { Digest } from '@/lib/digest';
import { formatTimestamp } from '@/lib/format';
import NewsExplorer from './NewsExplorer';
import TriggerDigestButton from './TriggerDigestButton';

const data = digest as Digest;

export default function HomePage() {
  return (
    <main className="page">
      <header className="site-header">
        <h1>Lọc Tin</h1>
        <div className="site-header-right">
          <span className="updated-at">
            {data.generatedAt ? `Cập nhật lúc ${formatTimestamp(data.generatedAt)}` : 'Chưa có dữ liệu'}
          </span>
          <TriggerDigestButton />
        </div>
      </header>

      <NewsExplorer digest={data} />
    </main>
  );
}
