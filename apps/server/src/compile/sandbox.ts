import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';

/**
 * 编译沙箱（bubblewrap）：LaTeX 文档是不可信输入，\input{/绝对路径} 之类可以读取编译进程能读的任何文件。
 * 用 bwrap 为每次编译创建一个只包含系统运行库、TeX 工具链、宏包/字体缓存和当前项目目录的文件系统视图：
 *  - 看不到服务端代码与 .env、其他项目、用户主目录（SSH 密钥等）、宿主 /tmp
 *  - 项目源码只读，只有输出目录可写
 *  - 独立的 PID / IPC / UTS 命名空间，随服务进程退出；latexmk 另外断网（tectonic 需要联网下载宏包）
 * 环境变量也只传白名单，服务端的密钥（API Key、SESSION_SECRET、DATABASE_URL…）不会进入编译进程。
 *
 * COMPILE_SANDBOX：auto（默认，有 bwrap 就用，否则告警后裸跑）| bwrap（必须，没有就拒绝编译）| none
 */

let probed: boolean | null = null;

export function bwrapAvailable(): boolean {
  if (probed === null) {
    const r = spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', '--die-with-parent', 'true'], { stdio: 'ignore', timeout: 5000 });
    probed = r.status === 0;
  }
  return probed;
}

export type SandboxKind = 'bwrap' | 'uid' | 'none';

const isRoot = () => process.getuid?.() === 0;
const uidConfigured = () => config.compile.uid !== null;

/**
 * 本次编译使用的隔离方式：
 *  - bwrap：bubblewrap 文件系统视图（普通 Linux 主机）
 *  - uid：服务以 root 运行时切换到无特权的编译用户（COMPILE_UID），读不到服务进程的环境变量与 0700 的数据目录。
 *         用于 docker 镜像（容器默认 seccomp 不允许 bwrap 创建命名空间）
 *  - none：不隔离
 * 要求的方式不可用时抛错（拒绝编译）。
 */
export function sandboxKind(): SandboxKind {
  if (config.compile.runner === 'docker') return 'none';
  const mode = config.compile.sandbox;
  if (mode === 'none') return 'none';
  if (mode === 'bwrap') {
    if (!bwrapAvailable()) throw new Error('COMPILE_SANDBOX=bwrap but bubblewrap is not usable on this host (install bubblewrap and allow unprivileged user namespaces).');
    return 'bwrap';
  }
  if (mode === 'uid') {
    if (!isRoot() || !uidConfigured()) throw new Error('COMPILE_SANDBOX=uid requires the server to run as root with COMPILE_UID set.');
    return 'uid';
  }
  if (bwrapAvailable()) return 'bwrap';
  if (isRoot() && uidConfigured()) return 'uid';
  return 'none';
}

export function sandboxEnabled(): boolean {
  return sandboxKind() === 'bwrap';
}

/** 启动时报告沙箱状态（未启用时明确告警） */
export function describeSandbox(): { enabled: boolean; message: string } {
  if (config.compile.runner === 'docker') return { enabled: true, message: 'compile runs in docker (isolated container)' };
  let kind: SandboxKind;
  try {
    kind = sandboxKind();
  } catch (e) {
    return { enabled: false, message: `${(e as Error).message} Compiles will be refused.` };
  }
  if (kind === 'bwrap') return { enabled: true, message: 'compile sandbox: bubblewrap' };
  if (kind === 'uid') return { enabled: true, message: `compile sandbox: unprivileged user ${config.compile.uid}:${config.compile.gid}` };
  if (config.compile.sandbox === 'none') {
    return { enabled: false, message: 'COMPILE_SANDBOX=none: LaTeX documents can read any file this server can read. Only use this for single-user setups.' };
  }
  return { enabled: false, message: 'no compile sandbox available: compiles are NOT isolated (LaTeX can read server files such as .env). Install bubblewrap, run the docker image, or use COMPILE_RUNNER=docker.' };
}

/** uid 模式：数据目录只开放编译所需的路径（目录 0711 可穿过不可列出；对象存储等 0700） */
export async function prepareUidSandboxDirs() {
  const { promises: fs } = await import('node:fs');
  const dataDir = config.dataDir;
  await fs.mkdir(path.join(dataDir, 'compile'), { recursive: true });
  await fs.chmod(dataDir, 0o711);
  await fs.chmod(path.join(dataDir, 'compile'), 0o711);
  for (const d of ['blobs', 'agent-workspaces']) {
    await fs.mkdir(path.join(dataDir, d), { recursive: true });
    await fs.chmod(path.join(dataDir, d), 0o700);
  }
}

