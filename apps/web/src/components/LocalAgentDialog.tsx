import type { ApiTokenSummary, BridgeInfo, LocalAgentStatus } from '@texdraft/shared';
import { Check, CircleAlert, Copy, Globe, KeyRound, Laptop, Loader2, Plug, ShieldCheck, Terminal, Trash2, Wand2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { formatRelative, useI18n } from '../lib/i18n';
import { IconButton } from './ui';

type Agent = 'claude' | 'codex' | 'gemini' | 'json';

function CopyBlock({ code }: { code: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <pre>{code}</pre>
      <button
        className="code-copy"
        onClick={() => {
          navigator.clipboard?.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        title={t('ai.copy')}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

/** 连接本地 Agent：生成访问令牌，给出 Claude Code / Codex / Gemini CLI 的 MCP 配置命令 */
export function LocalAgentDialog({
  projectId,
  projectName,
  onClose,
  initialTab = 'web',
}: {
  /** 在编辑器里打开时为当前项目；在项目列表打开时为空（令牌只能是“全部项目”） */
  projectId?: string;
  projectName?: string;
  onClose: () => void;
  initialTab?: 'web' | 'computer';
}) {
  const { t, locale } = useI18n();
  const dialog = useDialog();
  const [url, setUrl] = useState('');
  const [tokens, setTokens] = useState<ApiTokenSummary[]>([]);
  const [scopeProject, setScopeProject] = useState(!!projectId);
  /** guide = 连接向导（只有步骤）；manage = 已连接的电脑与令牌 */
  const [view, setView] = useState<'guide' | 'manage'>('guide');
  const nameForExample = projectName ?? t('agent.yourProject');
  const [name, setName] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [agent, setAgent] = useState<Agent>('claude');
  const [error, setError] = useState('');
  const [local, setLocal] = useState<{ enabled: boolean; agents: LocalAgentStatus[] } | null>(null);
  const [setting, setSetting] = useState(false);
  const [setupDone, setSetupDone] = useState(false);

  const load = () => api.tokens().then(setTokens).catch(() => {});
  useEffect(() => {
    api.mcpInfo().then((r) => setUrl(r.url)).catch((e) => setError(e.message));
    api.localAgents().then(setLocal).catch(() => setLocal(null));
    load();
  }, []);

  // 两类连接方式；从 AI 面板的「用你电脑上的 Codex / Claude Code」打开时直接显示第二类
  const [tab, setTab] = useState<'web' | 'computer'>(initialTab);
  const [mode, setMode] = useState<'panel' | 'terminal'>('panel');

  // 本地桥接：在线电脑列表（对话框打开期间每 3 秒刷新），以及桥接专用令牌（全部项目）
  const [bridges, setBridges] = useState<BridgeInfo[] | null>(null);
  const [bridgeToken, setBridgeToken] = useState<string | null>(null);
  useEffect(() => {
    const load = () => api.bridges().then((r) => setBridges(r.bridges), () => setBridges([]));
    load();
    const h = setInterval(load, 3000);
    return () => clearInterval(h);
  }, []);
  const createBridgeToken = async () => {
    setError('');
    try {
      const r = await api.createToken(t('agent.bridgeTokenName'), null);
      setBridgeToken(r.token);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const server = url.replace(/\/mcp$/, '');
  const bridgeCmd = `curl -fsSL ${server}/mcp/bridge.mjs -o texdraft-bridge.mjs\nnode texdraft-bridge.mjs --server ${server} --token ${bridgeToken ?? 'tp_YOUR_TOKEN'}`;

  const create = async () => {
    setError('');
    try {
      const r = await api.createToken(name.trim() || (scopeProject && projectName ? projectName : t('agent.allProjects')), scopeProject && projectId ? projectId : null);
      setToken(r.token);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const oneClick = async () => {
    setSetting(true);
    setError('');
    try {
      const r = await api.setupLocalAgents();
      setLocal({ enabled: true, agents: r.agents });
      setSetupDone(true);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSetting(false);
    }
  };

  const revoke = async (tk: ApiTokenSummary) => {
    if (!(await dialog.confirm(t('agent.revokeConfirm', { name: tk.name }), { message: t('agent.revokeWarning'), danger: true, confirmText: t('agent.revoke') }))) return;
    await api.revokeToken(tk.id).catch((e) => dialog.alert(t('common.failed'), e.message));
    load();
  };

  const tok = token ?? 'tp_YOUR_TOKEN';
  const commands: Record<Agent, string> = {
    claude: `claude mcp add -s user --transport http texdraft ${url} \\\n  --header "Authorization: Bearer ${tok}"`,
    codex: `# ${t('agent.codexEnvNote')}\ncodex mcp remove texdraft 2>/dev/null\ncat >> ~/.codex/config.toml <<'EOF'\n\n[mcp_servers.texdraft]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${tok}" }\nEOF\ncodex mcp list`,
    gemini: `gemini mcp add -s user -t http texdraft ${url} \\\n  -H "Authorization: Bearer ${tok}"`,
    json: JSON.stringify({ mcpServers: { texdraft: { type: 'http', url, headers: { Authorization: `Bearer ${tok}` } } } }, null, 2),
  };
  const example = scopeProject ? t('agent.examplePromptScoped') : t('agent.examplePrompt', { name: nameForExample });

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide agent-dialog" role="dialog">
        <div className="modal-head">
          <div className="modal-title with-icon">
            <Plug size={17} /> {t('agent.title')}
          </div>
          <IconButton icon={X} label={t('common.close')} onClick={onClose} />
        </div>
        <p className="muted small agent-intro">{t('agent.intro')}</p>

        {view === 'guide' && (
        <>
        {/* 按「在哪里和 AI 对话」分成两类：ChatGPT / Claude 网页版；自己电脑上的 Codex / Claude Code */}
        <div className="agent-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'web'} className={tab === 'web' ? 'on' : ''} onClick={() => setTab('web')}>
            <Globe size={15} />
            <span>
              <strong>{t('agent.tabWeb')}</strong>
              <small>{t('agent.tabWebDesc')}</small>
            </span>
          </button>
          <button role="tab" aria-selected={tab === 'computer'} className={tab === 'computer' ? 'on' : ''} onClick={() => setTab('computer')}>
            <Laptop size={15} />
            <span>
              <strong>{t('agent.tabComputer')}</strong>
              <small>{t('agent.tabComputerDesc')}</small>
            </span>
          </button>
        </div>

        {tab === 'web' && (
        <>
        {/* 网页版 ChatGPT / Claude：远程 MCP + OAuth，用 TeXdraft 账号授权即可，不需要令牌 */}
        <div className="agent-section">
          <div className="agent-section-title">
            <Globe size={15} /> {t('agent.webTitle')}
          </div>
          <ol className="agent-web-steps">
            <li>{t('agent.web1')}</li>
            <li>
              {t('agent.web2')}
              <CopyBlock code={url} />
            </li>
            <li>{t('agent.web3')}</li>
            <li>{t('agent.web4')}</li>
          </ol>
          <div className="muted small">{t('agent.webExampleLabel')}</div>
          <CopyBlock code={t('agent.examplePrompt', { name: nameForExample })} />
        </div>

        </>
        )}

        {tab === 'computer' && (
        <>
        <div className="agent-modes">
          <div className="muted small">{t('agent.modeQuestion')}</div>
          <div className="segmented">
            <button className={mode === 'panel' ? 'on' : ''} onClick={() => setMode('panel')}>
              <Laptop size={13} /> {t('agent.modePanel')}
            </button>
            <button className={mode === 'terminal' ? 'on' : ''} onClick={() => setMode('terminal')}>
              <Terminal size={13} /> {t('agent.modeTerminal')}
            </button>
          </div>
        </div>

        {mode === 'panel' && (
        /* 本地桥接：网页 AI 面板直接使用用户电脑上的 Codex / Claude Code */
        <div className="agent-section">
          <p className="muted small">{t('agent.bridgeDesc')}</p>
          <div className={`bridge-status ${bridges?.length ? 'on' : ''}`}>
            {bridges === null
              ? t('common.loading')
              : bridges.length
                ? bridges.map((b) => (
                    <div key={b.id}>
                      <Check size={13} /> {t('agent.bridgeConnected', { host: b.hostname, agents: b.agents.map((a) => (a.id === 'claude' ? 'Claude Code' : 'Codex')).join('、') })}
                      {b.outdated && <span className="bridge-outdated"> · {t('agent.bridgeOutdated', { version: b.version })}</span>}
                    </div>
                  ))
                : t('agent.bridgeNone')}
          </div>
          <ol className="agent-web-steps">
            <li>{t('agent.bridge1')}</li>
            <li>
              {t('agent.bridge2')}{' '}
              {bridgeToken ? (
                <span className="muted small">{t('agent.tokenOnce')}</span>
              ) : (
                <button className="btn small" onClick={createBridgeToken}>
                  <KeyRound size={13} /> {t('agent.bridgeCreateToken')}
                </button>
              )}
            </li>
            <li>
              {t('agent.bridge3')}
              <CopyBlock code={bridgeCmd} />
            </li>
            <li>{t('agent.bridge4')}</li>
          </ol>
        </div>

        )}

        {mode === 'terminal' && (
        <>
        <p className="muted small">{t('agent.terminalDesc')}</p>

        {local?.enabled && (
          <div className="one-click">
            <div className="one-click-head">
              <Wand2 size={16} />
              <div>
                <div className="step-title">{t('agent.oneClickTitle')}</div>
                <div className="muted small">{t('agent.oneClickDesc')}</div>
              </div>
            </div>
            <div className="agent-chips">
              {local.agents.map((a) => (
                <span key={a.id} className={`agent-chip ${a.configured ? 'ok' : a.installed ? '' : 'missing'}`} title={a.error}>
                  {a.configured ? <Check size={13} /> : a.error ? <CircleAlert size={13} /> : null}
                  {{ claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' }[a.id]}
                  <span className="chip-state">
                    {a.configured ? t('agent.configured') : a.installed ? (a.error ? t('agent.setupFailed') : t('agent.notConfigured')) : t('agent.notInstalled')}
                  </span>
                </span>
              ))}
            </div>
            <div className="one-click-actions">
              <button className="btn primary" onClick={oneClick} disabled={setting || !local.agents.some((a) => a.installed)}>
                {setting ? <Loader2 size={15} className="spin" /> : <Wand2 size={15} />} {local.agents.some((a) => a.configured) ? t('agent.reconfigure') : t('agent.oneClick')}
              </button>
              {setupDone && <span className="one-click-done">{t('agent.oneClickDone')}</span>}
            </div>
            <div className="muted small">{t('agent.examplePromptLabel')}</div>
            <CopyBlock code={t('agent.examplePrompt', { name: nameForExample })} />
          </div>
        )}

        <details className="manual-setup" open={!local?.enabled || undefined}>
          <summary>{local?.enabled ? t('agent.manualOther') : t('agent.manualTitle')}</summary>

        <div className="agent-step">
          <div className="step-num">1</div>
          <div className="step-body">
            <div className="step-title">{t('agent.step1')}</div>
            {token ? (
              <div className="token-created">
                <ShieldCheck size={16} />
                <code>{token}</code>
                <CopyBlockInline text={token} />
              </div>
            ) : (
              <div className="token-form">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('agent.tokenName')} />
                <div className="segmented small" hidden={!projectId}>
                  <button className={scopeProject ? 'on' : ''} onClick={() => setScopeProject(true)}>
                    {t('agent.scopeProject')}
                  </button>
                  <button className={!scopeProject ? 'on' : ''} onClick={() => setScopeProject(false)}>
                    {t('agent.scopeAll')}
                  </button>
                </div>
                <button className="btn primary small" onClick={create}>
                  <KeyRound size={13} /> {t('agent.createToken')}
                </button>
              </div>
            )}
            {token && <div className="muted small">{t('agent.tokenOnce')}</div>}
          </div>
        </div>

        <div className="agent-step">
          <div className="step-num">2</div>
          <div className="step-body">
            <div className="step-title">{t('agent.step2')}</div>
            <div className="segmented small">
              {(['claude', 'codex', 'gemini', 'json'] as Agent[]).map((a) => (
                <button key={a} className={agent === a ? 'on' : ''} onClick={() => setAgent(a)}>
                  {{ claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', json: t('agent.otherClients') }[a]}
                </button>
              ))}
            </div>
            <CopyBlock code={commands[agent]} />
            <label className="field inline">
              <span>{t('agent.serverUrl')}</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
            <div className="muted small">{t('agent.urlHint')}</div>
          </div>
        </div>

        <div className="agent-step">
          <div className="step-num">3</div>
          <div className="step-body">
            <div className="step-title">{t('agent.step3')}</div>
            <CopyBlock code={example} />
            <div className="muted small">{t('agent.step3Hint')}</div>
          </div>
        </div>

        </details>
        </>
        )}
        </>
        )}

        <button type="button" className="link small agent-manage-link" onClick={() => setView('manage')}>
          {t('agent.manageLink', { n: (bridges?.length ?? 0) + tokens.length })} →
        </button>
        </>
        )}

        {view === 'manage' && (
          <div className="agent-manage">
            <button type="button" className="link small" onClick={() => setView('guide')}>
              ← {t('agent.backToGuide')}
            </button>
            <div className="menu-section">{t('agent.computers')}</div>
            {!bridges?.length && <div className="muted small">{t('agent.bridgeNone')}</div>}
            {bridges?.map((b) => (
              <div key={b.id} className="token-row">
                <Laptop size={14} className="muted" />
                <div className="token-info">
                  <div>
                    {b.hostname} {b.outdated && <span className="bridge-outdated">· {t('agent.bridgeOutdated', { version: b.version })}</span>}
                  </div>
                  <div className="muted small">
                    {b.agents.map((a) => `${a.id === 'claude' ? 'Claude Code' : 'Codex'}${a.version ? ` ${a.version}` : ''}`).join('、')} · {b.platform} · texdraft-bridge {b.version} ·{' '}
                    {t('agent.connectedSince', { when: formatRelative(b.connectedAt, locale) })}
                  </div>
                </div>
              </div>
            ))}
            {tokens.length === 0 && <><div className="menu-section">{t('agent.existing')}</div><div className="muted small">{t('agent.noTokens')}</div></>}
          </div>
        )}

        {error && <div className="form-error">{error}</div>}

        {view === 'manage' && tokens.length > 0 && (
          <div className="token-list">
            <div className="menu-section">{t('agent.existing')}</div>
            {tokens.map((tk) => (
              <div key={tk.id} className="token-row">
                <KeyRound size={14} className="muted" />
                <div className="token-info">
                  <div>
                    {tk.name} <code>{tk.prefix}…</code>
                  </div>
                  <div className="muted small">
                    {tk.projectName ? t('agent.scopedTo', { name: tk.projectName }) : t('agent.allProjects')} ·{' '}
                    {tk.lastUsedAt ? t('agent.lastUsed', { when: formatRelative(tk.lastUsedAt, locale) }) : t('agent.neverUsed')}
                  </div>
                </div>
                <button className="btn small ghost" onClick={() => revoke(tk)}>
                  <Trash2 size={13} /> {t('agent.revoke')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CopyBlockInline({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="icon-btn"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}
