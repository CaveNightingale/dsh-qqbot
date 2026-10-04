/**
 * 执行世界路径换算
 *
 * 会话 cwd、模型给的路径都是执行世界的拼写：宿主 backend 下与宿主路径相同，
 * 沙箱 / 远端 backend 下是另一套名字（bwrap 部署把工作区绑到 `/workspace`）。
 * 插件手里只有宿主路径（`config.cwd`、media 目录、配置的额外白名单根目录）而需要
 * 用世界的名字登记时，走 `ctx.fs.processPathFromHostPath`，不要自己拼 `process.cwd()`。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { DshFsLike } from '../session/types.ts';

/**
 * 宿主拼写 → 执行世界拼写。
 *
 * 拿不到 fs 服务（宿主未挂载 fs provider）、或这个世界读不到该宿主路径时返回原值，
 * 与没有映射层时的行为一致。
 *
 * @param ctx 插件 context
 * @param hostPath 宿主文件系统里的绝对路径
 * @returns 执行世界里同一个文件的名字
 */
export function worldPath(ctx: Context, hostPath: string): string {
  const fs = ctx.get('fs') as DshFsLike | undefined;
  return fs?.processPathFromHostPath(hostPath) ?? hostPath;
}