/** uid 模式：把输出目录交给编译用户（源码目录保持 root 所有、只读） */
export async function chownForCompile(dir: string) {
  const { promises: fs } = await import('node:fs');
  const uid = config.compile.uid!;
  const gid = config.compile.gid!;
  const walk = async (p: string) => {
    await fs.lchown(p, uid, gid);
    const st = await fs.lstat(p);
    if (st.isDirectory()) for (const e of await fs.readdir(p)) await walk(path.join(p, e));
  };
  await walk(dir);
}

/** 在 PATH 中找到的命令位置（不解析符号链接） */
const findBin = (bin: string) => {
  if (bin.includes('/')) return bin;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const p = path.join(dir, bin);
    if (dir && existsSync(p)) return p;
  }
  return bin;
};

/** 命令的真实位置（解析符号链接），用于确定工具链前缀 */
const resolveBin = (bin: string) => {
  const found = findBin(bin);
  return found.includes('/') ? realpathSync(found) : found;
};

/** 工具链所在前缀（如 conda 环境、/usr/local/texlive/2025）：只读挂入沙箱 */
function toolchainRoots(bin: string): string[] {
  const real = resolveBin(bin);
  if (!real.startsWith('/') || real.startsWith('/usr/') || real.startsWith('/bin/')) return [];
  // …/bin/x → 前缀；TeX Live 是 …/bin/<arch>/x
  let prefix = path.dirname(path.dirname(real));
  if (path.basename(prefix) === 'bin') prefix = path.dirname(prefix);
  return [prefix];
}

const HOME = os.homedir();
export const tectonicCacheDir = () => process.env.TECTONIC_CACHE_DIR || path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'tectonic');

/** 传给编译进程的环境变量白名单 */
export function compileEnv(kind: 'tectonic' | 'latexmk', bin: string): NodeJS.ProcessEnv {
  const pick = (names: string[]) => Object.fromEntries(names.filter((n) => process.env[n] !== undefined).map((n) => [n, process.env[n]]));
  // 用找到命令的目录，而不是符号链接指向的目录：TeX Live 的 bin/<arch>/latexmk 链接到
  // texmf-dist/scripts/latexmk/latexmk.pl，那里没有 pdflatex 等程序
  const found = findBin(bin);
  const binDir = path.dirname(found.includes('/') ? found : resolveBin(bin));
  const env: NodeJS.ProcessEnv = {
    PATH: [binDir, '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    // uid 模式下编译用户无法访问 root 的主目录：用可写的临时目录（luatex 字体缓存等）
    HOME: isRoot() && uidConfigured() ? os.tmpdir() : HOME,
    LANG: process.env.LANG || 'C.UTF-8',
    ...pick(['LC_ALL', 'TZ', 'SOURCE_DATE_EPOCH', 'FONTCONFIG_FILE', 'FONTCONFIG_PATH', 'TEXMFHOME', 'TEXMFVAR', 'TEXMFCNF']),
    max_print_line: '10000',
    error_line: '254',
    half_error_line: '238',
  };
  if (kind === 'tectonic') {
    // 宏包按需下载：需要代理设置；缓存目录显式指定
    Object.assign(env, pick(['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY']));
    env.TECTONIC_CACHE_DIR = tectonicCacheDir();
  } else {
    // kpathsea：不允许读写当前目录树以外的文件，禁用 shell escape（即使没有沙箱也生效）
    env.openin_any = 'p';
    env.openout_any = 'p';
    env.shell_escape = 'f';
  }
  return env;
}

/** 用 bwrap 包装一条编译命令 */
export function wrapInSandbox(
  cmd: string,
  args: string[],
  opts: { srcDir: string; outDir: string; network: boolean; cacheDirs?: string[] },
): { cmd: string; args: string[] } {
  const b: string[] = [];
  const ro = (p: string) => b.push('--ro-bind-try', p, p);
  for (const p of ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32']) ro(p);
  // /etc 只挂运行所需的条目
  for (const p of ['/etc/ssl', '/etc/ca-certificates', '/etc/pki', '/etc/fonts', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/localtime', '/etc/passwd', '/etc/group', '/etc/texmf', '/etc/alternatives', '/etc/ld.so.cache']) ro(p);
  for (const p of ['/var/cache/fontconfig', '/var/lib/texmf', '/usr/local/texlive', '/opt/texlive', ...config.compile.sandboxExtraRo]) ro(p);
  for (const root of toolchainRoots(cmd)) ro(root);
  b.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', HOME);
  for (const dir of opts.cacheDirs ?? []) {
    mkdirSync(dir, { recursive: true });
    b.push('--bind', dir, dir);
  }
  b.push('--ro-bind', opts.srcDir, opts.srcDir, '--bind', opts.outDir, opts.outDir, '--chdir', opts.srcDir);
  b.push('--unshare-all', ...(opts.network ? ['--share-net'] : []), '--die-with-parent', '--new-session', '--hostname', 'texdraft-compile');
  return { cmd: 'bwrap', args: [...b, '--', cmd, ...args] };
}
