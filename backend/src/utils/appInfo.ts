import { readJson } from './fs.js';
import { CONFIG } from './config.js';

export type AppInfo = {
  name: string;
  version: string;
};

const DEFAULT_INFO: AppInfo = { name: 'TLEbot1', version: '1.0.0' };
const APP_INFO_PATH = (CONFIG as any).appInfoPath;

export async function getAppInfo(): Promise<AppInfo> {
  try {
    const data = await readJson<AppInfo>(APP_INFO_PATH, DEFAULT_INFO);
    const name = (data?.name && String(data.name)) || DEFAULT_INFO.name;
    const version = (data?.version && String(data.version)) || DEFAULT_INFO.version;
    return { name, version };
  } catch {
    return DEFAULT_INFO;
  }
}


