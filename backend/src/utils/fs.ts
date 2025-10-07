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


