// src/interceptors/chain.ts
import { Context } from 'koishi'
import { BotManager } from '../bot-manager'
import { BotPersonaConfig } from '../types'

/**
 * ChatLuna Chain 中间件运行状态
 * 对应 koishi-plugin-chatluna/chains/chain.ts 中的 ChainMiddlewareRunStatus
 */
enum ChainMiddlewareRunStatus {
  SKIPPED = 0,
  STOP = 1,
  CONTINUE = 2,
}

/**
 * Chain 中间件拦截器
 * 在 ChatLuna 的 resolve_room 之前和之后运行，确保使用 Bot 特定的 room
 *
 * 工作原理：
 * 1. 前置中间件 (charon_resolve_bot_room): 在 resolve_room 之前运行，设置 bot 特定的 room
 * 2. 后置中间件 (charon_fix_room_auto_update): 在 resolve_room 之后运行，修复 autoUpdate 覆盖问题
 */
export class ChainInterceptor {
  private readonly logger: ReturnType<Context['logger']>
  private middlewareDisposes: Array<() => void> = []
  // 保存中间件实例，用于手动移除
  private middlewares: any[] = []

  constructor(
    private ctx: Context,
    private botManager: BotManager,
    private config: {
      debug: boolean
      verboseLogging: boolean
    }
  ) {
    this.logger = ctx.logger('chatluna-charon:chain')
  }

  /**
   * 启动拦截器
   */
  async start(): Promise<void> {
    this.logger.info('启动 Chain 中间件拦截器...')

    // 等待 ChatLuna 加载完成
    this.ctx.on('chatluna/ready', () => {
      this.logger.info('[Charon] 收到 chatluna/ready 事件，开始注册中间件')
      this.setupChainMiddleware()
    })

    // 备用：如果 chatluna/ready 已经触发过，尝试立即注册
    setTimeout(() => {
      this.logger.info('[Charon] 备用检查：尝试立即注册中间件')
      this.setupChainMiddleware()
    }, 5000)
  }

