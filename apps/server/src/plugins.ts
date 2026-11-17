import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { builtinQuota, setQuotaProvider, type QuotaProvider } from './ai/quota.js';
import { config } from './config.js';

/**
 * Server plugins: modules listed in TEXDRAFT_PLUGINS (comma-separated package names or file paths)
 * are imported at startup, after the built-in routes are registered and before the server listens.
 * A plugin's default export (or named `register`) receives the API below.
 *
 *   // my-plugin.ts (types: apps/server/src/plugins.ts)
 *   import type { TeXdraftPlugin } from './texdraft/apps/server/src/plugins.js';
 *   const plugin: TeXdraftPlugin = async ({ app, setQuotaProvider, builtinQuota }) => {
 *     setQuotaProvider({ ...builtinQuota, name: 'plans', async check(ctx) { … } });
 *     app.post('/api/billing/webhook', async (req) => { … });
 *   };
 *   export default plugin;
 *
 * Extension points are added here as they are needed; keep each one small and documented in
 * docs/plugins.md.
 */
export interface TeXdraftPluginApi {
  /** the Fastify instance: register routes, hooks or decorators */
  app: FastifyInstance;
  config: typeof config;
  /** replace how AI usage on the server's key is limited and metered (see ai/quota.ts) */
  setQuotaProvider(p: QuotaProvider): void;
  /** the default provider, to wrap or fall back to */
  builtinQuota: QuotaProvider;
}

export type TeXdraftPlugin = (api: TeXdraftPluginApi) => void | Promise<void>;

/** Package name → import as is; anything that looks like a path → resolve against the working directory. */
function specifier(spec: string) {
  return spec.startsWith('.') || path.isAbsolute(spec) ? pathToFileURL(path.resolve(spec)).href : spec;
}

export async function loadPlugins(app: FastifyInstance) {
  const api: TeXdraftPluginApi = { app, config, setQuotaProvider, builtinQuota };
  for (const spec of config.plugins) {
    // A plugin that fails to load stops the server: running without, say, its quota policy would be worse.
    const mod = (await import(specifier(spec))) as { default?: unknown; register?: unknown };
    const fn = typeof mod.default === 'function' ? mod.default : mod.register;
    if (typeof fn !== 'function') throw new Error(`Plugin ${spec} must export a default function or "register"`);
    await (fn as TeXdraftPlugin)(api);
    app.log.info(`[plugins] loaded ${spec}`);
  }
}
