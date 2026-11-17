import { config } from '../config.js';
import { HttpError } from './http.js';

/** Cloudflare Turnstile 人机验证：TURNSTILE_SITE_KEY 与 TURNSTILE_SECRET_KEY 都设置时启用 */
export const turnstileEnabled = () => !!(config.demo.turnstileSiteKey && config.demo.turnstileSecret);

export async function verifyTurnstile(token: string | undefined, ip: string, zh: boolean) {
  if (!turnstileEnabled()) return;
  const fail = () => new HttpError(400, zh ? '人机验证未通过，请刷新后重试' : 'Human verification failed. Please reload and try again.');
  if (!token) throw fail();
  let ok = false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: config.demo.turnstileSecret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(10_000),
    });
    ok = ((await r.json()) as { success?: boolean }).success === true;
  } catch (e) {
    console.error('[turnstile] verify failed', e);
    throw new HttpError(503, zh ? '暂时无法完成人机验证，请稍后再试' : 'Human verification is unavailable right now. Please try again later.');
  }
  if (!ok) throw fail();
}
