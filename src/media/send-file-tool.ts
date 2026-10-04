/**
 * 内置 qqbot_send_file 工具 — 将文件发送给 QQ 用户或群。
 *
 *   - 发送目标默认自动定位（exec.agent → SessionManager.findByAgent → replyTarget），
 *     无需模型手动传 openid；显式 target 参数作为覆盖。
 *   - 按扩展名分发到 SDK 的 sendImage / sendVideo / sendVoice / sendFile。
 *   - 路径走 `ctx.fs`：模型给的是执行世界的拼写（沙箱部署下 `/workspace/...`），
 *     白名单按同一世界的包含关系判定，字节经 `readBytes` 读出后以 buffer 上传，
 *     宿主进程不需要认识那些路径。
 *   - 路径白名单：默认只允许访问 media 目录 + 会话 cwd，可开关 + 扩展白名单。
 */
import { basename } from 'node:path';
import { CHUNKED_UPLOAD_MAX_SIZE } from '@tencent-connect/qqbot-nodejs';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ImQQBotConfig, SendFileConfig } from '../config.ts';
import type { DshAgent, DshFsLike, SessionManager } from '../session/index.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { worldPath } from '../shared/index.ts';
import { MEDIA_ROOT } from './media-cleaner.ts';

/** 工具名（qqbot 前缀避免与其他通道的同名工具冲突） */
export const SEND_FILE_TOOL_NAME = 'qqbot_send_file';

const DESCRIPTION =
  'Send a file (image, video, voice, or generic file) to the QQ user or group '
  + 'of the current conversation. Pass the path as the workspace spells it — for example '
  + '`/workspace/report.csv` — or a path relative to the session working directory. '
  + 'Use this when the user asks you to deliver a generated file (chart, report, exported data, '
  + 'screenshot, etc.) or to send an existing media/file back to them.';

/** 发送器最小接口（QQBot 实例满足） */
interface MediaSendResult {
  upload: { file_uuid: string };
  message?: { id?: string };
}

export interface MediaSenderLike {
  sendImage(target: ReplyTarget, source: { buffer?: Buffer; localPath?: string }): Promise<MediaSendResult>;
  sendVideo(target: ReplyTarget, source: { buffer?: Buffer; localPath?: string }): Promise<MediaSendResult>;
  sendVoice(target: ReplyTarget, source: { buffer?: Buffer; localPath?: string }): Promise<MediaSendResult>;
  sendFile(target: ReplyTarget, source: { buffer?: Buffer; localPath?: string }, opts?: { fileName?: string }): Promise<MediaSendResult>;
}

/** tools 服务最小接口 */
interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

/** qqbot_send_file 的合法参数 */
interface SendFileArgs {
  file_path: string;
  target?: string;
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
const VOICE_EXTS = new Set(['.mp3', '.wav', '.ogg', '.aac', '.silk', '.amr']);

/** 解析显式 target（"c2c:openid" / "group:openid"），非法返回 undefined */
function parseTarget(input: string): ReplyTarget | undefined {
  const idx = input.indexOf(':');
  if (idx <= 0) return undefined;
  const scope = input.slice(0, idx);
  const targetId = input.slice(idx + 1);
  if (!targetId || (scope !== 'c2c' && scope !== 'group')) return undefined;
  return { scope, targetId };
}

/**
 * 路径白名单校验：restrictPaths 关闭时放行任意路径，否则限定 media + 会话 cwd + extraRoots。
 *
 * 白名单里的宿主目录（media 根目录、配置的额外根目录）先换算成执行世界的名字；会话
 * cwd 本来就是世界拼写，直接当根目录用。这个世界里不存在的宿主目录不可能是任何 target
 * 的祖先，换算不出来就跳过。包含判定用 `fs.contains`，不自己拼字符串。
 */
async function isPathAllowed(
  fs: DshFsLike,
  target: unknown,
  config: SendFileConfig,
  cwd: string,
): Promise<boolean> {
  if (!config.restrictPaths) return true;
  const mapped = [MEDIA_ROOT, ...config.extraRoots]
    .map((root) => fs.processPathFromHostPath(root))
    .filter((root): root is string => root !== undefined);
  for (const root of [cwd, ...mapped]) {
    if (fs.contains(await fs.resolve(root), target)) return true;
  }
  return false;
}

/** 注册 qqbot_send_file 工具（tools 服务缺失时优雅降级，不阻断插件启动） */
export function registerSendFileTool(
  ctx: Context,
  bot: MediaSenderLike,
  manager: SessionManager,
  config: ImQQBotConfig,
  logger: Logger,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，qqbot_send_file 工具未注册');
    return;
  }

