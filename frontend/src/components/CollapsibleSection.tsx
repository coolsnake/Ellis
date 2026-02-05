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
    <section className={`bg-gray-800 border border-gray-700 rounded-lg overflow-hidden ${className}`}>
      <div
        className="px-4 py-3 border-b border-gray-700 flex items-center justify-between bg-gray-800/80 cursor-pointer hover:bg-gray-750 transition-colors"
        onClick={toggle}
      >
        <div className="flex items-center gap-3">
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform ${collapsed ? '' : 'rotate-180'}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
          <h2 className="text-lg font-semibold text-white">{title}</h2>
        </div>
        {!collapsed && rightActions ? (
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            {rightActions}
          </div>
        ) : null}
      </div>
      {!collapsed && (
        <div className="p-4">
          {children}
        </div>
      )}
    </section>
  );
};