  /**
   * 设置 Chain 中间件
   */
  private setupChainMiddleware(): void {
    // ChatLuna 的 ChatChain 实例在 ctx.chatluna.chatChain
    const chatlunaService = this.ctx.chatluna as any
    const chain = chatlunaService?.chatChain as any

    this.logger.info(`[Charon] ctx.chatluna 存在性检查: ${!!chatlunaService}`)
    this.logger.info(`[Charon] ctx.chatluna.chatChain 存在性检查: ${!!chain}`)

    if (!chain) {
      this.logger.warn('[Charon] ChatLuna chatChain 不可用，无法注册中间件')
      this.logger.warn('[Charon] 请确保 ChatLuna 插件已正确加载')
      return
    }

    this.logger.info('[Charon] 开始注册 chain 中间件...')

    // 手动清除缓存，确保新中间件被包含在 build 结果中
    const graph = (chain as any)._graph
    if (graph && graph._cachedOrder) {
      graph._cachedOrder = null
      this.logger.info('[Charon] 已清除中间件缓存')
    }

    // 注册中间件 1: 在 resolve_room 之前运行
    // 负责识别 bot 并设置 bot 特定的 room
    const beforeMiddleware = chain.middleware(
      'charon_resolve_bot_room',
      async (session: any, context: any) => {
        const selfId = session.bot?.selfId ?? session.selfId
        const platform = session.platform
        const botId = this.botManager.getBotId(platform, selfId)
        const botConfig = this.botManager.getBotConfig(botId)

        // 如果没有为此 bot 配置人设，跳过处理
        if (!botConfig || !botConfig.enabled) {
          return ChainMiddlewareRunStatus.CONTINUE
        }

        // 如果既没有配置 preset 也没有配置 model，跳过拦截
        // 让 ChatLuna 使用默认行为处理
        if (!botConfig.preset && !botConfig.model) {
          return ChainMiddlewareRunStatus.CONTINUE
        }

        // 解析预设名称（处理带来源前缀的情况）
        // 只有当 preset 不为空时才解析，避免空字符串被误解析为有效 preset
        const { name: presetName, source } = botConfig.preset
          ? this.botManager.parsePresetName(botConfig.preset)
          : { name: '', source: undefined }

        // 对于 character 预设，不继续执行 ChatLuna 的 chain
        // character 插件有自己的消息处理系统，会独立处理这些消息
        if (source === 'character') {
          if (this.config.verboseLogging) {
            this.logger.info(`[Charon] Bot ${botId} 使用 character 预设，跳过 ChatLuna`)
          }
          // 配置 character 插件以处理此消息
          await this.configureCharacterPlugin(session, botId, presetName)
          // 返回 STOP 阻止 ChatLuna chain 继续执行
          return ChainMiddlewareRunStatus.STOP
        }

        // 将 bot 配置保存到 context，供后置中间件使用
        context.options.charonBotConfig = {
          botId,
          preset: presetName,
          model: botConfig.model,
          chatMode: botConfig.chatMode || 'chat',
        }

        // 检查是否已经指定了 room（通过命令参数）
        if (context.options?.room_resolve?.name) {
          if (this.config.verboseLogging) {
            this.logger.debug(`[Charon] 已指定 room: ${context.options.room_resolve.name}`)
          }
          // 尝试查找 bot 特定的 room
          const botSpecificRoom = await this.findBotSpecificRoom(
            session,
            context.options.room_resolve.name,
            botId
          )
          if (botSpecificRoom) {
            context.options.room = botSpecificRoom
          }
          return ChainMiddlewareRunStatus.CONTINUE
        }

        // 尝试找到或创建 bot 特定的 room
        const botRoom = await this.getOrCreateBotSpecificRoom(session, botId, botConfig)

        if (botRoom) {
          // 将 room 设置到 context 中
          context.options.room = botRoom
          if (this.config.verboseLogging) {
            this.logger.info(
              `[Charon] ${botId} | 预设:${presetName} | 模型:${botConfig.model} | Room:${botRoom.roomName} (${botRoom.roomId})`
            )
          }
        } else {
          this.logger.error(`[Charon] 无法为 Bot ${botId} 创建 room`)
        }

        return ChainMiddlewareRunStatus.CONTINUE
      }
    )

    beforeMiddleware.before('resolve_room')
    // 保存中间件实例以便后续清理
    this.middlewares.push(beforeMiddleware)

    // 注册中间件 2: 在 resolve_room 之后运行
    // 负责修复 autoUpdate 导致的配置被覆盖问题
    const afterMiddleware = chain.middleware(
      'charon_fix_room_auto_update',
      async (session: any, context: any) => {
        const charonBotConfig = context.options?.charonBotConfig

        if (!charonBotConfig || !context.options?.room) {
          return ChainMiddlewareRunStatus.CONTINUE
        }

        const room = context.options.room
        const botId = charonBotConfig.botId

        // 检查 room 是否属于当前 bot（通过 conversationId 判断，比 roomName 更可靠）
        // conversationId 格式为 bot_{botId}_{uuid}，由 Charon 完全控制
        const isRoomForBot = room.conversationId?.startsWith(`bot_${botId}_`)
        if (!isRoomForBot) {
          // 需要创建或切换到正确的 bot room
          const botConfig = this.botManager.getBotConfig(botId)
          if (botConfig) {
            const correctRoom = await this.getOrCreateBotSpecificRoom(session, botId, botConfig)
            if (correctRoom) {
              context.options.room = correctRoom
              if (this.config.verboseLogging) {
                this.logger.info(`[Charon] Room 不匹配，已切换到: ${correctRoom.roomName}`)
              }
            }
          }
          // 切换后继续执行修复逻辑，不要 return
          // 更新 room 引用，使后续修复逻辑使用切换后的 room
        }

        // 重新获取 room（可能已被切换）
        const currentRoom = context.options.room
        if (!currentRoom) {
          return ChainMiddlewareRunStatus.CONTINUE
        }

        // 修复 autoUpdate 导致的配置被覆盖问题
        this.logger.info(
          `[Charon] 修复检查: charonBotConfig.preset="${charonBotConfig.preset}", currentRoom.preset="${currentRoom.preset}" | ` +
          `charonBotConfig.model="${charonBotConfig.model}", currentRoom.model="${currentRoom.model}"`
        )
        let needsFix = false
        const fixedRoom = { ...currentRoom }

        // 只有当 Charon 配置了具体预设时才覆盖 currentRoom.preset
        // 空字符串表示使用 ChatLuna 默认行为，不应覆盖
        if (charonBotConfig.preset && currentRoom.preset !== charonBotConfig.preset) {
          fixedRoom.preset = charonBotConfig.preset
          needsFix = true
        }

        // 只有当 Charon 配置了具体模型时才覆盖 currentRoom.model
        // 空字符串表示使用 ChatLuna 默认行为，不应覆盖
        if (charonBotConfig.model && currentRoom.model !== charonBotConfig.model) {
          fixedRoom.model = charonBotConfig.model
          needsFix = true
        }

        if (currentRoom.chatMode !== charonBotConfig.chatMode) {
          fixedRoom.chatMode = charonBotConfig.chatMode
          needsFix = true
        }

        // 如果需要修复，更新数据库和 context
        if (needsFix) {
          fixedRoom.updatedTime = new Date()
          await this.ctx.database.upsert('chathub_room', [fixedRoom])
          context.options.room = fixedRoom
          if (this.config.verboseLogging) {
            this.logger.info(`[Charon] 配置已修复: preset=${fixedRoom.preset}, model=${fixedRoom.model}`)
          }
        }

        return ChainMiddlewareRunStatus.CONTINUE
      }
    )

    afterMiddleware.after('resolve_room')
    // 保存中间件实例以便后续清理
    this.middlewares.push(afterMiddleware)

    this.logger.info('[Charon] Chain 中间件注册成功！ (前置 + 后置)')

    // 调试：检查已注册的中间件
    this.logger.info(`[Charon] 当前已注册的中间件数量: ${(chain as any)._graph?._tasks?.size || '未知'}`)
  }

