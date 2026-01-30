// src/types.ts

// Bot 配置接口（与 character 插件保持一致）
interface BotConfig {
  preset?: string
  model?: string
}

// Koishi 类型扩展
declare module 'koishi' {
  // ChatLuna PlatformService 接口（简化版）
  interface ChatLunaPlatformService {
    listAllModels(type: number): {
      value: Array<{
        name: string
        platform: string
        toModelName(): string
      }>
    }
  }

  interface Context {
    // ChatLuna 服务
    chatluna?: {
      config: any
      preset: {
        getPreset(name: string, throwError?: boolean): any
        getAllPreset(concatKeyword?: boolean): any
        getDefaultPreset(): any
      }
      platform?: ChatLunaPlatformService
    }

    // character 插件服务（@kotoko76/koishi-plugin-chatluna-character）
    chatluna_character?: {
      config: {
        configs?: Record<string, any>
      }
      preset?: {
        getAllPreset(): Promise<string[]>
        getPreset(name: string): Promise<any>
        resolvePresetDir(): string
      }
      botConfig: {
        setBotConfig(botId: string, config: BotConfig): void
        getBotConfig(botId: string): BotConfig | undefined
        hasBotConfig(botId: string): boolean
        clearBotConfig(botId: string): void
        getAllConfigs(): Record<string, BotConfig>
      }
      clear(groupId?: string): Promise<void>
    }

    // long-memory
    chatluna_long_memory?: any

    // ChatLuna chains 服务 (使用 as ChainService 访问)
    // chain 属性已存在于 Context 中，作为事件发射器
    // ChatLuna 扩展了它，需要用 as any 访问

    // console 扩展
    // console 已存在于 Context 中，需要用 as any 访问 assets 属性

    // multi-bot-controller 服务
    'multi-bot-controller': import('koishi-plugin-multi-bot-controller').MultiBotControllerService
  }

  interface Tables {
    chathub_room: {
      roomId: number
      roomName: string
      conversationId: string
      preset?: string
      model?: string
      chatMode?: string
      visibility?: string
      updatedTime: Date
      roomMasterId?: string
      autoUpdate?: boolean
      password?: string
      // 注意：ChatLuna 的 chathub_room 表没有 botId 字段
      // 我们通过在 roomName 中包含 botId 来标识 bot 特定的 room
    }
    chathub_room_member: {
      userId: string
      roomId: number
      roomPermission?: 'owner' | 'admin' | 'member'
      mute?: boolean
    }
    chathub_room_group_member: {
      groupId: string
      roomId: number
      roomVisibility?: string
    }
    chathub_user: {
      userId: string
      groupId: string
      defaultRoomId: number
    }
  }

  interface Events {
    'chatluna/ready'(): void
    'chatluna/before-chat'(
      conversationId: string,
      message: any,
      promptVariables: any,
      chatInterface: any,
      session: any
    ): void
    'chatluna-long-memory/init-layer'(layerConfig: any): void
    'console/ready'(): void
    'bot-status-updated'(bot: any): void
    /** bot 配置更新事件（来自 multi-bot-controller） */
    'multi-bot-controller/bots-updated'(bots: MbcBotInfo[]): void
    /** character 插件就绪事件 */
    'chatluna_character/ready'(): void
    /** 插件配置更新事件 */
    'config-updated'(plugin: string): void
  }
}

// 以下是插件的类型定义

/** 预设来源 */
export enum PresetSource {
  ChatLuna = 'chatluna',
  Character = 'character',
}

/** Bot 信息（来自 multi-bot-controller） */
export interface MbcBotInfo {
  platform: string
  selfId: string
  enabled: boolean
}

/** 单个 Bot 的人设配置 */
export interface BotPersonaConfig {
  /** Bot 标识符 (格式: platform:selfId) */
  botId: string
  /** 是否启用此 bot 的人设 */
  enabled: boolean
  /** ChatLuna 预设名称 */
  preset: string
  /** 使用的模型 (如 "openai/gpt-4o") */
  model: string
  /** 聊天模式 */
  chatMode?: 'chat' | 'plugin'
}

/** 预设信息 */
export interface PresetInfo {
  /** 预设名称/触发词 */
  name: string
  /** 预设显示名称 */
  label?: string
  /** 预设文件路径 */
  path?: string
}

/** 预设信息（带来源） */
export interface PresetWithSource extends PresetInfo {
  /** 预设来源 */
  source: PresetSource
}

/** 模型信息 */
export interface ModelInfo {
  /** 模型完整名称 (如 "openai/gpt-4o") */
  name: string
  /** 模型显示名称 */
  label?: string
  /** 模型平台 */
  platform?: string
}

/** Bot 的运行时状态 */
export interface BotStatus {
  /** Bot 标识符 */
  botId: string
  /** 平台 */
  platform: string
  /** 是否已初始化 */
  initialized: boolean
  /** 关联的 template room ID */
  templateRoomId?: number
  /** 当前使用的预设 */
  currentPreset?: string
  /** 当前使用的模型 */
  currentModel?: string
  /** 错误信息（如果有） */
  error?: string
}
