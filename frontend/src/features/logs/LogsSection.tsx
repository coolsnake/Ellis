import React, { useEffect } from 'react';
import { LogWindow } from '../../components/LogWindow';
import { LOG_WINDOWS } from '../../utils/logs';
import { useLogs } from '../../app/contexts/logs';

export const LogsSection: React.FC = () => {
  const { logsByWindow, setLogsByWindow } = useLogs();

  useEffect(() => {
    const onClear = (e: any) => {
      try {
        const id = e && e.detail && e.detail.id;
        if (!id) return;
        setLogsByWindow((prev) => ({ ...(prev as any), [id]: [] }) as any);
      } catch {}
    };
    try { window.addEventListener('logwin:clear', onClear as any); } catch {}
    return () => { try { window.removeEventListener('logwin:clear', onClear as any); } catch {} };
  }, [setLogsByWindow]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {LOG_WINDOWS.map(({ id, title }) => (
        <LogWindow key={id} id={id} title={title} logs={(logsByWindow as any)[id] || []} />
      ))}
    </div>
  );
};


