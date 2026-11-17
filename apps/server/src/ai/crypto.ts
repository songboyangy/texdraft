import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * 用户 API Key 的加密存储：AES-256-GCM，密钥由 AI_KEYS_SECRET（默认 SESSION_SECRET）经 HKDF 派生。
 * 服务端密钥更换后旧密文无法解密，用户需要重新填写 Key。
 */
let key: Buffer | null = null;
// 'texpilot' 是改名前的产品名，作为密钥派生参数必须保持不变，否则已保存的 API Key 无法解密
const getKey = () => (key ??= Buffer.from(crypto.hkdfSync('sha256', config.ai.secret, 'texpilot', 'ai-api-keys-v1', 32)));

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join(':');
}

/** 解密失败（密钥已更换或数据被篡改）返回 null */
export function decryptSecret(stored: string): string | null {
  const [v, iv, tag, data] = stored.split(':');
  if (v !== 'v1' || !iv || !tag || !data) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
