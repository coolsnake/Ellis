import { promises as fs } from 'fs';
import path from 'path';

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (error: any) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return fallback;
    }
    // Handle corrupted/incomplete JSON (race condition during concurrent writes)
    if (error && error.message && error.message.includes('JSON')) {
      // Try one more time after a brief delay in case file write is completing
      await new Promise(resolve => setTimeout(resolve, 10));
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content) as T;
      } catch {
        // Still failed - return fallback rather than crashing
        return fallback;
      }
    }
    throw error;
  }
}

export async function writeJson(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export function joinPath(...parts: string[]): string {
  return path.resolve(...parts);
}

export async function deleteFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error: any) {
    if (error && error.code === 'ENOENT') {
      // File doesn't exist, ignore
      return;
    }
    throw error;
  }
}


