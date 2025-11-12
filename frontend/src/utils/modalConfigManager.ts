/**
 * Utility functions for managing all modal configurations
 */

export interface AllModalConfigs {
  dataFetchConfig?: any;
  arbEngineConfig?: any;
  executionConfig?: any;
  altManagement?: any;
  graphView?: any;
  systemConfig?: any;
  opportunityConfig?: any;
  [key: string]: any;
}

// Sensitive keys that should never be exported/imported
const SENSITIVE_KEYS = [
  'authCreds',
  'password',
  'pass',
  'apiKey',
  'secret',
  'token',
  'privateKey',
  'keypath',
];

/**
 * Check if a localStorage key contains sensitive data
 */
const isSensitiveKey = (key: string): boolean => {
  const lowerKey = key.toLowerCase();
  return SENSITIVE_KEYS.some(sensitive => lowerKey.includes(sensitive.toLowerCase()));
};

/**
 * Export all modal configurations from localStorage (excluding sensitive data)
 */
export const exportAllModalConfigs = (): AllModalConfigs => {
  const configs: AllModalConfigs = {};
  
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('modalConfig_') && !isSensitiveKey(key)) {
      try {
        const value = localStorage.getItem(key);
        if (value) {
          const modalName = key.replace('modalConfig_', '');
          const parsed = JSON.parse(value);
          // Filter out sensitive fields from the parsed object
          configs[modalName] = filterSensitiveFields(parsed);
        }
      } catch (err) {
        console.warn(`Failed to export config for ${key}:`, err);
      }
    }
  }
  
  return configs;
};

/**
 * Recursively filter sensitive fields from an object
 */
const filterSensitiveFields = (obj: any): any => {
  if (!obj || typeof obj !== 'object') return obj;
  
  if (Array.isArray(obj)) {
    return obj.map(filterSensitiveFields);
  }
  
  const filtered: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!isSensitiveKey(key)) {
      filtered[key] = filterSensitiveFields(value);
    }
  }
  return filtered;
};

/**
 * Import modal configurations to localStorage
 */
export const importAllModalConfigs = (configs: AllModalConfigs): void => {
  Object.entries(configs).forEach(([modalName, config]) => {
    try {
      localStorage.setItem(`modalConfig_${modalName}`, JSON.stringify(config));
    } catch (err) {
      console.warn(`Failed to import config for ${modalName}:`, err);
    }
  });
};

/**
 * Clear all modal configurations from localStorage
 */
export const clearAllModalConfigs = (): void => {
  const keysToRemove: string[] = [];
  
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('modalConfig_')) {
      keysToRemove.push(key);
    }
  }
  
  keysToRemove.forEach(key => localStorage.removeItem(key));
};

/**
 * Download configurations as JSON file
 */
export const downloadModalConfigs = (): void => {
  const configs = exportAllModalConfigs();
  const blob = new Blob([JSON.stringify(configs, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lockstone-modal-configs-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
};

/**
 * Upload and import configurations from JSON file
 */
export const uploadModalConfigs = (file: File): Promise<void> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const configs = JSON.parse(event.target?.result as string);
        importAllModalConfigs(configs);
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
};

