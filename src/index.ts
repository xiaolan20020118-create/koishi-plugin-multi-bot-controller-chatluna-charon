// src/index.ts
import { Context, Schema } from 'koishi'
import {} from '@koishijs/plugin-server'
import { createConfig, Config, updateBotIdOptions } from './config'
import { BotManager } from './bot-manager'
import { RoomInterceptor } from './interceptors/room'
import { ChainInterceptor } from './interceptors/chain'
import { MemoryInterceptor } from './interceptors/memory'
import type { BotPersonaConfig } from './types'

export const name = 'multi-bot-controller-chatluna-charon'

// 声明服务依赖
export const inject = {
    required: ['chatluna', 'multi-bot-controller', 'database'],
    optional: ['chatluna_character', 'server'],
}

export { Config }
export * from './types'

// 导出动态 Schema 创建函数
export { createConfig }

export const usage = `

## 工作原理

本插件为每个 Bot 配置独立的 ChatLuna 人设（预设和模型），实现多 Bot 不同人设的隔离。

### 前置要求

**使用本插件前，请确保在 ChatLuna 配置中开启「自动为用户创建新 room」选项。**

**本插件无法与普通版的 character 插件配合使用，请使用私域插件 @kotoko76/koishi-plugin-chatluna-character **

### Room 创建规则

- 每个 Bot 自动创建独立的 Room
- Room 名称格式: 模板房间_{platform}:{selfId}
- ConversationId 格式: bot_{platform}:{selfId}_{uuid}

### 配置说明

1. Bot ID:
   - 从 multi-bot-controller 已配置的 bot 中选择
2. 预设选择:
   - 从 ChatLuna 和 character（启用时）已配置的预设中选择
3. 模型选择:
   - 从 ChatLuna 已配置的模型中选择


---

`

