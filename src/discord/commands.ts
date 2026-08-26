import {
  type ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js'
import { efforts, listModelIds, type Effort } from '../ai'
import {
  resolveSettings,
  toggleChannelMute,
  toggleEphemeral,
  updateConfig
} from '../repositories/channelSettings'
import { deleteMessages } from '../repositories/messages'
import { log } from '../logger'

const DEFAULT = '__default__' // choice value meaning "clear the override"

// discord caps choices at 25; leave room for the Default entry.
const modelIds = (await listModelIds()).slice(0, 24)

const config = new SlashCommandBuilder()
  .setName('config')
  .setDescription("Change this channel's model or effort")
  .addStringOption((o) =>
    o
      .setName('model')
      .setDescription('Model (Default clears the override)')
      .addChoices({ name: 'Default', value: DEFAULT }, ...modelIds.map((id) => ({ name: id, value: id })))
  )
  .addStringOption((o) =>
    o
      .setName('effort')
      .setDescription('Effort (Default clears the override)')
      .addChoices({ name: 'Default', value: DEFAULT }, ...efforts.map((e) => ({ name: e, value: e })))
  )

const settings = new SlashCommandBuilder()
  .setName('settings')
  .setDescription("View this channel's settings")

const memory = new SlashCommandBuilder()
  .setName('memory')
  .setDescription("View this channel's memory")

const mute = new SlashCommandBuilder().setName("mute").setDescription("Mute or unmute munin in this channel").addBooleanOption((b) => b.setName("everywhere").setDescription("Apply across every channel, not just this one"))

const ephemeral = new SlashCommandBuilder()
  .setName('ephemeral')
  .setDescription('Toggle this channel as ephemeral (auto-clears ~5 min after the last message, never remembered)')

const clear = new SlashCommandBuilder()
  .setName('clear')
  .setDescription('Delete the last N messages in this channel')
  .addIntegerOption((o) =>
    o
      .setName('count')
      .setDescription('How many recent messages to delete')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(100)
  )

const commands = [config, settings, memory, mute, ephemeral, clear]



export async function handleConfigInteraction(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const model = interaction.options.getString('model')
  const effort = interaction.options.getString('effort')
  if (model === null && effort === null) {
    await interaction.reply({
      content: 'Pass a model or effort to change. Use `/settings` to view this channel.',
      flags: MessageFlags.Ephemeral
    })
    return
  }

  const patch: { model?: string | null; effort?: Effort | null } = {}
  const changes: string[] = []
  if (model !== null) {
    patch.model = model === DEFAULT ? null : model
    changes.push(`model → ${model === DEFAULT ? 'default' : `\`${model}\``}`)
  }
  if (effort !== null) {
    patch.effort = effort === DEFAULT ? null : (effort as Effort)
    changes.push(`effort → ${effort === DEFAULT ? 'default' : `\`${effort}\``}`)
  }

  await updateConfig({ channelId: interaction.channelId, ...patch })
  await interaction.reply({ content: `Updated ${changes.join(', ')}.`, flags: MessageFlags.Ephemeral })
}

export async function handleSettingsInteraction(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const parentChannelId = interaction.channel?.isThread() ? interaction.channel.parentId : null
  const s = await resolveSettings(interaction.channelId, parentChannelId)
  const embed = new EmbedBuilder()
    .setTitle('Channel settings')
    .setDescription(`<#${interaction.channelId}>`)
    .setColor(0x1e2547)
    .addFields(
      { name: 'Model', value: `\`${s.model}\``, inline: true },
      { name: 'Effort', value: `\`${s.effort}\``, inline: true },
      { name: 'Replies', value: s.enabled ? 'On' : 'Muted', inline: true },
      { name: 'Ephemeral', value: s.ephemeral ? 'Yes' : 'No', inline: true }
    )
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral })
}

export async function handleMemoryInteraction(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const parentChannelId = interaction.channel?.isThread() ? interaction.channel.parentId : null
  const s = await resolveSettings(interaction.channelId, parentChannelId)
  const text = s.memory.trim()
  const embed = new EmbedBuilder()
    .setTitle('Memory')
    .setDescription(text ? (text.length > 4096 ? `${text.slice(0, 4095)}…` : text) : '_No memory yet._')
    .setColor(0x1e2547)
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral })
}

export async function handleMuteInteraction(interaction: ChatInputCommandInteraction) {
  const everywhere = interaction.options.getBoolean('everywhere')
  const channelId = everywhere ? 'global' : interaction.channelId
  const muted = await toggleChannelMute(channelId)
  const scope = everywhere ? 'everywhere' : 'in this channel'
  log.info({ channelId, muted }, `munin ${muted ? 'muted' : 'unmuted'} ${scope}`)
  await interaction.reply({
    content: `munin ${muted ? 'muted' : 'unmuted'} ${scope}`,
    flags: MessageFlags.Ephemeral
  })
}


export async function handleEphemeralInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
  const on = await toggleEphemeral(interaction.channelId)
  log.info({ channelId: interaction.channelId, ephemeral: on }, `channel ${on ? 'now' : 'no longer'} ephemeral`)
  await interaction.reply({
    content: on
      ? 'This channel is now ephemeral. Messages clear about 5 minutes after the last one, and nothing here enters memory.'
      : 'This channel is no longer ephemeral.',
    flags: MessageFlags.Ephemeral
  })
}

export async function handleClearInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
  const count = interaction.options.getInteger('count', true)
  const channel = interaction.channel
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    await interaction.reply({ content: 'I can only clear a server text channel.', flags: MessageFlags.Ephemeral })
    return
  }
  const deleted = await channel.bulkDelete(count, true)
  await deleteMessages([...deleted.keys()])
  log.info({ channelId: channel.id, deleted: deleted.size }, 'cleared messages')
  await interaction.reply({
    content:
      `Deleted ${deleted.size} message${deleted.size === 1 ? '' : 's'}.` +
      (deleted.size < count ? " (Messages older than 14 days can't be bulk-deleted.)" : ''),
    flags: MessageFlags.Ephemeral
  })
}

export async function registerCommands(client: Client): Promise<void> {
  const json = commands.map((c) => c.toJSON())
  for (const guild of client.guilds.cache.values()) await guild.commands.set(json)
  log.info({ guilds: client.guilds.cache.size, commands: commands.length }, 'slash commands registered')
}