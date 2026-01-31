// src/bot-manager.ts
import { Context } from 'koishi'
import { randomUUID } from 'crypto'
import { BotPersonaConfig, BotStatus, PresetWithSource, PresetSource } from './types'
import { updatePresetOptions } from './config'

/**
 * Bot 管理器
 * 负责从 multi-bot-controller 同步配置，管理 bot 的人设和状态
 */
export class BotManager {
  private readonly logger: ReturnType<Context['logger']>
  private readonly botStatusMap: Map<string, BotStatus> = new Map()
  private readonly presetCache: Map<string, PresetWithSource[]> = new Map()

  constructor(
    private ctx: Context,
    private config: BotPersonaConfig[],
    private options: {
      debug: boolean
      verboseLogging: boolean
    }
  ) {
    this.logger = ctx.logger('chatluna-charon')
  }

  /**
   * 解析 botId 为 platform 和 selfId
   */
  parseBotId(botId: string): { platform: string; selfId: string } {
    const [platform, selfId] = botId.split(':', 2)
    return { platform, selfId }
  }

  /**
   * 生成 bot 特定的 conversationId
   * 格式: bot_{platform}:{selfId}_{uuid}，确保每个 bot 有独立的上下文
   */
  generateConversationId(botId: string): string {
    return `bot_${botId}_${randomUUID()}`
  }

  /**
   * 生成 bot 的唯一标识符
   */
  getBotId(platform: string, selfId: string): string {
    return `${platform}:${selfId}`
  }

  /**
   * 从 BotPersonaConfig 获取 botId
   */
  getBotIdFromConfig(config: BotPersonaConfig): string {
    return config.botId
  }

  /**
   * 获取 bot 的人设配置
   */
  getBotConfig(botId: string): BotPersonaConfig | undefined {
    return this.config.find(bot => bot.botId === botId)
  }

  /**
   * 通过 platform 和 selfId 获取 bot 配置
   */
  getBotConfigByPlatform(platform: string, selfId: string): BotPersonaConfig | undefined {
    const botId = this.getBotId(platform, selfId)
    return this.getBotConfig(botId)
  }

  /**
   * 获取所有 bot 配置
   */
  getConfig(): BotPersonaConfig[] {
    return this.config
  }

  /**
   * 获取 bot 的运行时状态
   */
  getBotStatus(botId: string): BotStatus | undefined {
    return this.botStatusMap.get(botId)
  }

  /**
   * 获取 bot 的运行时状态（通过 platform 和 selfId）
   */
  getBotStatusByPlatform(platform: string, selfId: string): BotStatus | undefined {
    return this.botStatusMap.get(this.getBotId(platform, selfId))
  }

  /**
   * 设置 bot 的运行时状态
   */
  setBotStatus(botId: string, status: Partial<BotStatus>): void {
    const current = this.botStatusMap.get(botId) || {
      botId,
      platform: this.parseBotId(botId).platform,
      initialized: false,
    }
    this.botStatusMap.set(botId, Object.assign({}, current, status))
    this.debug(`Bot ${botId} 状态已更新:`, status)
  }

  /**
   * 获取所有已启用的 bot 配置
   */
  getEnabledBots(): BotPersonaConfig[] {
    return this.config.filter(bot => bot.enabled)
  }

  /**
   * 获取所有 bot 的运行时状态
   */
  getAllBotStatus(): BotStatus[] {
    return Array.from(this.botStatusMap.values())
  }

  /**
   * 加载可用的预设列表
   * 自动检测 ChatLuna 和 character 插件，从所有启用的来源加载预设
   * @param silent 是否静默加载（不输出日志）
   * @param force 是否强制更新（跳过缓存检查）
   */
  async loadPresets(silent = false, force = false): Promise<void> {
    const presets: PresetWithSource[] = []

    // 1. 从 ChatLuna 加载预设
    await this.loadChatLunaPresets(presets)

    // 2. 从 character 加载预设（如果插件已启用）
    await this.loadCharacterPresets(presets)

    // 检查是否有变化（force 模式下跳过检查）
    if (!force) {
      const oldPresets = this.presetCache.get('all') || []
      const oldKeys = oldPresets.map(p => p.name).sort().join(',')
      const newKeys = presets.map(p => p.name).sort().join(',')

      if (oldKeys === newKeys) {
        this.debug('预设列表无变化，跳过更新')
        return
      }
    }

    // 缓存结果
    this.presetCache.set('all', presets)

    // 更新配置界面的预设选项
    updatePresetOptions(this.ctx, presets)

    if (!silent) {
      const chatlunaCount = presets.filter(p => p.source === PresetSource.ChatLuna).length
      const characterCount = presets.filter(p => p.source === PresetSource.Character).length

      this.logger.info(
        `已加载 ${presets.length} 个预设 ` +
        `(ChatLuna: ${chatlunaCount}, character: ${characterCount})`
      )
    }
  }

