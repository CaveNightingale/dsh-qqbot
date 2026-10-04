import { describe, it, expect, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { ImQQBotConfig } from '../config.ts';
import type { DshFsLike, SessionManager } from '../session/index.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { registerSendFileTool } from './send-file-tool.ts';

/** 部署事实：宿主工作区与 media 目录在执行世界里叫这两个名字 */
const HOST_WORKSPACE = '/srv/project';
const WORLD_WORKSPACE = '/workspace';
const WORLD_MEDIA = '/spill/media';

/** 只认世界拼写的 fs：宿主目录经 processPathFromHostPath 换算后才认得 */
function fakeFs(files: Record<string, Uint8Array>): DshFsLike {
  return {
    async resolve(path, opts) {
      const cwd = opts?.cwd ?? WORLD_WORKSPACE;
      const displayPath = path.startsWith('/') ? path : `${cwd}/${path}`;
      return { targetKey: displayPath, displayPath };
    },
    async stat(target) {
      const data = files[(target as { targetKey: string }).targetKey];
      return data === undefined ? undefined : { type: 'file', size: data.length };
    },
    async readBytes(target) {
      const data = files[(target as { targetKey: string }).targetKey];
      if (data === undefined) throw new Error('FS_NOT_FOUND');
      return data;
    },
    contains(parent, child) {
      const root = (parent as { targetKey: string }).targetKey;
      const leaf = (child as { targetKey: string }).targetKey;
      return leaf === root || leaf.startsWith(`${root}/`);
    },
    processPathFromHostPath(hostPath) {
      if (hostPath === HOST_WORKSPACE) return WORLD_WORKSPACE;
      if (hostPath.startsWith(`${HOST_WORKSPACE}/`)) return hostPath.replace(HOST_WORKSPACE, WORLD_WORKSPACE);
      if (hostPath === '/home/user/.dsh-qqbot/media') return WORLD_MEDIA;
      return undefined;
    },
  };
}

interface Harness {
  readonly execute: (args: unknown, agentCwd?: string) => Promise<Record<string, unknown>>;
  readonly sendFile: ReturnType<typeof vi.fn>;
  readonly sendImage: ReturnType<typeof vi.fn>;
}

function harness(options: {
  files?: Record<string, Uint8Array>;
  restrictPaths?: boolean;
  extraRoots?: string[];
} = {}): Harness {
  const files = options.files ?? { [`${WORLD_WORKSPACE}/report.csv`]: new Uint8Array([1, 2, 3]) };
  const fs = fakeFs(files);
  const sendFile = vi.fn(async () => ({ upload: { file_uuid: 'uuid-file' }, message: { id: 'msg-file' } }));
  const sendImage = vi.fn(async () => ({ upload: { file_uuid: 'uuid-image' }, message: { id: 'msg-image' } }));
  const bot = {
    sendFile,
    sendImage,
    sendVideo: vi.fn(),
    sendVoice: vi.fn(),
  };
  let definition: { execute: (args: unknown, exec: { signal: AbortSignal; agent?: unknown }) => Promise<Record<string, unknown>> } | undefined;
  const ctx = {
    get: (name: string) => {
      if (name === 'tools') return { register: (def: unknown) => { definition = def as typeof definition; } };
      if (name === 'fs') return fs;
      return undefined;
    },
  } as unknown as Context;
  const manager = {
    findByAgent: () => ({ replyTarget: { scope: 'c2c', targetId: 'peer-1' } as ReplyTarget }),
  } as unknown as SessionManager;
  const config = {
    cwd: HOST_WORKSPACE,
    sendFile: { restrictPaths: options.restrictPaths ?? true, extraRoots: options.extraRoots ?? [] },
  } as unknown as ImQQBotConfig;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

  registerSendFileTool(ctx, bot, manager, config, logger);
  if (definition === undefined) throw new Error('tool was not registered');

  return {
    execute: (args, agentCwd = WORLD_WORKSPACE) => definition!.execute(args, {
      signal: new AbortController().signal,
      agent: { session: { header: { cwd: agentCwd } } },
    }),
    sendFile,
    sendImage,
  };
}

describe('qqbot_send_file', () => {
  it('reads the file through ctx.fs and uploads its bytes', async () => {
    const h = harness();

    const result = await h.execute({ file_path: 'report.csv' });

    // 上传的是字节，不是宿主路径：宿主进程不需要认识执行世界的名字
    const source = h.sendFile.mock.calls[0]?.[1] as { buffer?: Buffer; localPath?: string };
    expect(source.localPath).toBeUndefined();
    expect(Buffer.isBuffer(source.buffer)).toBe(true);
    expect(Array.from(source.buffer ?? [])).toEqual([1, 2, 3]);
    expect(h.sendFile.mock.calls[0]?.[2]).toEqual({ fileName: 'report.csv' });
    expect(result).toMatchObject({ fileName: 'report.csv', fileSize: 3, target: 'c2c:peer-1', fileUuid: 'uuid-file', messageId: 'msg-file' });
  });

  it('accepts an absolute path in the workspace spelling and dispatches images by extension', async () => {
    const h = harness({ files: { [`${WORLD_WORKSPACE}/shot.png`]: new Uint8Array([0x89, 0x50]) } });

    await h.execute({ file_path: `${WORLD_WORKSPACE}/shot.png` });

    expect(h.sendImage).toHaveBeenCalledTimes(1);
    expect(h.sendFile).not.toHaveBeenCalled();
  });

  it('refuses a path outside the session workspace', async () => {
    const h = harness({ files: { '/etc/passwd': new Uint8Array([1]) } });

    await expect(h.execute({ file_path: '/etc/passwd' })).rejects.toThrow(/不在允许的目录内: \/etc\/passwd/);
    expect(h.sendFile).not.toHaveBeenCalled();
  });

  it('allows a configured host root once it maps into the execution world', async () => {
    const h = harness({
      files: { [`${WORLD_MEDIA}/downloaded.png`]: new Uint8Array([1]) },
      extraRoots: ['/home/user/.dsh-qqbot/media'],
    });

    await h.execute({ file_path: `${WORLD_MEDIA}/downloaded.png` });

    expect(h.sendImage).toHaveBeenCalledTimes(1);
  });

  it('reports a missing file and a non-file target in the workspace spelling', async () => {
    const h = harness();

    await expect(h.execute({ file_path: 'missing.csv' })).rejects.toThrow(/文件不存在: \/workspace\/missing.csv/);
  });

  it('leaves the path unrestricted when restrictPaths is off', async () => {
    const h = harness({ files: { '/etc/hosts': new Uint8Array([7]) }, restrictPaths: false });

    const result = await h.execute({ file_path: '/etc/hosts' });

    expect(result.fileName).toBe('hosts');
  });
});