export function apply(ctx: Context, config: Config): void {
  // 创建 logger
  const logger = ctx.logger('chatluna-charon')

  logger.info('多 Bot 人设控制器插件正在启动...')

  // 用于存储需要手动清理的 dispose 函数（如 clearTimeout）
  const manualDisposes: Array<() => void> = []

  // ========================================
  // 动态 Schema 更新服务
  // 从 multi-bot-controller 获取已配置的 bot 列表
  // ========================================
  function setupBotSchemaService() {
    const knownBots: Set<string> = new Set()
    let debounceTimer: NodeJS.Timeout | null = null

    const scheduleScan = () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => scanFromMBC(), 200)
    }

    const scanFromMBC = () => {
      try {
        const mbcService = ctx['multi-bot-controller']
        if (!mbcService) {
          logger.warn('multi-bot-controller 服务不可用')
          return
        }

        const bots = mbcService.getBots()
        const enabledBots = bots.filter((b: any) => b.enabled)
        const botIds = enabledBots.map((b: any) => `${b.platform}:${b.selfId}`).sort()

        const currentSet = new Set(botIds)
        if (setsEqual(knownBots, currentSet)) {
          return
        }

        // 更新 knownBots
        knownBots.clear()
        botIds.forEach((id: string) => knownBots.add(id))
        updateBotIdOptions(ctx, botIds)
        logger.info(`Bot 列表已更新，共 ${botIds.length} 个可用`)
      } catch (error) {
        logger.warn('从 multi-bot-controller 获取 Bot 列表失败:', error)
      }
    }

    const setsEqual = (a: Set<string>, b: Set<string>): boolean => {
      if (a.size !== b.size) return false
      for (const item of a) {
        if (!b.has(item)) return false
      }
      return true
    }

    // 立即扫描一次
    const scanTimer = setTimeout(() => scanFromMBC(), 500)
    manualDisposes.push(() => clearTimeout(scanTimer))

    // 监听事件
    ctx.on('multi-bot-controller/bots-updated', () => scheduleScan())
    ctx.on('bot-added', () => scheduleScan())
    ctx.on('bot-removed', () => scheduleScan())
    ctx.on('ready', () => scheduleScan())
  }

  // 启动 Schema 服务
  setupBotSchemaService()

  // 初始化 BotManager，使用配置中的 bots 列表
  const botManager = new BotManager(
    ctx,
    config.bots,
    {
      debug: config.debug,
      verboseLogging: config.verboseLogging,
    }
  )

  // 预设加载防抖：避免短时间内重复加载
  let presetLoadTimer: NodeJS.Timeout | null = null

  const schedulePresetLoad = (force = false) => {
    if (presetLoadTimer) clearTimeout(presetLoadTimer)
    presetLoadTimer = setTimeout(async () => {
      await botManager.loadPresets(false, force)
      presetLoadTimer = null
    }, 1000)
  }

  // ========================================
  // Bot 配置注册（必须尽早执行，在 character 开始处理消息之前）
  // ========================================

  /**
   * 尝试注册 Bot 配置到 character 插件
   * @returns 是否成功注册
   */
  function tryRegisterBotConfigs(): boolean {
    if (!ctx.chatluna_character) {
      return false
    }

    // 检查 botConfig 属性是否存在（服务可能未完全初始化）
    if (!ctx.chatluna_character.botConfig) {
      return false
    }

    for (const botConfig of botManager.getConfig()) {
      const botId = botConfig.botId
      const preset = botConfig.preset
      const model = botConfig.model

      if (preset || model) {
        // 统一使用 BotManager.parsePresetName() 解析预设名称
        const { name: cleanPreset } = botManager.parsePresetName(preset || '')

        ctx.chatluna_character.botConfig.setBotConfig(botId, {
          preset: cleanPreset || undefined,
          model
        })
        logger.info(
          `[Charon] 注册 Bot ${botId} 配置: preset="${cleanPreset}", model="${model}"`
        )
      }
    }
    return true
  }

  /**
   * 设置 character 插件就绪监听器
   * 使用事件驱动 + 延迟轮询兜底，支持各种加载顺序和重载场景：
   * - charon 在 character 之前加载：监听 ready 事件后注册
   * - charon 在 character 之后加载：立即尝试注册
   * - charon 重载：监听器重新注册，等待下次 ready 事件
   * - character 重载：触发 ready 事件，重新注册配置
   * - ready 事件已错过：延迟轮询兜底检测
   */
  function setupCharacterPluginListener() {
    const attemptRegistration = (source: string): boolean => {
      if (tryRegisterBotConfigs()) {
        logger.info(`[Charon] Bot 配置已注册到 character 插件 (${source})`)
        return true
      }
      return false
    }

    // 立即尝试一次（处理 character 已就绪的情况）
    if (attemptRegistration('immediate')) {
      return
    }

    // 监听 character 插件就绪事件（处理 character 尚未就绪或重载的情况）
    // Koishi 会在插件 unload 时自动清理通过 ctx.on 注册的监听器
    const readyHandler = () => {
      if (attemptRegistration('ready-event')) {
        // 注册成功后停止轮询
        clearInterval(checkTimer)
      }
    }
    ctx.on('chatluna_character/ready', readyHandler)

    // 兜底：延迟轮询检测（处理 ready 事件在监听器注册前已触发的情况）
    let checkCount = 0
    const maxChecks = 20 // 最多检查 20 次（10秒）
    const checkTimer = setInterval(() => {
      checkCount++
      if (attemptRegistration(`poll-${checkCount}`) || checkCount >= maxChecks) {
        clearInterval(checkTimer)
      }
    }, 500)

    // 清理定时器（如果插件提前卸载）
    manualDisposes.push(() => clearInterval(checkTimer))
  }

  // 立即开始尝试注册配置（在 character 插件初始化时）
  setupCharacterPluginListener()

  // ChatLuna 就绪时加载预设（模型列表通过 watch 自动响应式更新）
  ctx.on('chatluna/ready', async () => {
    schedulePresetLoad()
  })

  // 兜底：检测 chatluna 是否已就绪（处理插件重载场景）
  const checkChatlunaReady = async () => {
    if (ctx.chatluna) {
      schedulePresetLoad()
      clearInterval(chatlunaCheckTimer)
    }
  }

  let checkCount = 0
  const maxChecks = 20
  const chatlunaCheckTimer = setInterval(() => {
    checkCount++
    if (checkCount >= maxChecks) {
      clearInterval(chatlunaCheckTimer)
    }
    checkChatlunaReady()
  }, 500)

  manualDisposes.push(() => clearInterval(chatlunaCheckTimer))

  // character 可能在 chatluna 之后才就绪，监听其就绪事件
  // 强制刷新预设列表，确保 character 预设能被加载
  ctx.on('chatluna_character/ready', async () => {
    schedulePresetLoad(true)  // force = true
  })

  // 监听 ChatLuna 预设配置变更（通过 service 配置更新事件）
  ctx.on('config-updated', async (plugin: string) => {
    if (plugin === 'chatluna' || plugin === 'chatluna-character') {
      schedulePresetLoad()
    }
  })

  // 注意：不能监听 preset_updated 事件，否则会造成循环：
  // schedulePresetLoad -> loadPresets -> getAllPreset -> preset_updated -> schedulePresetLoad ...

  // 插件完全就绪后最后尝试加载一次预设
  ctx.on('ready', () => {
    const timer = setTimeout(() => {
      schedulePresetLoad()
    }, 1500)
    manualDisposes.push(() => clearTimeout(timer))
  })

  // 启动各个拦截器（始终启用多 Bot 隔离和自动创建 Room）
  // ChainInterceptor: 在 ChatLuna 的 resolve_room 之前运行，确保使用 Bot 特定的 room
  const chainInterceptor = new ChainInterceptor(ctx, botManager, {
    debug: config.debug,
    verboseLogging: config.verboseLogging,
  })

  // RoomInterceptor: 为每个 Bot 创建独立的 template room
  const roomInterceptor = new RoomInterceptor(ctx, botManager, {
    autoCreateTemplateRooms: true,
    debug: config.debug,
  })

  const memoryInterceptor = new MemoryInterceptor(ctx, botManager, {
    isolateLongMemory: true,
    debug: config.debug,
  })

  // 启动拦截器
  chainInterceptor.start()
  roomInterceptor.start()
  memoryInterceptor.start()
  logger.info('拦截器初始化完成')

  // 注册控制台扩展
  ctx.on('ready', async () => {
    const consoleService = ctx.get('console') as any
    if (consoleService) {
      registerConsoleExtensions(ctx, botManager, logger, consoleService)
    }
  })

  // 注册调试指令
  registerDebugCommands(ctx, botManager, logger, tryRegisterBotConfigs)

  // ========================================
  // 指令拦截：与 character 插件深度融合
  // ========================================
  setupCharacterCommandInterceptor(ctx, botManager, logger)

  // ========================================
  // 插件停用时清理
  // ========================================
  ctx.on('dispose', async () => {
    logger.info('Charon 插件正在停止...')

    // 停止所有拦截器
    chainInterceptor.stop()
    roomInterceptor.stop()
    memoryInterceptor.stop()
    logger.info('所有拦截器已停止')

    // 清理手动管理的资源
    for (const dispose of manualDisposes) {
      try {
        dispose()
      } catch (error) {
        logger.warn('清理手动资源时出错:', error)
      }
    }
    manualDisposes.length = 0
    logger.info('手动资源已清理')

    logger.info('Charon 插件已完全停止')
  })
}

