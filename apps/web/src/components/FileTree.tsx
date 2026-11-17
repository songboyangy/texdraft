import type { FileEntry } from '@texdraft/shared';
import {
  BookOpen, ChevronDown, ChevronRight, File, FileCode2, FilePlus2, FileText, FolderClosed, FolderOpen, FolderPlus,
  Image, MoreHorizontal, Pencil, Star, Trash2, Upload,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useDialog } from '../lib/dialog';
import { useT } from '../lib/i18n';
import { Dropdown, IconButton, MenuItem } from './ui';

interface Node {
  name: string;
  path: string;
  file?: FileEntry;
  children: Map<string, Node>;
}

function buildTree(files: FileEntry[], folders: string[]): Node {
  const root: Node = { name: '', path: '', children: new Map() };
  // 显式创建的文件夹（可为空）；有文件的文件夹由下面的文件路径补齐
  for (const d of folders) {
    let cur = root;
    d.split('/').forEach((part, i, parts) => {
      const path = parts.slice(0, i + 1).join('/');
      if (!cur.children.has(part)) cur.children.set(part, { name: part, path, children: new Map() });
      cur = cur.children.get(part)!;
    });
  }
  for (const f of files) {
    const parts = f.path.split('/');
    let cur = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      if (!cur.children.has(part)) cur.children.set(part, { name: part, path, children: new Map() });
      cur = cur.children.get(part)!;
      if (i === parts.length - 1) cur.file = f;
    });
  }
  return root;
}

function sortedChildren(n: Node) {
  return [...n.children.values()].sort((a, b) => (a.file ? 1 : 0) - (b.file ? 1 : 0) || a.name.localeCompare(b.name));
}

export function fileIcon(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'tex' || ext === 'ltx') return { Icon: FileText, cls: 'tex' };
  if (ext === 'bib') return { Icon: BookOpen, cls: 'bib' };
  if (['sty', 'cls', 'bst', 'def', 'cfg', 'tikz'].includes(ext)) return { Icon: FileCode2, cls: 'code' };
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'eps'].includes(ext)) return { Icon: Image, cls: 'img' };
  if (ext === 'pdf') return { Icon: File, cls: 'pdf' };
  return { Icon: File, cls: '' };
}

interface Props {
  files: FileEntry[];
  /** 显式创建的文件夹（可为空） */
  folders: string[];
  activeId: string | null;
  mainFile: string;
  canEdit: boolean;
  onOpen: (f: FileEntry) => void;
  onCreate: (path: string) => void;
  onUpload: (files: FileList, dir: string) => void;
  onRename: (f: FileEntry, newPath: string) => void;
  onDelete: (f: FileEntry) => void;
  onSetMain: (f: FileEntry) => void;
  onCreateFolder: (path: string) => void;
  onRenameFolder: (from: string, to: string) => void;
  onDeleteFolder: (path: string) => void;
}