  /**
   * 从 ChatLuna 加载预设
   */
  private async loadChatLunaPresets(presets: PresetWithSource[]): Promise<void> {
    try {
      const presetService = this.ctx.chatluna?.preset
      if (!presetService) {
        this.debug('ChatLuna 预设服务不可用')
        return
      }

      const allPresets = presetService.getAllPreset(true).value || []
      for (const preset of allPresets) {
        // 只使用第一个触发词（逗号分隔）
        const firstKeyword = preset.split(',')[0].trim()
        presets.push({
          name: `chatluna:${firstKeyword}`,
          label: `ChatLuna：${firstKeyword}`,
          source: PresetSource.ChatLuna,
        })
      }

      this.debug(`已加载 ${allPresets.length} 个 ChatLuna 预设`)
    } catch (error) {
      this.logger.warn('加载 ChatLuna 预设失败:', error)
    }
  }

  /**
   * 从 character 加载预设
   */
  private async loadCharacterPresets(presets: PresetWithSource[]): Promise<void> {
    try {
      const characterService = (this.ctx as any).chatluna_character
      if (!characterService?.preset) {
        this.debug('character 插件未启用')
        return
      }

      const characterPresets = await characterService.preset.getAllPreset()
      if (!characterPresets || characterPresets.length === 0) {
        this.debug('character 预设目录为空')
        return
      }

      for (const name of characterPresets) {
        presets.push({
          name: `character:${name}`,
          label: `character：${name}`,
          source: PresetSource.Character,
        })
      }

      this.debug(`已加载 ${characterPresets.length} 个 character 预设`)
    } catch (error: any) {
      // 细化错误处理，区分暂时性错误和永久性错误
      const errorMessage = error?.message || String(error)

      // 暂时性错误：插件尚未完全初始化，静默处理
      if (errorMessage.includes('INACTIVE_EFFECT') ||
          errorMessage.includes('302') ||
          errorMessage.includes('not ready') ||
          errorMessage.includes('initialization')) {
        this.debug(`character 插件尚未就绪 (${errorMessage})，将在之后重试`)
        return
      }

      // 权限错误：可能是文件系统权限问题，输出警告
      if (errorMessage.includes('EACCES') ||
          errorMessage.includes('permission') ||
          errorMessage.includes('EPERM')) {
        this.logger.warn(`character 预设目录权限不足: ${errorMessage}`)
        return
      }

      // 文件系统错误：目录不存在或配置错误
      if (errorMessage.includes('ENOENT') ||
          errorMessage.includes('not found') ||
          errorMessage.includes('directory')) {
        this.logger.warn(`character 预设目录配置错误: ${errorMessage}`)
        return
      }

      // 未知错误：记录详细信息便于调试
      this.debug(`加载 character 预设失败: ${errorMessage}`)
    }
  }

  /**
   * 解析预设名称，获取实际的预设名和来源
   * @param presetName 预设名称（格式: "source:name" 或 "name"）
   * @returns 预设名和来源
   */
  parsePresetName(presetName: string): { name: string; source: PresetSource } {
    const parts = presetName.split(':', 2)
    if (parts.length === 2) {
      const source = parts[0] as PresetSource
      if (source === PresetSource.ChatLuna || source === PresetSource.Character) {
        return { name: parts[1], source }
      }
    }
    // 默认为 ChatLuna
    return { name: presetName, source: PresetSource.ChatLuna }
  }