  const definition = {
    name: SEND_FILE_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path of the file to send (image/video/voice/generic file), in the workspace spelling; a relative path resolves against the session working directory.',
        },
        target: {
          type: 'string',
          description: 'Optional send target as "c2c:openid" or "group:openid". Omit to send to the current conversation.',
        },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          fileName: { type: 'string' },
          fileSize: { type: 'integer' },
          target: { type: 'string' },
          fileUuid: { type: 'string' },
          messageId: { type: 'string' },
        },
        required: ['fileName', 'fileSize', 'target', 'fileUuid'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { fileName: string; target: string };
        return [{ type: 'text', text: `已发送 ${v.fileName} → ${v.target}` }];
      },
    },
    async execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<Record<string, unknown>> {
      const { file_path, target } = args as SendFileArgs;
      if (typeof file_path !== 'string' || file_path.length === 0) {
        throw new Error('qqbot_send_file: `file_path` must be a non-empty string');
      }

      // 1. 解析发送目标：显式 target > 当前会话（exec.agent → SessionRecord）
      let replyTarget: ReplyTarget | undefined;
      if (target !== undefined && target !== '') {
        replyTarget = parseTarget(target);
        if (replyTarget === undefined) {
          throw new Error(`qqbot_send_file: target 格式错误，需要 c2c:openid 或 group:openid，收到: ${target}`);
        }
      } else if (exec.agent !== undefined) {
        replyTarget = manager.findByAgent(exec.agent as DshAgent)?.replyTarget;
      }
      if (replyTarget === undefined) {
        throw new Error('qqbot_send_file: 无法确定发送目标，请显式传 target 参数');
      }

      // 2. 解析并校验路径：模型给的是执行世界的拼写，经 ctx.fs 解析成 target
      const fs = ctx.get('fs') as DshFsLike | undefined;
      if (fs === undefined) {
        throw new Error('qqbot_send_file: fs 服务不可用，无法解析 file_path');
      }
      const cwd = (exec.agent as DshAgent | undefined)?.session.header?.cwd
        ?? worldPath(ctx, config.cwd || process.cwd());
      const fsTarget = await fs.resolve(file_path, { cwd, signal: exec.signal });
      if (!await isPathAllowed(fs, fsTarget, config.sendFile, cwd)) {
        throw new Error(`qqbot_send_file: file_path 不在允许的目录内: ${fsTarget.displayPath}`);
      }
      const info = await fs.stat(fsTarget, exec.signal);
      if (info === undefined) {
        throw new Error(`qqbot_send_file: 文件不存在: ${fsTarget.displayPath}`);
      }
      if (info.type !== 'file') {
        throw new Error(`qqbot_send_file: 路径不是普通文件: ${fsTarget.displayPath}`);
      }

      // 3. 读字节 + 按扩展名分类发送（SDK 收 buffer，宿主侧不碰执行世界的路径）
      const fileName = basename(fsTarget.displayPath);
      const ext = fsTarget.displayPath.slice(fsTarget.displayPath.lastIndexOf('.')).toLowerCase();
      let buffer: Buffer;
      try {
        buffer = Buffer.from(await fs.readBytes(fsTarget, exec.signal, CHUNKED_UPLOAD_MAX_SIZE));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`qqbot_send_file: 读取文件失败: ${reason}`);
      }
      const fileSize = info.size ?? buffer.length;
      const source = { buffer };

      let result: MediaSendResult;
      if (IMAGE_EXTS.has(ext)) {
        result = await bot.sendImage(replyTarget, source);
      } else if (VIDEO_EXTS.has(ext)) {
        result = await bot.sendVideo(replyTarget, source);
      } else if (VOICE_EXTS.has(ext)) {
        result = await bot.sendVoice(replyTarget, source);
      } else {
        result = await bot.sendFile(replyTarget, source, { fileName });
      }

      logger.info(`im-qqbot: qqbot_send_file 发送 ${fileName} (${fileSize} bytes) → ${replyTarget.scope}:${replyTarget.targetId}`);

      return {
        fileName,
        fileSize,
        target: `${replyTarget.scope}:${replyTarget.targetId}`,
        fileUuid: result.upload.file_uuid,
        ...(result.message?.id !== undefined ? { messageId: result.message.id } : {}),
      };
    },
  };

  tools.register(definition);
  logger.info('im-qqbot: qqbot_send_file 工具已注册');
}
