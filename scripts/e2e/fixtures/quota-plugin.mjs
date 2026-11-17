// Test plugin for scripts/e2e/plugins.mjs: wraps the built-in quota provider, counts calls, and refuses
// the user set through POST /api/_test_plugin/block. Never load it outside tests.
export default async function ({ app, setQuotaProvider, builtinQuota }) {
  const calls = { check: 0, record: 0, status: 0 };
  let blocked = null;
  setQuotaProvider({
    name: 'test-plan',
    async check(ctx) {
      calls.check++;
      if (ctx.userId === blocked) throw Object.assign(new Error('Blocked by test plan'), { statusCode: 429 });
      return builtinQuota.check(ctx);
    },
    async record(...args) {
      calls.record++;
      return builtinQuota.record(...args);
    },
    async status(ctx) {
      calls.status++;
      return builtinQuota.status(ctx);
    },
  });
  app.get('/api/_test_plugin/calls', async () => calls);
  app.post('/api/_test_plugin/block', async (req) => {
    blocked = req.body.userId;
    return { ok: true };
  });
}
