import React, { useState, useEffect, useCallback } from 'react';
import {
  getNotificationStatus,
  getNotificationConfig,
  updateNotificationConfig,
  getRegisteredDevices,
  sendTestNotification,
  type NotificationStatus,
  type NotificationConfig as NotificationConfigType,
  type RegisteredDevice,
} from '../utils/api';

interface NotificationConfigProps {
  onClose: () => void;
}

export const NotificationConfig: React.FC<NotificationConfigProps> = ({ onClose }) => {
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [config, setConfig] = useState<NotificationConfigType | null>(null);
  const [devices, setDevices] = useState<RegisteredDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  // Local form state for thresholds
  const [thresholds, setThresholds] = useState({
    medium: 1,
    high: 10,
    critical: 100,
  });
  const [enabled, setEnabled] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusData, configData, devicesData] = await Promise.all([
        getNotificationStatus(),
        getNotificationConfig(),
        getRegisteredDevices(),
      ]);
      setStatus(statusData);
      setConfig(configData);
      setDevices(devicesData.devices || []);
      setEnabled(configData.enabled);
      setThresholds({
        medium: configData.profitThresholds.medium,
        high: configData.profitThresholds.high,
        critical: configData.profitThresholds.critical,
      });
    } catch (err: any) {
      setError(err?.message || 'Failed to load notification settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateNotificationConfig({
        enabled,
        profitThresholds: {
          low: 0,
          medium: thresholds.medium,
          high: thresholds.high,
          critical: thresholds.critical,
        },
      });
      setConfig(updated);
      setTestResult({ success: true, message: 'Configuration saved' });
      setTimeout(() => setTestResult(null), 3000);
    } catch (err: any) {
      setError(err?.message || 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await sendTestNotification();
      setTestResult(result);
    } catch (err: any) {
      setTestResult({ success: false, message: err?.message || 'Failed to send test' });
    } finally {
      setTesting(false);
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-white">Mobile Notifications</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-2xl leading-none"
          >
            ×
          </button>
        </div>

        {loading ? (
          <div className="text-center py-8">
            <div className="text-gray-400">Loading...</div>
          </div>
        ) : error ? (
          <div className="bg-red-900/30 border border-red-500 rounded-lg p-4 mb-4">
            <p className="text-red-400">{error}</p>
            <button
              onClick={fetchData}
              className="mt-2 text-sm text-red-300 hover:text-red-200 underline"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            {/* Status Section */}
            <div className="bg-gray-700 rounded-lg p-4 mb-4">
              <h3 className="text-lg font-semibold text-white mb-3">Status</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="flex items-center space-x-2">
                  <div
                    className={`w-3 h-3 rounded-full ${
                      status?.firebaseReady ? 'bg-green-500' : 'bg-red-500'
                    }`}
                  />
                  <span className="text-gray-300">
                    Firebase: {status?.firebaseReady ? 'Connected' : 'Not Configured'}
                  </span>
                </div>
                <div className="flex items-center space-x-2">
                  <div
                    className={`w-3 h-3 rounded-full ${
                      (status?.deviceCount || 0) > 0 ? 'bg-green-500' : 'bg-yellow-500'
                    }`}
                  />
                  <span className="text-gray-300">
                    Devices: {status?.deviceCount || 0} registered
                  </span>
                </div>
              </div>
              {!status?.firebaseReady && (
                <p className="text-yellow-400 text-sm mt-3">
                  ⚠️ Place firebase-admin.json in backend/config/ to enable push notifications
                </p>
              )}
            </div>

            {/* Enable Toggle */}
            <div className="bg-gray-700 rounded-lg p-4 mb-4">
              <label className="flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  className="w-5 h-5 rounded border-gray-500 bg-gray-600 text-blue-500 focus:ring-blue-500"
                />
                <span className="ml-3 text-white font-medium">
                  Enable Push Notifications
                </span>
              </label>
              <p className="text-gray-400 text-sm mt-2 ml-8">
                Send notifications to registered mobile devices when arbitrage transactions are confirmed
              </p>
            </div>

            {/* Profit Thresholds */}
            <div className="bg-gray-700 rounded-lg p-4 mb-4">
              <h3 className="text-lg font-semibold text-white mb-3">
                Profit Thresholds
              </h3>
              <p className="text-gray-400 text-sm mb-4">
                Configure profit levels that determine notification priority (LED color, vibration pattern)
              </p>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-green-400 mb-2">
                    🟢 Medium ($)
                  </label>
                  <input
                    type="number"
                    value={thresholds.medium}
                    onChange={(e) =>
                      setThresholds((prev) => ({
                        ...prev,
                        medium: Math.max(0, Number(e.target.value)),
                      }))
                    }
                    className="w-full px-3 py-2 bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-green-500"
                    min="0"
                    step="0.1"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-yellow-400 mb-2">
                    🟡 High ($)
                  </label>
                  <input
                    type="number"
                    value={thresholds.high}
                    onChange={(e) =>
                      setThresholds((prev) => ({
                        ...prev,
                        high: Math.max(0, Number(e.target.value)),
                      }))
                    }
                    className="w-full px-3 py-2 bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-yellow-500"
                    min="0"
                    step="1"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-red-400 mb-2">
                    🔴 Critical ($)
                  </label>
                  <input
                    type="number"
                    value={thresholds.critical}
                    onChange={(e) =>
                      setThresholds((prev) => ({
                        ...prev,
                        critical: Math.max(0, Number(e.target.value)),
                      }))
                    }
                    className="w-full px-3 py-2 bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-red-500"
                    min="0"
                    step="10"
                  />
                </div>
              </div>
              <p className="text-gray-500 text-xs mt-3">
                Below ${thresholds.medium}: Low priority (no LED) | ${thresholds.medium}-${thresholds.high}: Medium (green LED) | ${thresholds.high}-${thresholds.critical}: High (gold LED) | Above ${thresholds.critical}: Critical (red LED, urgent vibration)
              </p>
            </div>

            {/* Registered Devices */}
            <div className="bg-gray-700 rounded-lg p-4 mb-4">
              <h3 className="text-lg font-semibold text-white mb-3">
                Registered Devices
              </h3>
              {devices.length === 0 ? (
                <p className="text-gray-400 text-sm">
                  No devices registered. Install the Lockstone mobile app and log in to register a device.
                </p>
              ) : (
                <div className="space-y-2">
                  {devices.map((device, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between bg-gray-600 rounded-lg p-3"
                    >
                      <div className="flex items-center space-x-3">
                        <span className="text-2xl">📱</span>
                        <div>
                          <div className="text-white font-medium capitalize">
                            {device.platform}
                          </div>
                          <div className="text-gray-400 text-xs">
                            Registered: {formatDate(device.registeredAt)}
                            {device.lastUsed && ` • Last used: ${formatDate(device.lastUsed)}`}
                          </div>
                          <div className="text-gray-500 text-xs font-mono">
                            {device.tokenPrefix}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Test Result */}
            {testResult && (
              <div
                className={`rounded-lg p-3 mb-4 ${
                  testResult.success
                    ? 'bg-green-900/30 border border-green-500'
                    : 'bg-red-900/30 border border-red-500'
                }`}
              >
                <p className={testResult.success ? 'text-green-400' : 'text-red-400'}>
                  {testResult.message}
                </p>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex justify-between">
              <button
                onClick={handleTest}
                disabled={testing || !status?.firebaseReady || devices.length === 0}
                className={`px-4 py-2 rounded-md font-medium ${
                  testing || !status?.firebaseReady || devices.length === 0
                    ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                    : 'bg-purple-600 text-white hover:bg-purple-700'
                }`}
              >
                {testing ? 'Sending...' : 'Send Test Notification'}
              </button>
              <div className="flex space-x-3">
                <button
                  onClick={onClose}
                  className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className={`px-4 py-2 rounded-md font-medium ${
                    saving
                      ? 'bg-blue-800 text-gray-300 cursor-not-allowed'
                      : 'bg-blue-600 text-white hover:bg-blue-700'
                  }`}
                >
                  {saving ? 'Saving...' : 'Save Configuration'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
