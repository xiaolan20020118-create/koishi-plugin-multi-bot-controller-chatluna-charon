// src/interceptors/memory.ts
import { Context } from 'koishi'
import { BotManager } from '../bot-manager'

/**
 * 长期记忆隔离拦截器
 * 负责拦截 long-memory 事件，注入 botId 以实现记忆隔离
 *
 * 注意：chatluna-long-memory 原生支持对不同预设隔离记忆，
 * 通过修改 conversationId 和 userId/guildId 即可实现多 bot 隔离。
 */
export class MemoryInterceptor {
  private readonly logger: ReturnType<Context['logger']>
  private hooks: Array<() => void> = []

  constructor(
    private ctx: Context,
    private botManager: BotManager,
    private config: {
      isolateLongMemory: boolean
      debug: boolean
    }
  ) {
    this.logger = ctx.logger('chatluna-charon:memory')
  }

  /**
   * 启动拦截器
   */
  async start(): Promise<void> {
    this.debug('启动记忆隔离拦截器...')

    // 检查 chatluna-long-memory 是否可用
    const hasLongMemory = !!this.ctx.get('chatluna_long_memory')

    if (!hasLongMemory) {
      this.logger.info('chatluna-long-memory 不可用，跳过记忆隔离')
      return
    }

    // 监听 long-memory 的初始化事件
    this.setupMemoryHooks()

    this.debug('记忆隔离拦截器已启动')
  }

  /**
   * 设置内存钩子
   *
   * 注意：ChainInterceptor 已经在创建 room 时设置了正确的 conversationId
   * （格式: bot_{platform}:{selfId}_{uuid}），所以这里无需再次修改 conversationId。
   *
   * 我们只保留 chatluna-long-memory/init-layer 事件处理，
   * 用于隔离长期记忆的 userId/guildId。
   */
  private setupMemoryHooks(): void {
    // 监听 long-memory 的初始化层事件
    // 这部分保留用于隔离长期记忆的 userId/guildId
    const dispose = this.ctx.on('chatluna-long-memory/init-layer', (layerConfig: any) => {
      if (!this.config.isolateLongMemory) {
        return
      }

      const session = layerConfig.session
      const botId = session?.bot?.selfId ?? session?.selfId

      if (!botId) {
        return
      }

      // 修改记忆层的键，加入 botId
      const originalUserId = layerConfig.userId
      const originalGuildId = layerConfig.guildId

      if (originalUserId) {
        layerConfig.userId = `${botId}_${originalUserId}`
      }

      if (originalGuildId) {
        layerConfig.guildId = `${botId}_${originalGuildId}`
      }

      this.debug(`Memory layer isolated: userId=${originalUserId} -> ${layerConfig.userId}`)
    })
    this.hooks.push(dispose)
  }

  /**
   * 停止拦截器
   */
  stop(): void {
    for (const dispose of this.hooks) {
      dispose()
    }
    this.hooks = []
  }

  /**
   * 输出调试日志
   */
  private debug(...args: unknown[]): void {
    if (this.config.debug) {
      this.logger.debug(args as any)
    }
  }
}
