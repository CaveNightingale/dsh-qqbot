import { describe, it, expect, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { SessionManager } from './session-manager.ts';
import type { DshAgent, DshAgentHandle, DshAgentRegistry } from './types.ts';

/** 部署事实：宿主工作区在执行世界里叫 /workspace */
const HOST_WORKSPACE = '/srv/project';
const WORLD_WORKSPACE = '/workspace';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

/** 只提供 fs 的最小 context；其余服务按缺失处理 */
function contextWith(fs: { processPathFromHostPath(hostPath: string): string | undefined } | undefined): Context {
  return {
    get: (name: string) => (name === 'fs' ? fs : undefined),
    on: () => undefined,
  } as unknown as Context;
}

function configWith(cwd: string): ImQQBotConfig {
  return { appId: 'app-1', appSecret: 'secret', cwd, sessionIdleTimeout: 0 } as unknown as ImQQBotConfig;
}

/** 记录 create 调用并返回一个可用的 handle */
function agentsWith(): { agents: DshAgentRegistry; created: Array<{ sessionId: string; meta?: { cwd?: string } }> } {
  const created: Array<{ sessionId: string; meta?: { cwd?: string } }> = [];
  const agents = {
    get: () => undefined,
    resume: vi.fn(async () => {
      throw new Error('no persisted session');
    }),
    create: vi.fn(async (options: { sessionId: string; meta?: { cwd?: string } }) => {
      created.push(options);
      const agent = { id: options.sessionId, status: 'idle', session: { id: options.sessionId } } as unknown as DshAgent;
      return { agent, dispose: async () => {} } as DshAgentHandle;
    }),
  } as unknown as DshAgentRegistry;
  return { agents, created };
}

describe('SessionManager session cwd', () => {
  it('records the cwd in the execution world the fs maps the host workspace onto', async () => {
    const { agents, created } = agentsWith();
    const manager = new SessionManager(
      contextWith({ processPathFromHostPath: (p) => (p === HOST_WORKSPACE ? WORLD_WORKSPACE : undefined) }),
      agents,
      configWith(HOST_WORKSPACE),
      logger,
    );

    await manager.getOrCreate('c2c', 'peer-1', 'peer-1', { scope: 'c2c', targetId: 'peer-1' });

    expect(created[0]?.meta?.cwd).toBe(WORLD_WORKSPACE);
  });

  it('keeps the configured host directory when no fs service is mounted', async () => {
    const { agents, created } = agentsWith();
    const manager = new SessionManager(contextWith(undefined), agents, configWith(HOST_WORKSPACE), logger);

    await manager.getOrCreate('c2c', 'peer-1', 'peer-1', { scope: 'c2c', targetId: 'peer-1' });

    expect(created[0]?.meta?.cwd).toBe(HOST_WORKSPACE);
  });

  it('derives the same session id for the same peer on every start', async () => {
    const first = agentsWith();
    const second = agentsWith();
    await new SessionManager(contextWith(undefined), first.agents, configWith(HOST_WORKSPACE), logger)
      .getOrCreate('c2c', 'peer-1', 'peer-1', { scope: 'c2c', targetId: 'peer-1' });
    await new SessionManager(contextWith(undefined), second.agents, configWith(HOST_WORKSPACE), logger)
      .getOrCreate('c2c', 'peer-1', 'peer-1', { scope: 'c2c', targetId: 'peer-1' });

    // 身份由 sessionKey 的 SHA-256 派生（裸 UUID 形状，没有 session- 前缀），
    // 同一 peer 重启后落到同一个 session。
    const id = first.created[0]?.sessionId;
    expect(id).toBe(second.created[0]?.sessionId);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
