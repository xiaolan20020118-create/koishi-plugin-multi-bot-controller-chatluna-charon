// src/interceptors/room.ts
import { Context } from 'koishi'
import { BotManager } from '../bot-manager'
import { BotPersonaConfig } from '../types'

/**
 * Room 隔离拦截器
 * 负责为 Bot 创建独立的 template room
 * 注意：ChatLuna 的 chain 对象不直接暴露 room 管理方法
 * 我们使用数据库操作直接管理 room
 */
export class RoomInterceptor {
  private readonly logger: ReturnType<Context['logger']>
  private hooks: Array<() => void> = []

  constructor(
    private ctx: Context,
    private botManager: BotManager,
    private config: {
      autoCreateTemplateRooms: boolean
      debug: boolean
    }
  ) {
    this.logger = ctx.logger('charon:room')
  }

  /**
   * 启动拦截器
   */
  async start(): Promise<void> {
    this.debug('启动 Room 隔离拦截器...')

    // 等待 ChatLuna 加载完成后再设置所有钩子
    const readyDispose = this.ctx.on('chatluna/ready', () => {
      // 监听 bot 状态变化，为新的 bot 创建 template room
      // 在 chatluna/ready 后设置，确保 database 服务已就绪
      const botStatusDispose = this.ctx.on('bot-status-updated', async (bot) => {
        await this.handleBotStatusUpdate(bot)
      })
      this.hooks.push(botStatusDispose)

      this.debug('Room 钩子已安装，bot-status-updated 监听已启用')
    })
    this.hooks.push(readyDispose)
  }

  /**
   * 处理 bot 状态更新
   */
  private async handleBotStatusUpdate(bot: any): Promise<void> {
    const selfId = bot.selfId
    const platform = bot.platform
    const botId = this.botManager.getBotId(platform, selfId)

    const botConfig = this.botManager.getBotConfig(botId)

    if (!botConfig || !botConfig.enabled) {
      return
    }

    // 检查是否已初始化
    const status = this.botManager.getBotStatus(botId)
    if (status?.initialized) {
      return
    }

    // 为 bot 创建 template room
    if (this.config.autoCreateTemplateRooms) {
      await this.createTemplateRoomForBot(botConfig)
    }

    // 标记为已初始化
    this.botManager.setBotStatus(botId, { initialized: true })
  }

  /**
   * 为 bot 创建独立的 template room
   * 直接使用数据库操作，不依赖 chain
   */
  private async createTemplateRoomForBot(botConfig: BotPersonaConfig): Promise<void> {
    const botId = botConfig.botId
    const { selfId } = this.botManager.parseBotId(botId)

    this.debug(`正在为 Bot ${botId} 创建模板房间`)

    try {
      // 检查是否已存在 template room
      const existingRooms = await this.ctx.database.get('chathub_room', {
        roomName: `模板房间_${botId}`,
      })

      if (existingRooms.length > 0) {
        this.debug(`Bot ${botId} 的模板房间已存在，跳过创建`)
        this.botManager.setBotStatus(botId, {
          templateRoomId: existingRooms[0].roomId,
        })
        return
      }

      // 解析预设名称
      const { name: presetName, source } = this.botManager.parsePresetName(botConfig.preset)

      // 对于 character 预设，跳过 template room 创建
      if (source === 'character') {
        this.logger.info(`[CharonRoom] Bot ${botId} 使用 character 预设，跳过 template room 创建`)
        this.botManager.setBotStatus(botId, { initialized: true })
        return
      }

      // 使用 BotManager 的通用方法创建 room
      const newRoom = await this.botManager.createRoom({
        botId,
        roomName: `模板房间_${botId}`,
        roomMasterId: selfId,
        visibility: 'template_clone',
        preset: botConfig.preset,
        model: botConfig.model,
        chatMode: botConfig.chatMode || 'chat',
      })

      this.botManager.setBotStatus(botId, {
        templateRoomId: newRoom.roomId,
      })

      this.logger.info(`已为 Bot ${botId} 创建模板房间: 模板房间_${botId} (roomId: ${newRoom.roomId})`)
    } catch (error) {
      this.logger.error(`为 Bot ${botId} 创建模板房间失败:`, error)
      this.botManager.setBotStatus(botId, {
        error: String(error),
      })
    }
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
