// src/config.ts
import { Context, Schema } from 'koishi'
import { PresetWithSource, BotPersonaConfig } from './types'

/** 插件配置 */
export interface Config {
  /** Bot 人设配置列表 */
  bots: BotPersonaConfig[]

  /** 是否输出调试日志 */
  debug: boolean

  /** 是否输出详细日志 */
  verboseLogging: boolean
}

/**
 * 更新 botId 选择选项
 * 此函数由 index.ts 在运行时调用
 * 使用 ctx.schema.set 动态更新 Schema
 */
export function updateBotIdOptions(ctx: Context, botIds: string[]) {
  // 占位符始终放在最前面，作为默认选项
  const placeholder = Schema.const('').description('无')

  if (botIds.length === 0) {
    ctx.schema.set('charon.botId', Schema.union([
      placeholder,
    ]))
    return
  }

  const options = [
    placeholder,
    ...botIds.map(botId => Schema.const(botId).description(botId))
  ]

  ctx.schema.set('charon.botId', Schema.union(options))
}

/**
 * 更新预设选择选项
 * 此函数由 bot-manager.ts 在加载预设后调用
 */
export function updatePresetOptions(ctx: Context, presets: PresetWithSource[]) {
  if (presets.length === 0) {
    ctx.schema.set('charon.preset', Schema.union([
      Schema.const('').description('请先在 ChatLuna 中配置预设'),
    ]))
    return
  }

  const options = [
    Schema.const('').description('未选择'),
    ...presets.map(p => Schema.const(p.name).description(p.label))
  ]

  ctx.schema.set('charon.preset', Schema.union(options))
}

/**
 * 创建单个 Bot 配置 Schema
 */
const createBotConfigSchema = (): Schema<BotPersonaConfig> => {
  return Schema.intersect([
    // Bot 选择
    Schema.object({
      botId: Schema.dynamic('charon.botId')
        .description('**Bot ID**<br>从 multi-bot-controller 已配置的 Bot 中选择')
        .required(),
      enabled: Schema.boolean()
        .default(true)
        .description('是否启用此 bot 的人设'),
    }),

    // ChatLuna 配置
    Schema.object({
      model: Schema.dynamic('model')
        .description('**使用的模型**<br>从 ChatLuna 已配置的模型中选择')
        .default(''),
      preset: Schema.dynamic('charon.preset')
        .description('**使用的预设**<br>会自动加载 ChatLuna 和 character 的预设')
        .default(''),
      chatMode: Schema.union([
        Schema.const('chat' as const).description('聊天模式'),
        Schema.const('plugin' as const).description('Agent 模式'),
      ]).description('聊天模式')
        .default('chat'),
    }),
  ]) as Schema<BotPersonaConfig>
}

/**
 * 创建插件配置 Schema
 */
export const createConfig = (ctx: Context): Schema<Config> => {
  // 初始化默认 Schema
  updateBotIdOptions(ctx, [])
  updatePresetOptions(ctx, [])

  return Schema.intersect([
    Schema.object({
      bots: Schema.array(createBotConfigSchema())
        .role('list')
        .default([])
        .description('**Bot 人设配置列表**\n\n添加 Bot 后，可以为每个 Bot 配置独立的预设和模型'),
    }),

    Schema.object({
      debug: Schema.boolean()
        .description('是否输出调试日志')
        .default(false),
      verboseLogging: Schema.boolean()
        .description('显示详细日志（关闭后只输出关键信息）')
        .default(false),
    }).description('高级设置'),
  ]) as Schema<Config>
}

// 静态导出（用于配置界面）
export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    bots: Schema.array(
      Schema.intersect([
        // Bot 选择
        Schema.object({
          botId: Schema.dynamic('charon.botId')
            .description('**Bot ID**<br>从 multi-bot-controller 已配置的 Bot 中选择')
            .required(),
          enabled: Schema.boolean()
            .default(true)
            .description('是否启用此 bot 的人设'),
        }),
        // ChatLuna 配置
        Schema.object({
          model: Schema.dynamic('model')
            .description('**使用的模型**<br>从 ChatLuna 已配置的模型中选择')
            .default(''),
          preset: Schema.dynamic('charon.preset')
            .description('**使用的预设**<br>会自动加载 ChatLuna 和 character 的预设')
            .default(''),
          chatMode: Schema.union([
            Schema.const('chat' as const).description('聊天模式'),
            Schema.const('plugin' as const).description('Agent 模式'),
          ]).description('聊天模式')
            .default('chat'),
        }),
      ]) as Schema<BotPersonaConfig>
    ).role('list')
      .default([])
      .description('**Bot 人设配置列表**\n\n添加 Bot 后，可以为每个 Bot 配置独立的预设和模型'),
  }),

  Schema.object({
    debug: Schema.boolean()
      .description('是否输出调试日志')
      .default(false),
    verboseLogging: Schema.boolean()
      .description('显示详细日志（关闭后只输出关键信息）')
      .default(false),
  }).description('高级设置'),
]) as Schema<Config>

export const name = 'multi-bot-controller-chatluna-charon'