/**
 * 注册控制台扩展
 */
function registerConsoleExtensions(ctx: Context, botManager: BotManager, logger: any, consoleService: any): void {
  const { assets } = consoleService

  // 添加脚本和样式
  assets?.forEach((asset: any) => {
    if (asset.type === 'style') {
      asset.children.push({
        type: 'style',
        children: '.charon-status { padding: 8px 12px; background: var(--color-bg-2); border-radius: 4px; margin: 8px 0; }',
      })
    }
  })

  // 添加状态监控扩展
  consoleService.addEntry({
    dev: __dirname + '/src/client/index.ts',
    prod: __dirname + '/dist',
  })

  // 注册 HTTP 处理器供前端调用（需要 server 插件）
  if (ctx.server) {
    ctx.server.get('/multi-bot-controller-chatluna-charon/data', async () => {
      return {
        bots: botManager.getBotsConfig(),
        presets: botManager.getPresets(),
      }
    })

    ctx.server.post('/multi-bot-controller-chatluna-charon/bot-update', async ({ data }) => {
      const botConfig: BotPersonaConfig = data
      botManager.updateBotConfig(botConfig)
      return { success: true }
    })
  } else {
    logger.warn('server 插件未安装，控制台 UI 将无法使用')
  }
}

/**
 * 注册调试指令
 */
