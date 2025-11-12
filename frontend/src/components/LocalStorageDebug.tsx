import React, { useState, useEffect } from 'react';

export const LocalStorageDebug: React.FC = () => {
  const [keys, setKeys] = useState<string[]>([]);
  const [testValue, setTestValue] = useState('');

  const loadKeys = () => {
    const allKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) allKeys.push(key);
    }
    setKeys(allKeys.sort());
  };

  useEffect(() => {
    loadKeys();
  }, []);

  const testWrite = () => {
    try {
      const testKey = 'test_' + Date.now();
      localStorage.setItem(testKey, 'test_value');
      alert('localStorage write successful!');
      loadKeys();
    } catch (err) {
      alert('localStorage write failed: ' + String(err));
    }
  };

  const clearModalConfigs = () => {
    const modalKeys = keys.filter(k => k.startsWith('modalConfig_'));
    modalKeys.forEach(k => localStorage.removeItem(k));
    alert(`Cleared ${modalKeys.length} modal config keys`);
    loadKeys();
  };

  return (
    <div className="p-4 bg-gray-900 border border-blue-500 rounded text-white">
      <h3 className="text-lg font-bold mb-2">localStorage Debug</h3>
      <div className="flex gap-2 mb-3">
        <button onClick={testWrite} className="px-3 py-1 bg-green-600 rounded text-sm">Test Write</button>
        <button onClick={loadKeys} className="px-3 py-1 bg-blue-600 rounded text-sm">Refresh</button>
        <button onClick={clearModalConfigs} className="px-3 py-1 bg-red-600 rounded text-sm">Clear Modal Configs</button>
      </div>
      <div className="text-xs">
        <div className="mb-2"><strong>Total keys: {keys.length}</strong></div>
        <div className="max-h-60 overflow-y-auto bg-gray-800 p-2 rounded">
          {keys.map(key => {
            const value = localStorage.getItem(key);
            const isModalConfig = key.startsWith('modalConfig_');
            return (
              <div key={key} className={`mb-1 ${isModalConfig ? 'text-yellow-300' : ''}`}>
                <strong>{key}:</strong> {value?.substring(0, 100)}{value && value.length > 100 ? '...' : ''}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

