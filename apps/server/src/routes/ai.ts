import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createProvider } from '../agent/providers/index.js';
import { configForTest, deleteSettings, publicSettings, saveSettings } from '../ai/settings.js';
import { badRequest } from '../lib/http.js';
import { userStatus } from '../lib/userStatus.js';
import { currentUser, prefersZh } from './auth.js';

const SettingsBody = z.object({
  preset: z.string().max(40),
  provider: z.enum(['anthropic', 'compatible', 'openai']).optional(),
  baseUrl: z.string().max(500).nullable().optional(),
  model: z.string().max(200),
  apiKey: z.string().max(500).optional(),
  maxTokens: z.number().int().nullable().optional(),
  vision: z.boolean().nullable().optional(),
  contextWindow: z.number().int().nullable().optional(),
});

export async function aiRoutes(app: FastifyInstance) {
  app.get('/api/ai/settings', async (req) => {
    const uid = currentUser(req);
    return publicSettings(uid, (await userStatus(uid)).isAdmin);
  });

  app.put('/api/ai/settings', async (req) => {
    const uid = currentUser(req);
    const body = SettingsBody.safeParse(req.body);
    if (!body.success) throw badRequest('Invalid settings');
    const isAdmin = (await userStatus(uid)).isAdmin;
    await saveSettings(uid, isAdmin, body.data, prefersZh(req));
    return publicSettings(uid, isAdmin);
  });

  app.delete('/api/ai/settings', async (req) => {
    const uid = currentUser(req);
    await deleteSettings(uid);
    return publicSettings(uid, (await userStatus(uid)).isAdmin);
  });

  /** 测试连接：用表单里的设置（Key 未填时用已保存的）发一条很短的请求 */
  app.post('/api/ai/test', async (req) => {
    const uid = currentUser(req);
    const zh = prefersZh(req);
    const body = SettingsBody.safeParse(req.body);
    if (!body.success) throw badRequest('Invalid settings');
    const cfg = await configForTest(uid, (await userStatus(uid)).isAdmin, body.data, zh);
    const provider = createProvider(cfg);
    const started = Date.now();
    try {
      const turn = await provider.streamTurn({
        system: 'You are a connectivity check. Reply with the single word OK.',
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        tools: [],
        maxTokens: 64,
        effort: 'low',
        signal: AbortSignal.timeout(30_000),
      });
      const reply = turn.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('').trim();
      return { ok: true, latencyMs: Date.now() - started, reply: reply.slice(0, 200) };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: provider.describeError(err, zh) };
    }
  });
}
