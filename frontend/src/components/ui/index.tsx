import React from 'react';

/* ─────────────────────────────────────────────────────────────────────────────
 * StatCard - Display a key metric with label, value, and optional sub-value
 * ───────────────────────────────────────────────────────────────────────────── */
export const StatCard: React.FC<{
  label: string;
  value: React.ReactNode;
  subValue?: React.ReactNode;
  trend?: 'up' | 'down' | 'neutral';
  className?: string;
}> = ({ label, value, subValue, trend, className = '' }) => (
  <div className={`bg-gray-700/50 border border-gray-600/50 rounded-lg p-3 flex flex-col justify-between ${className}`}>
    <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">{label}</span>
    <div className="mt-1 flex items-baseline gap-2">
      <span className="text-xl font-bold text-white font-mono tracking-tight">{value}</span>
      {trend && (
        <span className={`text-xs ${trend === 'up' ? 'text-green-400' : trend === 'down' ? 'text-red-400' : 'text-gray-400'}`}>
          {trend === 'up' ? '↑' : trend === 'down' ? '↓' : '–'}
        </span>
      )}
    </div>
    {subValue && <div className="text-xs text-gray-500 mt-1">{subValue}</div>}
  </div>
);

/* ─────────────────────────────────────────────────────────────────────────────
 * Panel - Unified card container with header and body
 * ───────────────────────────────────────────────────────────────────────────── */