export function FileTree(props: Props) {
  const t = useT();
  const dialog = useDialog();
  const tree = useMemo(() => buildTree(props.files, props.folders), [props.files, props.folders]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedDir, setSelectedDir] = useState('');
  const [dropDir, setDropDir] = useState<string | null>(null);
  const upload = useRef<HTMLInputElement>(null);

  const activeFile = props.files.find((f) => f.id === props.activeId);
  const currentDir = selectedDir || (activeFile?.path.includes('/') ? activeFile.path.replace(/\/[^/]*$/, '') : '');

  const newFile = async (dir = currentDir) => {
    const name = await dialog.prompt(t('files.newFile'), dir ? `${dir}/` : '', t('files.newFilePlaceholder'));
    if (name?.trim() && !name.trim().endsWith('/')) props.onCreate(name.trim());
  };
  const newFolder = async (dir = currentDir) => {
    const input = await dialog.prompt(t('files.newFolder'), dir ? `${dir}/` : '', t('files.newFolderPlaceholder'));
    const clean = input?.trim().replace(/\/+$/, '');
    if (!clean || clean === dir) return;
    props.onCreateFolder(clean);
    setSelectedDir(clean);
    setCollapsed((s) => {
      const next = new Set(s);
      for (const p of [dir, clean]) next.delete(p);
      return next;
    });
  };
  const renameFolder = async (path: string) => {
    const to = (await dialog.prompt(t('files.renameFolder'), path))?.trim().replace(/\/+$/, '');
    if (!to || to === path) return;
    props.onRenameFolder(path, to);
    if (selectedDir === path || selectedDir.startsWith(path + '/')) setSelectedDir(to + selectedDir.slice(path.length));
  };
  const deleteFolder = async (path: string) => {
    const n = props.files.filter((f) => f.path.startsWith(path + '/')).length;
    const ok = await dialog.confirm(
      n ? t('files.deleteFolderConfirm', { path, n: String(n) }) : t('files.deleteEmptyFolderConfirm', { path }),
      { danger: true, confirmText: t('common.delete') },
    );
    if (!ok) return;
    props.onDeleteFolder(path);
    if (selectedDir === path || selectedDir.startsWith(path + '/')) setSelectedDir('');
  };

  const dropHandlers = (dir: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!props.canEdit || !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      setDropDir(dir);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropDir(null);
      if (e.dataTransfer.files.length) props.onUpload(e.dataTransfer.files, dir);
    },
  });

  const render = (n: Node, depth: number): React.ReactNode =>
    sortedChildren(n).map((c) => {
      const pad = { paddingLeft: 8 + depth * 14 };
      if (c.file) {
        const f = c.file;
        const isMain = f.path === props.mainFile;
        const { Icon, cls } = fileIcon(f.path);
        return (
          <div
            key={c.path}
            className={`tree-row ${f.id === props.activeId ? 'active' : ''}`}
            style={pad}
            onClick={() => {
              setSelectedDir('');
              props.onOpen(f);
            }}
            title={f.path}
          >
            <span className="tree-caret" />
            <Icon size={15} className={`file-icon ${cls}`} />
            <span className="tree-name">{c.name}</span>
            {isMain && <Star size={12} className="main-star" aria-label={t('files.mainFile')} />}
            {props.canEdit && (
              <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
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
                      {f.kind === 'text' && f.path.endsWith('.tex') && !isMain && (
                        <MenuItem icon={Star} onClick={() => (close(), props.onSetMain(f))}>
                          {t('files.setMain')}
                        </MenuItem>
                      )}
                      <MenuItem
                        icon={Pencil}
                        onClick={async () => {
                          close();
                          const to = await dialog.prompt(t('files.rename'), f.path);
                          if (to && to !== f.path) props.onRename(f, to.trim());
                        }}
                      >
                        {t('files.rename')}
                      </MenuItem>
                      <MenuItem
                        icon={Trash2}
                        danger
                        onClick={async () => {
                          close();
                          if (await dialog.confirm(t('files.deleteConfirm', { path: f.path }), { danger: true, confirmText: t('common.delete') })) {
                            props.onDelete(f);
                          }
                        }}
                      >
                        {t('common.delete')}
                      </MenuItem>
                    </>
                  )}
                </Dropdown>
              </span>
            )}
          </div>
        );
      }
      const open = !collapsed.has(c.path);
      return (
        <div key={c.path}>
          <div
            className={`tree-row dir ${selectedDir === c.path ? 'active-dir' : ''} ${dropDir === c.path ? 'drop-target' : ''}`}
            style={pad}
            {...dropHandlers(c.path)}
            onClick={() => {
              setSelectedDir(c.path);
              setCollapsed((s) => {
                const next = new Set(s);
                if (open) next.add(c.path);
                else next.delete(c.path);
                return next;
              });
            }}
          >
            <span className="tree-caret">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
            {open ? <FolderOpen size={15} className="file-icon folder" /> : <FolderClosed size={15} className="file-icon folder" />}
            <span className="tree-name">{c.name}</span>
            {props.canEdit && (
              <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
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
                      <MenuItem icon={FilePlus2} onClick={() => (close(), newFile(c.path))}>
                        {t('files.newFileHere')}
                      </MenuItem>
                      <MenuItem icon={FolderPlus} onClick={() => (close(), newFolder(c.path))}>
                        {t('files.newSubfolder')}
                      </MenuItem>
                      <MenuItem icon={Pencil} onClick={() => (close(), renameFolder(c.path))}>
                        {t('files.renameFolder')}
                      </MenuItem>
                      <MenuItem icon={Trash2} danger onClick={() => (close(), deleteFolder(c.path))}>
                        {t('common.delete')}
                      </MenuItem>
                    </>
                  )}
                </Dropdown>
              </span>
            )}
          </div>
          {open && render(c, depth + 1)}
        </div>
      );
    });

  return (
    <div
      className={`file-tree ${dropDir === '' ? 'drop-root' : ''}`}
      {...dropHandlers('')}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as HTMLElement | null)) setDropDir(null);
      }}
    >
      <div className="panel-head">
        <span className="panel-title">{t('files.title')}</span>
        <span className="spacer" />
        {props.canEdit && (
          <>
            <IconButton icon={FilePlus2} label={t('files.newFile')} onClick={() => newFile()} size={15} />
            <IconButton icon={FolderPlus} label={t('files.newFolder')} onClick={() => newFolder()} size={15} />
            <IconButton icon={Upload} label={t('files.upload', { dir: '/' + currentDir })} onClick={() => upload.current?.click()} size={15} />
            <input
              ref={upload}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) props.onUpload(e.target.files, currentDir);
                e.target.value = '';
              }}
            />
          </>
        )}
      </div>
      <div className="tree-body" onClick={(e) => e.target === e.currentTarget && setSelectedDir('')}>
        {render(tree, 0)}
        {props.canEdit && <div className="tree-hint">{t('files.dropHint')}</div>}
      </div>
    </div>
  );
}
