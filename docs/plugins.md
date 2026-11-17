# Server plugins

A deployment can extend the TeXdraft server without patching it. A plugin is an ES module listed in `TEXDRAFT_PLUGINS` (comma-separated package names or file paths). It is loaded at startup, after the built-in routes are registered and before the server starts listening.

```bash
TEXDRAFT_PLUGINS=./plugins/quota-plans.mjs,@acme/texdraft-sso
```

A plugin's default export (or a named export `register`) is called with the plugin API:

```ts
import type { TeXdraftPlugin } from './texdraft/apps/server/src/plugins.js';

const plugin: TeXdraftPlugin = async ({ app, config, setQuotaProvider, builtinQuota }) => {
  // …
};
export default plugin;
```

| Field | Purpose |
|---|---|
| `app` | The Fastify instance: add routes (e.g. webhooks), hooks or decorators. |
| `config` | The parsed server configuration (read-only by convention). |
| `setQuotaProvider(p)` | Replace how AI usage on the server's key is limited and metered. |
| `builtinQuota` | The default quota provider, to wrap or fall back to. |

If a plugin fails to load, the server does not start. Running without a plugin that enforces a policy (for example a quota) would be worse than not running.

## Quota provider

Every model call on the **server's** API key goes through the active `QuotaProvider` ([`apps/server/src/ai/quota.ts`](../apps/server/src/ai/quota.ts)):

```ts
interface QuotaProvider {
  name: string;
  check(ctx: { userId; isAdmin; zh }): Promise<void>;          // throw (e.g. HttpError 429) to refuse
  record(userId, source: 'own' | 'shared', usage): Promise<void>; // after every model response
  status(ctx: { userId; isAdmin }): Promise<{ dailyTokens; credit }>; // shown in the chat panel and settings
}
```

When each method is called:

- `check` runs before the first request of an agent run or selection action. It runs again between agent steps, so a run stops cleanly and keeps its edits when the allowance runs out. The error message is shown to the user.
- `record` receives the token usage of each response, both for users' own keys (`source: 'own'`) and for the server key (`'shared'`). Call `addUsage` from `ai/quota.ts` to keep the per-user statistics in the `ai_usage` table, as the built-in provider does.
- `status` drives the "free credit left" line in the chat panel and account settings.

**The built-in provider** implements a self-hosted server's needs:

- an optional daily token cap per user (`AI_SHARED_DAILY_TOKENS`)
- an optional total credit priced per million tokens (`AI_SHARED_CREDIT` and `AI_PRICE_*`), which admins can adjust per user
- admins are exempt
- usage with a user's own key is counted but never limited

**Example**: wrap the built-in provider and also refuse users whose plan has expired.

```js
export default async function ({ setQuotaProvider, builtinQuota }) {
  setQuotaProvider({
    ...builtinQuota,
    name: 'plans',
    async check(ctx) {
      if (!ctx.isAdmin && (await planExpired(ctx.userId))) {
        const err = new Error(ctx.zh ? '套餐已到期' : 'Your plan has expired');
        err.statusCode = 429;
        throw err;
      }
      return builtinQuota.check(ctx);
    },
  });
}
```

## Adding extension points

Extension points are added to `TeXdraftPluginApi` in [`apps/server/src/plugins.ts`](../apps/server/src/plugins.ts) as real needs come up. Keep each one small, give the built-in behaviour a default implementation, and document it here.