function registerDebugCommands(
  ctx: Context,
  botManager: BotManager,
  logger: any,
  registerBotConfigsToCharacter: () => void
): void {
  // 查看所有 bot 状态
  ctx.command('charon.status', '查看所有 bot 的人设配置状态', { authority: 4 })
    .action(() => {
      const bots = botManager.getAllBotStatus()

      if (bots.length === 0) {
        return '当前没有配置任何 bot'
      }

      let output = `Bot 人设配置状态（共 ${bots.length} 个）：\n\n`

      for (const bot of bots) {
        output += `## ${bot.botId}\n`
        output += `- 状态: ${bot.initialized ? '已初始化' : '未初始化'}\n`
        output += `- 当前预设: ${bot.currentPreset || '未设置'}\n`
        output += `- 当前模型: ${bot.currentModel || '未设置'}\n`
        output += `- Template Room: ${bot.templateRoomId || '未创建'}\n`
        output += '\n'
      }

      return output.trim()
    })

  // 手动重新加载预设
  ctx.command('charon.reload', '重新加载预设列表', { authority: 4 })
    .action(async () => {
      await botManager.loadPresets()
      // 重新注册到 character 插件
      registerBotConfigsToCharacter()
      return '预设列表已重新加载'
    })

  // 测试 Bot 配置是否正确注册到 character
  ctx.command('charon.test', '测试 character 插件的 Bot 配置', { authority: 4 })
    .action(() => {
      if (!ctx.chatluna_character) {
        return 'character 插件未加载'
      }

      const allConfigs = ctx.chatluna_character.botConfig.getAllConfigs()
      const configCount = Object.keys(allConfigs).length

      if (configCount === 0) {
        return '没有注册任何 Bot 配置到 character 插件'
      }

      let output = `已注册的 Bot 配置（共 ${configCount} 个）：\n\n`
      for (const [botId, config] of Object.entries(allConfigs)) {
        output += `- ${botId}: preset="${config.preset}", model="${config.model}"\n`
      }

      return output.trim()
    })
}

/**
 * 设置 character 插件指令拦截器
 *
 * 功能：
 * - 直接处理 clear 指令，使用 session.send() 发送响应
 * - 如果艾特了特定 bot，清除该 bot 的记录
 * - 如果未艾特任何 bot，清除该群组所有 bot 的记录
 */
function setupCharacterCommandInterceptor(
  ctx: Context,
  botManager: BotManager,
  logger: any
): void {
  // 尝试从 character 插件获取 groupInfos
  // 注意：这是延迟获取，因为 character 插件可能尚未加载
  const getGroupInfos = (): Record<string, any> | null => {
    // 尝试通过 require 动态导入
    try {
      const characterFilterPath = require.resolve(
        '@kotoko76/koishi-plugin-chatluna-character/plugins/filter'
      )
      const module = require(characterFilterPath)
      return module.groupInfos || null
    } catch {
      return null
    }
  }

  ctx.middleware(async (session, next) => {
    // 只处理群聊消息
    if (!session.guildId) return next()

    // 检查是否是 character clear 指令
    const content = session.content?.trim() ?? ''
    if (
      !content.startsWith('chatluna.character.clear') &&
      !content.startsWith('.chatluna.character.clear')
    ) {
      return next()
    }

    // 解析指令和参数（忽略原参数，统一使用艾特检测）
    const match = content.match(/^\.?chatluna\.character\.clear(?:\s+(.*))?$/i)
    if (!match) return next()

    const groupId = session.guildId

    // 检测消息中的艾特
    const mentionedBots: string[] = []
    if (session.elements) {
      for (const element of session.elements) {
        if (element.type === 'at' && element.attrs?.id) {
          const atId = element.attrs.id
          const botConfig = botManager.getConfig().find(c => c.botId === atId)
          if (botConfig) {
            mentionedBots.push(atId)
          }
        }
      }
    }

    // 获取 groupInfos
    const infos = getGroupInfos()

    if (mentionedBots.length > 0) {
      // 艾特了特定 bot，清除该 bot 的记录
      const botId = mentionedBots[0]
      const key = `${botId}_${groupId}`

      if (infos && infos[key]) {
        delete infos[key]
      }

      if (ctx.chatluna_character) {
        await ctx.chatluna_character.clear(groupId)
      }

      logger.info(`[Charon] 清除 bot ${botId} 在群组 ${groupId} 的聊天记录`)
      await session.send(`已清除 bot ${botId} 在群组 ${groupId} 的聊天记录`)
    } else {
      // 未艾特任何 bot，清除该群组所有 bot 的记录
      let clearedCount = 0

      if (infos) {
        for (const key of Object.keys(infos)) {
          if (key.endsWith(`_${groupId}`)) {
            delete infos[key]
            clearedCount++
          }
        }
      }

      if (ctx.chatluna_character) {
        await ctx.chatluna_character.clear(groupId)
      }

      if (clearedCount === 0) {
        await session.send(`未找到群组 ${groupId} 的聊天记录`)
      } else {
        logger.info(`[Charon] 清除群组 ${groupId} 的聊天记录（${clearedCount} 个 bot）`)
        await session.send(`已清除群组 ${groupId} 的聊天记录（${clearedCount} 个 bot）`)
      }
    }

    // 不继续传递到下一个中间件
    return
  })
}
