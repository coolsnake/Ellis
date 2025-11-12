import { useEffect, useState } from 'react';

interface ModalConfig {
  [key: string]: any;
}

/**
 * Hook to persist modal UI configuration to localStorage
 * @param modalId Unique identifier for the modal
 * @param defaults Default configuration values
 * @returns [config, updateConfig, resetConfig]
 */
export function useModalConfig<T extends ModalConfig>(
  modalId: string,
  defaults: T
): [T, (updates: Partial<T>) => void, () => void] {
  const storageKey = `modalConfig_${modalId}`;
  
  // Initialize state from localStorage or defaults
  const [config, setConfig] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        return { ...defaults, ...parsed };
      }
    } catch (err) {
      console.warn(`Failed to load config for ${modalId}:`, err);
    }
    return defaults;
  });

  // Persist to localStorage whenever config changes
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(config));
    } catch (err) {
      console.warn(`Failed to save config for ${modalId}:`, err);
    }
  }, [config, storageKey]);

  // Update function (merges partial updates)
  const updateConfig = (updates: Partial<T>) => {
    setConfig((prev) => ({ ...prev, ...updates }));
  };

  // Reset function
  const resetConfig = () => {
    setConfig(defaults);
    try {
      localStorage.removeItem(storageKey);
    } catch {}
  };

  return [config, updateConfig, resetConfig];
}