  /**
   * 获取默认的 ChatLuna 预设名称
   * 用于 character 预设模式下作为 room.preset 的后备值
   * @returns 默认 ChatLuna 预设名，如果无法获取则返回 null
   */
  getDefaultChatLunaPreset(): string | null {
    try {
      const chatlunaService = this.ctx.chatluna
      if (!chatlunaService?.preset) {
        return null
      }

      // 尝试获取默认 preset（sydney）
      const defaultPreset = chatlunaService.preset.getDefaultPreset?.()
      if (defaultPreset?.value) {
        return defaultPreset.value.triggerKeyword?.[0] || 'sydney'
      }

      // 如果 getDefaultPreset 不可用，尝试获取所有 preset 并返回第一个
      const allPresets = chatlunaService.preset.getAllPreset?.()
      if (allPresets?.value && allPresets.value.length > 0) {
        return allPresets.value[0]
      }

      return 'sydney'  // 硬编码后备值
    } catch {
      return 'sydney'  // 硬编码后备值
    }
  }

  /**
   * 获取可用预设列表
   */
  getPresets(): PresetWithSource[] {
    return this.presetCache.get('all') || []
  }

  /**
   * 获取所有 Bot 配置（供控制台使用）
   */
  getBotsConfig(): BotPersonaConfig[] {
    return [...this.config]
  }

  /**
   * 更新 Bot 配置（供控制台使用）
   */
  updateBotConfig(config: BotPersonaConfig): void {
    const index = this.config.findIndex(b => b.botId === config.botId)
    if (index >= 0) {
      this.config[index] = config
    } else {
      this.config.push(config)
    }
    this.debug(`已更新 Bot 配置: ${config.botId}`)
  }

  /**
   * 输出调试日志
   */
  private debug(...args: unknown[]): void {
    if (this.options.debug) {
      this.logger.debug(args)
    }
  }

  /**
   * 创建 bot 特定的 room（通用方法）
   * @param options room 创建选项
   * @returns 创建的 room 对象
   * @throws 数据库操作失败时抛出错误
   */
  async createRoom(options: {
    botId: string
    roomName: string
    roomMasterId: string
    guildId?: string
    visibility: 'private' | 'template_clone' | 'public'
    preset?: string
    model?: string
    chatMode?: 'chat' | 'plugin'
  }): Promise<any> {
    const { botId, roomName, roomMasterId, guildId, visibility, preset, model, chatMode } = options

    // 获取当前最大的 roomId（优化：只查询一条记录，按 roomId 降序）
    const result = await this.ctx.database.get('chathub_room', {}, { limit: 1, sort: { roomId: 'desc' } })
    const maxRoomId = result[0]?.roomId ?? 0
    const newRoomId = maxRoomId + 1

    // 生成 conversationId
    const conversationId = this.generateConversationId(botId)

    // 解析预设名称
    const { name: presetName } = preset ? this.parsePresetName(preset) : { name: '' }

    // 创建 room
    const newRoom: any = {
      roomId: newRoomId,
      roomName,
      roomMasterId,
      conversationId,
      preset: presetName,
      model: model || '',
      chatMode: chatMode || 'chat',
      visibility,
      password: '',
      autoUpdate: false,
      updatedTime: new Date(),
    }

    try {
      await this.ctx.database.create('chathub_room', newRoom)
    } catch (error) {
      this.logger.error(`[Charon] 创建 chathub_room 失败:`, error)
      throw error
    }

    // 创建 room 成员记录
    try {
      await this.ctx.database.create('chathub_room_member', {
        userId: roomMasterId,
        roomId: newRoomId,
        roomPermission: 'owner',
      })
    } catch (error) {
      this.logger.error(`[Charon] 创建 chathub_room_member 失败:`, error)
      throw error
    }

    // 如果是群聊且提供了 guildId，创建群组关联
    if (guildId && visibility !== 'private') {
      try {
        await this.ctx.database.create('chathub_room_group_member', {
          groupId: guildId,
          roomId: newRoomId,
          roomVisibility: visibility,
        })
      } catch (error) {
        this.logger.error(`[Charon] 创建 chathub_room_group_member 失败:`, error)
        throw error
      }
    }

    return newRoom
  }

  /**
   * 验证预设是否存在
   * @deprecated 未使用，保留供未来扩展
   */
  validatePreset(presetName: string): boolean {
    const presets = this.getPresets()
    return presets.some(p => p.name === presetName)
  }
}
