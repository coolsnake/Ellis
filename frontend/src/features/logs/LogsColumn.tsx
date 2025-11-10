import React, { useEffect, useMemo } from 'react';
import { useLogs } from '../../app/contexts/logs';
import { LOG_WINDOWS, WINDOW_ORDER, LogWindowConfig, WindowId } from '../../utils/logs';
import { LogWindow } from '../../components/LogWindow';
import { RpcMonitor } from '../../components/RpcMonitor';

type LogsColumnProps = {
  className?: string;
};

const configById: Record<WindowId, LogWindowConfig> = (() => {
  const map = Object.create(null) as Record<WindowId, LogWindowConfig>;
  for (const cfg of LOG_WINDOWS) {
    map[cfg.id] = cfg;
  }
  return map;
})();

const LogsColumnComponent: React.FC<LogsColumnProps> = ({ className = 'space-y-4' }) => {
  const { logsByWindow, setLogsByWindow } = useLogs();

  useEffect(() => {
    const onClear = (e: Event) => {
      const detail = (e as CustomEvent<{ id?: string }>).detail;
      const id = detail?.id as WindowId | undefined;
      if (!id) return;
      setLogsByWindow((prev) => ({ ...prev, [id]: [] }));
    };
    window.addEventListener('logwin:clear' as any, onClear as EventListener);
    return () => {
      window.removeEventListener('logwin:clear' as any, onClear as EventListener);
    };
  }, [setLogsByWindow]);

  const windows = useMemo(() => {
    return WINDOW_ORDER.map((id) => {
      const cfg = configById[id];
      return {
        id,
        title: `${cfg?.title ?? id} Log`,
        logs: logsByWindow[id] || [],
      };
    });
  }, [logsByWindow]);

  return (
    <div className={className}>
      {windows.map(({ id, title, logs }) => (
        <LogWindow key={id} id={id} title={title} logs={logs} />
      ))}
      {/* RPC Monitor placed after System log */}
      <RpcMonitor />
    </div>
  );
};

export const LogsColumn = React.memo(LogsColumnComponent);

export default LogsColumn;

