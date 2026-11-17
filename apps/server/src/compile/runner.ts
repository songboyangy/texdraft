import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Engine } from '@texdraft/shared';
import { config } from '../config.js';
import { chownForCompile, compileEnv, sandboxEnabled, sandboxKind, tectonicCacheDir, wrapInSandbox } from './sandbox.js';
import os from 'node:os';

export interface RunSpec {
  srcDir: string; // 物化后的项目文件
  outDir: string; // 编译产物（保留 aux 等中间文件以便增量编译）
  mainFile: string; // 相对 srcDir
  engine: Engine;
  timeoutMs: number;
}

export interface RunOutcome {
  exitCode: number | null;
  timedOut: boolean;
  output: string; // stdout+stderr（截断）
  spawnError?: string;
}

const MAX_OUTPUT = 200_000;

/**
 * 编译执行器：
 *  - local-tectonic：开发默认，宏包按需下载（固定 XeTeX 引擎）
 *  - local-latexmk：本机 TeX Live
 *  - docker：生产推荐，容器内 TeX Live，断网 + 资源限制 + 禁用 shell-escape
 */
export async function runLatex(spec: RunSpec): Promise<RunOutcome> {
  await fs.mkdir(spec.outDir, { recursive: true });
  // \include{sub/x} 需要 outDir 下存在对应子目录
  await mirrorDirs(spec.srcDir, spec.outDir);

  let built: ReturnType<typeof buildCommand>;
  let asUser: { uid: number; gid: number } | undefined;
  try {
    built = buildCommand(spec);
    if (sandboxKind() === 'uid') {
      await chownForCompile(spec.outDir);
      asUser = { uid: config.compile.uid!, gid: config.compile.gid! };
    }
  } catch (e) {
    return { exitCode: null, timedOut: false, output: '', spawnError: (e as Error).message };
  }
  const { cmd, args, env } = built;
  return spawnWithTimeout(cmd, args, spec.srcDir, env, spec.timeoutMs, asUser);
}

function latexmkEngineFlag(engine: Engine) {
  return engine === 'xelatex' ? '-xelatex' : engine === 'lualatex' ? '-lualatex' : '-pdf';
}

function buildCommand(spec: RunSpec): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  switch (config.compile.runner) {
    case 'local-tectonic': {
      const bin = process.env.TECTONIC_BIN || 'tectonic';
      const args = [
        '-X', 'compile', spec.mainFile,
        '--outdir', spec.outDir,
        '--synctex', '--keep-logs', '--keep-intermediates',
        '-Z', 'continue-on-errors',
      ];
      const env = compileEnv('tectonic', bin);
      if (!sandboxEnabled()) return { cmd: bin, args, env };
      // tectonic 需要联网按需下载宏包；宏包缓存与字体缓存可写
      const cacheDirs = [tectonicCacheDir(), path.join(os.homedir(), '.cache', 'fontconfig')];
      return { ...wrapInSandbox(bin, args, { srcDir: spec.srcDir, outDir: spec.outDir, network: true, cacheDirs }), env };
    }
    case 'local-latexmk': {
      const args = [
        // -norc：不读取 latexmkrc（项目里的 latexmkrc 可以包含任意 Perl 代码）
        '-norc', latexmkEngineFlag(spec.engine), '-interaction=nonstopmode', '-file-line-error', '-synctex=1',
        '-latexoption=-no-shell-escape', `-outdir=${spec.outDir}`, spec.mainFile,
      ];
      // 偏执模式只允许读写 TEXMFOUTPUT 下的绝对路径：放行本次的输出目录（.aux / .bbl 等）
      const env = { ...compileEnv('latexmk', 'latexmk'), TEXMFOUTPUT: spec.outDir };
      if (!sandboxEnabled()) return { cmd: 'latexmk', args, env };
      return { ...wrapInSandbox('latexmk', args, { srcDir: spec.srcDir, outDir: spec.outDir, network: false }), env };
    }
    case 'docker': {
      const uid = process.getuid?.() ?? 1000;
      const gid = process.getgid?.() ?? 1000;
      return {
        cmd: 'docker',
        args: [
          'run', '--rm', '--name', `texdraft-compile-${path.basename(path.dirname(spec.srcDir))}`,
          '--network', 'none', '--memory', '2g', '--cpus', '2', '--pids-limit', '256',
          '--read-only', '--tmpfs', '/tmp:size=256m', '-u', `${uid}:${gid}`,
          '-e', 'max_print_line=10000', '-e', 'HOME=/tmp',
          '-v', `${spec.srcDir}:/work/src`, '-v', `${spec.outDir}:/work/out`, '-w', '/work/src',
          config.compile.dockerImage,
          'latexmk', '-norc', latexmkEngineFlag(spec.engine), '-interaction=nonstopmode', '-file-line-error',
          '-synctex=1', '-latexoption=-no-shell-escape', '-outdir=/work/out', spec.mainFile,
        ],
        // docker CLI 只需要自身的配置；服务端密钥不传下去
        env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k === 'PATH' || k === 'HOME' || k.startsWith('DOCKER_'))),
      };
    }
  }
}

function spawnWithTimeout(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, asUser?: { uid: number; gid: number }) {
  return new Promise<RunOutcome>((resolve) => {
    let output = '';
    let timedOut = false;
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...(asUser ?? {}) });
    const onData = (b: Buffer) => {
      if (output.length < MAX_OUTPUT) output += b.toString('utf8').slice(0, MAX_OUTPUT - output.length);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL'); // 杀整个进程组
      } catch {
        child.kill('SIGKILL');
      }
      if (config.compile.runner === 'docker') {
        spawn('docker', ['kill', `texdraft-compile-${path.basename(path.dirname(cwd))}`], { stdio: 'ignore' });
      }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut, output, spawnError: `${cmd}: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, output });
    });
  });
}

async function mirrorDirs(src: string, out: string, rel = '') {
  const entries = await fs.readdir(path.join(src, rel), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isDirectory()) {
      const r = path.join(rel, e.name);
      await fs.mkdir(path.join(out, r), { recursive: true });
      await mirrorDirs(src, out, r);
    }
  }
}
