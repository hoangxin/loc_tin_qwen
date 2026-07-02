'use client';

import { useState } from 'react';

type Status = 'idle' | 'asking' | 'loading' | 'done' | 'error';

const DEFAULT_HOURS = 24;

export default function TriggerDigestButton() {
  const [status, setStatus] = useState<Status>('idle');
  const [hours, setHours] = useState(String(DEFAULT_HOURS));
  const [message, setMessage] = useState('');

  async function runDigest() {
    const parsed = Number(hours);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setMessage('Số giờ không hợp lệ.');
      setStatus('error');
      return;
    }

    setStatus('loading');
    try {
      const response = await fetch('/api/trigger-digest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hours: parsed }),
      });
      const data = await response.json();

      if (!response.ok) {
        setMessage(data?.error || 'Có lỗi xảy ra.');
        setStatus('error');
        return;
      }

      setMessage(`Đã kích hoạt tổng hợp ${data.hours}h gần nhất. Chờ khoảng vài phút rồi tải lại trang.`);
      setStatus('done');
    } catch {
      setMessage('Không kết nối được tới server.');
      setStatus('error');
    }
  }

  if (status === 'idle') {
    return (
      <button className="trigger-button" onClick={() => setStatus('asking')}>
        Chạy tổng hợp
      </button>
    );
  }

  if (status === 'asking' || status === 'loading') {
    return (
      <div className="trigger-form">
        <label htmlFor="trigger-hours">Tổng hợp tin trong</label>
        <input
          id="trigger-hours"
          type="number"
          min={1}
          max={168}
          value={hours}
          disabled={status === 'loading'}
          onChange={(event) => setHours(event.target.value)}
        />
        <span>giờ gần nhất</span>
        <button className="trigger-button" disabled={status === 'loading'} onClick={runDigest}>
          {status === 'loading' ? 'Đang chạy...' : 'Chạy'}
        </button>
        <button
          className="trigger-button trigger-button-secondary"
          disabled={status === 'loading'}
          onClick={() => setStatus('idle')}
        >
          Huỷ
        </button>
      </div>
    );
  }

  return (
    <div className="trigger-form">
      <span className={status === 'error' ? 'trigger-message trigger-message-error' : 'trigger-message'}>
        {message}
      </span>
      <button className="trigger-button trigger-button-secondary" onClick={() => setStatus('idle')}>
        Đóng
      </button>
    </div>
  );
}
