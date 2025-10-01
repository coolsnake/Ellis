import React, { useEffect, useState } from 'react';

export const CollapsibleSection: React.FC<{
  title: React.ReactNode;
  storageKey: string;
  rightActions?: React.ReactNode;
  defaultCollapsed?: boolean;
  className?: string;
  children: React.ReactNode;
}> = ({ title, storageKey, rightActions, defaultCollapsed = false, className = '', children }) => {
  const [collapsed, setCollapsed] = useState<boolean>(defaultCollapsed);

  useEffect(() => {
    try {
      const v = localStorage.getItem(storageKey);
      if (v === '1') setCollapsed(true);
      if (v === '0') setCollapsed(false);
    } catch {
      /* ignore */
    }
  }, [storageKey]);

  const toggle = () => {
    setCollapsed(prev => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  return (
    <section className={`bg-gray-900 rounded p-4 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={toggle}
            className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm"
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? '▸' : '▾'}
          </button>
          <h2 className="text-2xl font-semibold">{title}</h2>
        </div>
        {!collapsed && rightActions ? (
          <div className="flex items-center gap-2">
            {rightActions}
          </div>
        ) : null}
      </div>
      <div className={collapsed ? 'hidden' : ''}>
        {children}
      </div>
    </section>
  );
};