  /**
   * 查找 bot 特定的 room
   */
  private async findBotSpecificRoom(
    _session: any,
    roomName: string,
    botId: string
  ): Promise<any> {
    // 注意：ChatLuna 的 chathub_room 表没有 botId 字段
    // 我们通过检查 roomName 是否包含 botId 来验证
    const rooms = await this.ctx.database.get('chathub_room', {
      roomName,
    })

    if (rooms.length > 0) {
      const room = rooms[0]
      // 验证 room 是否属于指定的 bot
      if (room.roomName?.includes(`(${botId})`)) {
        return room
      }
    }

    return null
  }

  /**
   * 获取或创建 bot 特定的 room
   */
  private async getOrCreateBotSpecificRoom(
    session: any,
    botId: string,
    botConfig: BotPersonaConfig
  ): Promise<any> {
    const userId = session.userId
    const guildId = session.guildId
    const isDirect = !guildId

    // 1. 首先尝试查询用户已加入的 bot 特定 room
    const userRooms = await this.ctx.database.get('chathub_room_member', {
      userId,
    })

    if (userRooms.length > 0) {
      const roomIds = userRooms.map((r) => r.roomId)

      // 获取这些 room 的详细信息
      // 注意：ChatLuna 的 chathub_room 表没有 botId 字段，我们需要过滤 roomName
      const allRooms = await this.ctx.database.get('chathub_room', {
        roomId: { $in: roomIds },
      })
      // 过滤出属于当前 bot 的 room（通过 roomName 判断）
      const rooms = allRooms.filter((r: any) => r.roomName?.includes(`(${botId})`))

      // 优先选择符合当前场景的 room
      let selectedRoom: any

      if (!isDirect) {
        // 群聊：优先选择 template_clone 或 public room
        const groupRooms = await this.ctx.database.get('chathub_room_group_member', {
          groupId: guildId,
          roomId: { $in: roomIds },
        })

        const groupRoomIds = new Set(groupRooms.map((r: any) => r.roomId))

        selectedRoom = rooms.find((r: any) =>
          groupRoomIds.has(r.roomId) && r.visibility === 'template_clone'
        ) || rooms.find((r: any) =>
          groupRoomIds.has(r.roomId)
        )
      } else {
        // 私聊：优先选择 private room
        selectedRoom = rooms.find((r: any) =>
          r.visibility === 'private' && r.roomMasterId === userId
        ) || rooms.find((r: any) =>
          r.visibility === 'private'
        ) || rooms[0]
      }

      if (selectedRoom) {
        this.debug(`找到已存在的 Bot ${botId} room: ${selectedRoom.roomName}`)
        return selectedRoom
      }
    }

    // 2. 如果没有找到，创建新的 bot 特定 room
    this.debug(`未找到 Bot ${botId} 的现有 room，准备创建新 room`)
    return await this.createBotSpecificRoom(session, botId, botConfig)
  }

