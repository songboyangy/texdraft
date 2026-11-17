import type { ProjectSummary, ProjectTag } from '@texdraft/shared';
import { ArrowDownAZ, BookOpen, Clock, FileText, FolderUp, Inbox, Laptop, Layers, MoreHorizontal, Pencil, Plus, Search, Tag, Trash2, Users, X } from 'lucide-react';
import { ImportZipDialog } from '../components/ImportZipDialog';
import { LocalAgentDialog } from '../components/LocalAgentDialog';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Logo } from '../components/Logo';
import { Dropdown, MenuDivider, MenuItem, MenuLabel } from '../components/ui';
import { UserMenu } from '../components/UserMenu';
import { api } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { formatRelative, useI18n } from '../lib/i18n';

type Sort = 'recent' | 'name';
/** 左侧分类：全部、未分类，或某个标签的 id */
type Filter = 'all' | 'untagged' | string;
const FILTER_KEY = 'tp.projects.filter';

export function ProjectsPage() {
  const { t, locale } = useI18n();
  const dialog = useDialog();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [importOpen, setImportOpen] = useState(false);

  const [tags, setTags] = useState<ProjectTag[]>([]);
  const [filter, setFilterState] = useState<Filter>(() => {
    try {
      return localStorage.getItem(FILTER_KEY) || 'all';
    } catch {
      return 'all';
    }
  });
  const setFilter = (f: Filter) => {
    setFilterState(f);
    try {
      localStorage.setItem(FILTER_KEY, f);
    } catch {
      /* 隐私模式：不记住 */
    }
  };

  const loadTags = () => api.tags().then(setTags, () => {});
  const load = () => {
    loadTags();
    return api.projects().then(setProjects, (e) => setError(e.message));
  };
  useEffect(() => {
    load();
  }, []);
  // 记住的标签已被删除时回到「全部」
  useEffect(() => {
    if (filter !== 'all' && filter !== 'untagged' && tags.length && !tags.some((t) => t.id === filter)) setFilter('all');
  }, [tags, filter]);

  const tagName = useMemo(() => new Map(tags.map((tg) => [tg.id, tg.name])), [tags]);
  const untaggedCount = (projects ?? []).filter((p) => !p.tags?.length).length;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (projects ?? []).filter(
      (p) =>
        (!q || p.name.toLowerCase().includes(q)) &&
        (filter === 'all' || (filter === 'untagged' ? !p.tags?.length : p.tags?.includes(filter))),
    );
    return sort === 'name'
      ? [...list].sort((a, b) => a.name.localeCompare(b.name, locale))
      : [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [projects, query, sort, locale, filter]);

  const create = async () => {
    const name = await dialog.prompt(t('projects.newTitle'), t('projects.untitled'), t('projects.namePlaceholder'));
    if (name === null) return;
    try {
      const p = await api.createProject(name);
      // 正在看某个标签时，新项目直接归到这个标签下
      if (filter !== 'all' && filter !== 'untagged') await api.tagProject(filter, p.id, true).catch(() => {});
      navigate(`/project/${p.id}`);
    } catch (e) {
      dialog.alert(t('projects.createFailed'), (e as Error).message);
    }
  };

  // 引导卡
  const INTRO_KEY = 'tp.projectsIntro.hidden';
  const [introHidden, setIntroHidden] = useState(() => {
    try {
      return localStorage.getItem(INTRO_KEY) === '1';
    } catch {
      return false;
    }
  });
  const hideIntro = () => {
    setIntroHidden(true);
    try {
      localStorage.setItem(INTRO_KEY, '1');
    } catch {
      /* 隐私模式：只在本页隐藏 */
    }
  };
  const [agentOpen, setAgentOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const openSample = async () => {
    setOpening(true);
    try {
      const p = await api.openSample();
      navigate(`/project/${p.id}`);
    } catch (e) {
      dialog.alert(t('common.failed'), (e as Error).message);
    } finally {
      setOpening(false);
    }
  };

  /** 导入 zip 为新项目并打开；正在看某个标签时归到这个标签下。出错时抛给对话框显示 */
  const importZip = async (file: File) => {
    const r = await api.importZip(file);
    if (filter !== 'all' && filter !== 'untagged') await api.tagProject(filter, r.id, true).catch(() => {});
    navigate(`/project/${r.id}`);
  };

  const remove = async (p: ProjectSummary) => {
    const ok = await dialog.confirm(t('projects.deleteConfirm', { name: p.name }), {
      message: t('projects.deleteWarning'),
      danger: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    await api.deleteProject(p.id).catch((e) => dialog.alert(t('projects.deleteFailed'), e.message));
    load();
  };

  const rename = async (p: ProjectSummary) => {
    const name = (await dialog.prompt(t('editor.rename'), p.name))?.trim();
    if (!name || name === p.name) return;
    await api.updateProject(p.id, { name }).catch((e) => dialog.alert(t('common.failed'), e.message));
    load();
  };

  // ---------------- 标签 ----------------
  const newTag = async (thenAdd?: ProjectSummary) => {
    const name = (await dialog.prompt(t('projects.newTag'), '', t('projects.tagNamePlaceholder')))?.trim();
    if (!name) return;
    try {
      const tg = await api.createTag(name);
      if (thenAdd) await api.tagProject(tg.id, thenAdd.id, true);
      else setFilter(tg.id);
    } catch (e) {
      dialog.alert(t('common.failed'), (e as Error).message);
    }
    load();
  };
  const renameTag = async (tg: ProjectTag) => {
    const name = (await dialog.prompt(t('projects.renameTag'), tg.name))?.trim();
    if (!name || name === tg.name) return;
    await api.renameTag(tg.id, name).catch((e) => dialog.alert(t('common.failed'), e.message));
    loadTags();
  };
  const deleteTag = async (tg: ProjectTag) => {
    const ok = await dialog.confirm(t('projects.deleteTagConfirm', { name: tg.name }), {
      message: t('projects.deleteTagNote'),
      danger: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    await api.deleteTag(tg.id).catch((e) => dialog.alert(t('common.failed'), e.message));
    if (filter === tg.id) setFilter('all');
    load();
  };
  /** 勾选 / 取消项目的某个标签：先改界面，再同步到服务器 */
  const toggleTag = async (p: ProjectSummary, tagId: string) => {
    const on = !p.tags?.includes(tagId);
    setProjects((list) =>
      list?.map((x) => (x.id === p.id ? { ...x, tags: on ? [...(x.tags ?? []), tagId] : (x.tags ?? []).filter((id) => id !== tagId) } : x)) ?? list,
    );
    setTags((list) => list.map((tg) => (tg.id === tagId ? { ...tg, count: tg.count + (on ? 1 : -1) } : tg)));
    await api.tagProject(tagId, p.id, on).catch((e) => {
      dialog.alert(t('common.failed'), e.message);
      load();
    });
  };

  const roleLabel = (r: ProjectSummary['role']) => t(`role.${r}` as const);

  return (
    <div className="projects-page">
      <header className="app-header">
        <Logo />
        <span className="spacer" />
        <UserMenu />
      </header>

      <main className="projects-main">
        <div className="projects-head">
          <div>
            <h1>{t('projects.title')}</h1>
            <p className="muted">{t('projects.subtitle')}</p>
          </div>
          <div className="btn-row">
            <button className="btn" onClick={() => setImportOpen(true)} title={t('projects.importHint')}>
              <FolderUp size={16} /> {t('projects.importZip')}
            </button>
            <button className="btn primary" onClick={create}>
              <Plus size={16} /> {t('projects.new')}
            </button>
          </div>
        </div>

        {/* 轻量引导卡：产品特色（本地 Agent 参与写作）+ 两个入口；可关闭 */}
        {!introHidden && (
          <div className="intro-card">
            <Laptop size={18} className="intro-icon" />
            <div className="intro-text">
              <strong>{t('projects.introTitle')}</strong>
              <span className="muted small">{t('projects.introDesc')}</span>
            </div>
            <div className="btn-row">
              <button className="btn small" onClick={() => setAgentOpen(true)}>
                <Laptop size={14} /> {t('chat.connectComputer')}
              </button>
              <button className="btn small" onClick={openSample} disabled={opening}>
                <BookOpen size={14} /> {t('projects.openSample')}
              </button>
            </div>
            <button className="intro-close" onClick={hideIntro} aria-label={t('common.close')} title={t('common.close')}>
              <X size={14} />
            </button>
          </div>
        )}
        {importOpen && <ImportZipDialog onClose={() => setImportOpen(false)} onImport={importZip} />}
        {agentOpen && <LocalAgentDialog initialTab="computer" onClose={() => setAgentOpen(false)} />}

        <div className="projects-toolbar">
          <label className="search-input">
            <Search size={15} />
            <input placeholder={t('projects.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="segmented">
            <button className={sort === 'recent' ? 'on' : ''} onClick={() => setSort('recent')}>
              <Clock size={14} /> {t('projects.sortRecent')}
            </button>
            <button className={sort === 'name' ? 'on' : ''} onClick={() => setSort('name')}>
              <ArrowDownAZ size={14} /> {t('projects.sortName')}
            </button>
          </div>
        </div>

        <div className="projects-body">
          <nav className="tag-nav" aria-label={t('projects.tags')}>
            <button className={`tag-nav-item ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>
              <Layers size={15} /> <span className="tag-nav-name">{t('projects.tagsAll')}</span>
              <span className="tag-nav-count">{projects?.length ?? ''}</span>
            </button>
            <button className={`tag-nav-item ${filter === 'untagged' ? 'on' : ''}`} onClick={() => setFilter('untagged')}>
              <Inbox size={15} /> <span className="tag-nav-name">{t('projects.untagged')}</span>
              <span className="tag-nav-count">{projects ? untaggedCount : ''}</span>
            </button>
            {tags.length > 0 && <div className="tag-nav-label">{t('projects.tags')}</div>}
            {tags.map((tg) => (
              <div key={tg.id} className={`tag-nav-item ${filter === tg.id ? 'on' : ''}`} role="button" tabIndex={0}
                onClick={() => setFilter(tg.id)} onKeyDown={(e) => e.key === 'Enter' && setFilter(tg.id)}>
                <Tag size={15} /> <span className="tag-nav-name" title={tg.name}>{tg.name}</span>
                <span className="tag-nav-count">{tg.count}</span>
                <span className="tag-nav-more" onClick={(e) => e.stopPropagation()}>
                  <Dropdown
                    align="right"
                    trigger={(_o, toggle) => (
                      <button className="tree-more" onClick={toggle} aria-label={t('common.more')}>
                        <MoreHorizontal size={14} />
                      </button>
                    )}
                  >
                    {(close) => (
                      <>
                        <MenuItem icon={Pencil} onClick={() => (close(), renameTag(tg))}>{t('projects.renameTag')}</MenuItem>
                        <MenuItem icon={Trash2} danger onClick={() => (close(), deleteTag(tg))}>{t('projects.deleteTag')}</MenuItem>
                      </>
                    )}
                  </Dropdown>
                </span>
              </div>
            ))}
            <button className="tag-nav-item add" onClick={() => newTag()}>
              <Plus size={15} /> <span className="tag-nav-name">{t('projects.newTag')}</span>
            </button>
          </nav>
          <div className="projects-content">
          {error && <div className="form-error">{error}</div>}
        {projects === null ? (
          <div className="muted pad">{t('common.loading')}</div>
        ) : projects.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <FileText size={28} />
            </div>
            <h3>{t('projects.emptyTitle')}</h3>
            <p className="muted">{t('projects.emptyDesc')}</p>
            <button className="btn primary" onClick={create}>
              <Plus size={16} /> {t('projects.new')}
            </button>
          </div>
        ) : (
          <div className="project-list">
            <div className="project-row head">
              <span>{t('projects.colName')}</span>
              <span>{t('projects.colAccess')}</span>
              <span>{t('projects.colUpdated')}</span>
              <span />
            </div>
            {shown.map((p) => (
              <div key={p.id} className="project-row">
                <Link to={`/project/${p.id}`} className="project-name-cell">
                  <span className="project-icon">
                    <FileText size={16} />
                  </span>
                  <span className="project-title">{p.name}</span>
                  {(p.tags ?? []).map((id) =>
                    tagName.has(id) ? (
                      <span key={id} className="tag-pill" title={t('projects.showTag')}
                        onClick={(e) => (e.preventDefault(), e.stopPropagation(), setFilter(id))}>
                        {tagName.get(id)}
                      </span>
                    ) : null,
                  )}
                </Link>
                <span className="muted">
                  {p.role !== 'owner' && <Users size={13} className="inline-icon" />} {roleLabel(p.role)}
                </span>
                <span className="muted" title={new Date(p.updatedAt).toLocaleString(locale)}>
                  {formatRelative(p.updatedAt, locale)}
                </span>
                <span className="right">
                  <Dropdown
                    align="right"
                    trigger={(_o, toggle) => (
                      <button className="icon-btn ghost" onClick={toggle} aria-label={t('common.more')}>
                        <MoreHorizontal size={16} />
                      </button>
                    )}
                  >
                    {(close) => (
                      <>
                        <MenuLabel>{t('projects.tags')}</MenuLabel>
                        {tags.map((tg) => (
                          <MenuItem key={tg.id} icon={Tag} checked={p.tags?.includes(tg.id)} onClick={() => toggleTag(p, tg.id)}>
                            {tg.name}
                          </MenuItem>
                        ))}
                        <MenuItem icon={Plus} onClick={() => (close(), newTag(p))}>
                          {t('projects.newTagAndAdd')}
                        </MenuItem>
                        <MenuDivider />
                        {p.role !== 'viewer' && (
                          <MenuItem icon={Pencil} onClick={() => (close(), rename(p))}>
                            {t('projects.rename')}
                          </MenuItem>
                        )}
                        {p.role === 'owner' && (
                          <MenuItem icon={Trash2} danger onClick={() => (close(), remove(p))}>
                            {t('common.delete')}
                          </MenuItem>
                        )}
                      </>
                    )}
                  </Dropdown>
                </span>
              </div>
            ))}
            {shown.length === 0 && (
              <div className="muted pad">{filter !== 'all' && !query.trim() ? t('projects.emptyTag') : t('projects.noMatch')}</div>
            )}
          </div>
        )}
          </div>
        </div>
      </main>
    </div>
  );
}
