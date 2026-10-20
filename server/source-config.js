import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from './db.js';

export const SOURCE_FILE = path.resolve(process.env.DATA_SOURCE_FILE || path.join(path.dirname(DB_PATH), 'data-source.json'));
export const SOURCE_NAMES = ['local', 'ifind', 'tushare', 'mock'];
export function readSource() {
  if (fs.existsSync(SOURCE_FILE)) {
    const { source } = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'));
    if (!SOURCE_NAMES.includes(source)) throw new Error('保存的数据源配置无效');
    return source;
  }
  const source = process.env.DATA_SOURCE || 'mock';
  if (!SOURCE_NAMES.includes(source)) throw new Error(`未知 DATA_SOURCE: ${source}`);
  return source;
}
export function saveSource(source) {
  if (!['local', 'ifind'].includes(source)) throw new Error('可切换的数据源为 local / ifind');
  fs.mkdirSync(path.dirname(SOURCE_FILE), { recursive: true });
  fs.writeFileSync(`${SOURCE_FILE}.tmp`, JSON.stringify({ source }));
  fs.renameSync(`${SOURCE_FILE}.tmp`, SOURCE_FILE);
}
export const ifindConfigured = () => !!(process.env.IFIND_REFRESH_TOKEN || process.env.IFIND_ACCESS_TOKEN);
