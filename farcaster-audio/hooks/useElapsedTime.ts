import { useEffect, useState } from 'react';

export function useElapsedTime(startedAt: string | null | undefined) {
  const [elapsed, setElapsed] = useState({ hours: 0, minutes: 0, seconds: 0 });

  useEffect(() => {
    if (!startedAt) return;

    const start = new Date(startedAt).getTime();

    const tick = () => {
      const diff = Math.max(0, Math.floor((Date.now() - start) / 1000));
      setElapsed({
        hours: Math.floor(diff / 3600),
        minutes: Math.floor((diff % 3600) / 60),
        seconds: diff % 60,
      });
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);

  const formatted = `${String(elapsed.hours).padStart(2, '0')}:${String(elapsed.minutes).padStart(2, '0')}:${String(elapsed.seconds).padStart(2, '0')}`;

  return { ...elapsed, formatted };
}