  /**
   * 创建 bot 特定的 room
   */
  private async createBotSpecificRoom(
    session: any,
    botId: string,
    botConfig: BotPersonaConfig
  ): Promise<any> {
    const userId = session.userId
    const guildId = session.guildId
    const isDirect = !guildId
    const username = session.username || session.userId

    // 解析预设名称
    const { name: presetName } = this.botManager.parsePresetName(botConfig.preset)

    // 构建 roomName
    const roomName = isDirect
      ? `${username} (${botId})`
      : `${session.event?.guild?.name || username} (${botId})`

    // 使用 BotManager 的通用方法创建 room
    this.logger.info(`[Charon] 创建 room 配置: botId=${botId}, preset="${botConfig.preset}", model="${botConfig.model}"`)
    const newRoom = await this.botManager.createRoom({
      botId,
      roomName,
      roomMasterId: userId,
      guildId,
      visibility: isDirect ? 'private' : 'template_clone',
      preset: botConfig.preset,
      model: botConfig.model,
      chatMode: botConfig.chatMode || 'chat',
    })
    this.logger.info(`[Charon] room 已创建: roomId=${newRoom.roomId}, room.model="${newRoom.model}", room.preset="${newRoom.preset}"`)

    // 创建用户默认 room 记录（chain.ts 特有逻辑）
    try {
      await this.ctx.database.create('chathub_user', {
        userId,
        groupId: isDirect ? '0' : guildId,
        defaultRoomId: newRoom.roomId,
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
        this.logger.debug(`[Charon前置] chathub_user 记录已存在，跳过创建`)
      } else {
        this.logger.warn(`[Charon前置] 创建 chathub_user 记录失败:`, error)
      }
    }

    if (this.config.verboseLogging) {
      this.logger.info(`[Charon] 创建 room: ${newRoom.roomName} (${newRoom.roomId}) | 预设:${presetName}`)
    }

    return newRoom
  }

  /**
   * 配置 character 插件以处理当前消息
   * 当使用 character 预设时，需要配置 character 插件的 applyGroup 和 preset
   */
  private async configureCharacterPlugin(
    session: any,
    _botId: string,
    presetName: string
  ): Promise<void> {
    const characterPlugin = this.ctx.chatluna_character
    if (!characterPlugin) {
      return
    }

    const guildId = session.guildId || session.channelId || 'private'
    const characterConfig = (characterPlugin as any)._config

    if (!characterConfig) {
      return
    }

    // 确保 applyGroup 数组存在
    if (!Array.isArray(characterConfig.applyGroup)) {
      characterConfig.applyGroup = []
    }

    // 将当前群组添加到白名单（如果还没有）
    if (!characterConfig.applyGroup.includes(guildId)) {
      characterConfig.applyGroup.push(guildId)
    }

    // 配置该群组使用的 character preset
    if (!characterConfig.configs) {
      characterConfig.configs = {}
    }
    if (!characterConfig.configs[guildId]) {
      characterConfig.configs[guildId] = {}
    }

    characterConfig.configs[guildId].preset = presetName
  }

  /**
   * 停止拦截器
   */
  stop(): void {
    this.logger.info('[Charon] ChainInterceptor 正在停止...')

    const chatlunaService = this.ctx.chatluna as any
    const chain = chatlunaService?.chatChain as any

    if (chain) {
      const removedNames: string[] = []

      // 清理方式：从 graph._tasks 中删除中间件
      // 根据日志验证，这是唯一有效的方式
      try {
        const graph = chain._graph
        if (graph?._tasks) {
          for (const middleware of this.middlewares) {
            const name = middleware.name
            if (name && graph._tasks.has(name)) {
              graph._tasks.delete(name)
              removedNames.push(name)
            }
          }

          // 清除缓存，强制重新计算依赖图
          if (graph._cachedOrder) {
            graph._cachedOrder = null
          }
        }

        if (removedNames.length > 0) {
          this.logger.info(`[Charon] 已移除中间件: ${removedNames.join(', ')}`)
        } else {
          this.logger.warn('[Charon] 未找到已注册的中间件')
        }
      } catch (error) {
        this.logger.warn('[Charon] 清理中间件时出错:', error)
      }
    } else {
      this.logger.info('[Charon] ChatLuna chain 不可用，跳过中间件清理')
    }

    // 调用其他 dispose 函数
    for (const dispose of this.middlewareDisposes) {
      try {
        if (typeof dispose === 'function') {
          dispose()
        }
      } catch (error) {
        this.logger.warn('[Charon] 调用 dispose 函数时出错:', error)
      }
    }

    this.middlewareDisposes = []
    this.middlewares = []

    this.logger.info('[Charon] ChainInterceptor 已停止')
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
