import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * 二进制对象存储。开发环境落本地磁盘；生产可替换为 S3/MinIO 实现（同一接口）。
 */
export interface BlobStore {
  put(data: Buffer, prefix?: string): Promise<string>;
  get(key: string): Promise<Buffer>;
  /** 本地实现返回磁盘路径；S3 实现需先下载到本地缓存 */
  localPath(key: string): Promise<string>;
  remove(key: string): Promise<void>;
}

class LocalBlobStore implements BlobStore {
  constructor(private root: string) {}

  private resolve(key: string) {
    if (!/^[a-z0-9/_-]+(\.[a-z0-9]+)?$/i.test(key) || key.includes('..')) throw new Error(`bad blob key ${key}`);
    return path.join(this.root, key);
  }

  async put(data: Buffer, prefix = 'files'): Promise<string> {
    const key = `${prefix}/${crypto.randomUUID()}`;
    const p = this.resolve(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data);
    return key;
  }

  get(key: string) {
    return fs.readFile(this.resolve(key));
  }

  async localPath(key: string) {
    return this.resolve(key);
  }

  async remove(key: string) {
    await fs.unlink(this.resolve(key)).catch(() => {});
  }
}

export const blobStore: BlobStore = new LocalBlobStore(path.join(config.dataDir, 'blobs'));