export const Panel: React.FC<{
  title: React.ReactNode;
  actions?: React.ReactNode;
  badges?: React.ReactNode;
  children: React.ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  className?: string;
  bodyClassName?: string;
}> = ({ title, actions, badges, children, collapsible = false, defaultCollapsed = false, className = '', bodyClassName = '' }) => {
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed);

  return (
    <div className={`bg-gray-800 border border-gray-700 rounded-lg overflow-hidden shadow-sm ${className}`}>
      {/* Header */}
      <div
        className={`px-4 py-3 border-b border-gray-700 flex items-center justify-between bg-gray-800/80 ${collapsible ? 'cursor-pointer hover:bg-gray-750 transition-colors' : ''}`}
        onClick={collapsible ? () => setCollapsed(!collapsed) : undefined}
      >
        <div className="flex items-center gap-3">
          {collapsible && (
            <svg
              className={`w-4 h-4 text-gray-400 transition-transform ${collapsed ? '' : 'rotate-180'}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          )}
          <h3 className="font-semibold text-white tracking-wide">{title}</h3>
          {badges && <div className="flex items-center gap-2">{badges}</div>}
        </div>
        {actions && (
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            {actions}
          </div>
        )}
      </div>

      {/* Body */}
      {!collapsed && <div className={`p-4 ${bodyClassName}`}>{children}</div>}
    </div>
  );
};

/* ─────────────────────────────────────────────────────────────────────────────
 * StatusBadge - Small indicator badge for status display
 * ───────────────────────────────────────────────────────────────────────────── */
export const StatusBadge: React.FC<{
  status: 'ok' | 'error' | 'warning' | 'neutral' | 'active' | 'inactive';
  label: string;
  dotOnly?: boolean;
  className?: string;
  title?: string;
}> = ({ status, label, dotOnly = false, className = '', title }) => {
  const colors = {
    ok: 'bg-green-500',
    active: 'bg-green-500',
    error: 'bg-red-500',
    warning: 'bg-yellow-500',
    neutral: 'bg-gray-500',
    inactive: 'bg-gray-500',
  };

  const glowColors = {
    ok: 'shadow-[0_0_8px_rgba(34,197,94,0.4)]',
    active: 'shadow-[0_0_8px_rgba(34,197,94,0.4)]',
    error: 'shadow-[0_0_8px_rgba(239,68,68,0.4)]',
    warning: 'shadow-[0_0_8px_rgba(234,179,8,0.4)]',
    neutral: '',
    inactive: '',
  };

  if (dotOnly) {
    return (
      <span
        className={`w-2 h-2 rounded-full ${colors[status]} ${glowColors[status]} ${className}`}
        title={title || label}
      />
    );
  }

  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1 bg-gray-900/50 rounded-full border border-gray-700 ${className}`}
      title={title}
    >
      <span className={`w-2 h-2 rounded-full ${colors[status]} ${glowColors[status]}`} />
      <span className="text-xs font-medium text-gray-300">{label}</span>
    </div>
  );
};

/* ─────────────────────────────────────────────────────────────────────────────
 * Button - Consistent button styling
 * ───────────────────────────────────────────────────────────────────────────── */
export const Button: React.FC<{
  variant?: 'primary' | 'secondary' | 'success' | 'danger' | 'warning' | 'ghost';
  size?: 'xs' | 'sm' | 'md';
  children: React.ReactNode;
  disabled?: boolean;
  className?: string;
  onClick?: (e?: React.MouseEvent<HTMLButtonElement>) => void;
  title?: string;
  type?: 'button' | 'submit' | 'reset';
}> = ({ variant = 'secondary', size = 'sm', children, disabled, className = '', onClick, title, type = 'button' }) => {
  const baseStyles = 'rounded font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900';

  const sizeStyles = {
    xs: 'px-2 py-0.5 text-xs',
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-sm',
  };

  const variantStyles = {
    primary: 'bg-blue-600 hover:bg-blue-700 text-white focus:ring-blue-500 disabled:bg-blue-600/50',
    secondary: 'bg-gray-700 hover:bg-gray-600 text-white border border-gray-600 focus:ring-gray-500 disabled:bg-gray-700/50',
    success: 'bg-green-600/20 hover:bg-green-600/30 text-green-400 border border-green-600/50 focus:ring-green-500',
    danger: 'bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-600/50 focus:ring-red-500',
    warning: 'bg-yellow-600/20 hover:bg-yellow-600/30 text-yellow-400 border border-yellow-600/50 focus:ring-yellow-500',
    ghost: 'hover:bg-gray-700 text-gray-400 hover:text-white focus:ring-gray-500',
  };

  return (
    <button
      type={type}
      className={`${baseStyles} ${sizeStyles[size]} ${variantStyles[variant]} ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${className}`}
      disabled={disabled}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
};

/* ─────────────────────────────────────────────────────────────────────────────
 * DataTable - Styled table wrapper with consistent design
 * ───────────────────────────────────────────────────────────────────────────── */
export const DataTable: React.FC<{
  headers: React.ReactNode[];
  children: React.ReactNode;
  className?: string;
  compact?: boolean;
}> = ({ headers, children, className = '', compact = false }) => (
  <div className={`overflow-auto ${className}`}>
    <table className="w-full text-sm text-left">
      <thead>
        <tr className="text-xs text-gray-400 uppercase border-b border-gray-700">
          {headers.map((header, i) => (
            <th key={i} className={`${compact ? 'px-2 py-2' : 'px-4 py-3'} font-medium`}>
              {header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-700/50">{children}</tbody>
    </table>
  </div>
);

export const DataTableRow: React.FC<{
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
}> = ({ children, className = '', onClick }) => (
  <tr
    className={`hover:bg-gray-700/40 transition-colors ${onClick ? 'cursor-pointer' : ''} ${className}`}
    onClick={onClick}
  >
    {children}
  </tr>
);

export const DataTableCell: React.FC<{
  children: React.ReactNode;
  className?: string;
  compact?: boolean;
  mono?: boolean;
}> = ({ children, className = '', compact = false, mono = false }) => (
  <td className={`${compact ? 'px-2 py-2' : 'px-4 py-3'} ${mono ? 'font-mono' : ''} text-gray-300 ${className}`}>
    {children}
  </td>
);

/* ─────────────────────────────────────────────────────────────────────────────
 * InputGroup - Styled input with label
 * ───────────────────────────────────────────────────────────────────────────── */
export const InputGroup: React.FC<{
  label: string;
  children: React.ReactNode;
  className?: string;
}> = ({ label, children, className = '' }) => (
  <div className={`bg-gray-900/30 p-3 rounded-lg border border-gray-700/50 ${className}`}>
    <label className="text-xs font-medium text-gray-400 mb-2 block uppercase tracking-wider">{label}</label>
    {children}
  </div>
);

export const Input: React.FC<
  React.InputHTMLAttributes<HTMLInputElement> & { inputClassName?: string }
> = ({ className = '', inputClassName = '', ...props }) => (
  <input
    className={`bg-gray-800 border border-gray-600 text-white text-sm rounded px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all ${inputClassName} ${className}`}
    {...props}
  />
);

export const Select: React.FC<
  React.SelectHTMLAttributes<HTMLSelectElement> & { selectClassName?: string }
> = ({ className = '', selectClassName = '', children, ...props }) => (
  <select
    className={`bg-gray-800 border border-gray-600 text-white text-sm rounded px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all ${selectClassName} ${className}`}
    {...props}
  >
    {children}
  </select>
);

/* ─────────────────────────────────────────────────────────────────────────────
 * EmptyState - Placeholder for empty lists/tables
 * ───────────────────────────────────────────────────────────────────────────── */
export const EmptyState: React.FC<{
  message: string;
  className?: string;
}> = ({ message, className = '' }) => (
  <div className={`text-center py-8 text-gray-500 ${className}`}>{message}</div>
);
