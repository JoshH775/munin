import {
  type ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js'
import { efforts, listModelIds, type Effort } from '../ai'
import { resolveMemory } from '../repositories/memory'
import { resolveSettings, setMuted, toggleEphemeral } from '../repositories/channelSettings'
import { deleteMessages } from '../repositories/messages'
import { getAppSettings, updateAppSettings } from '../repositories/appSettings'
import { log } from '../logger'

// discord caps choices at 25.
const modelIds = (await listModelIds()).slice(0, 25)

const config = new SlashCommandBuilder()
  .setName('config')
  .setDescription('View or set the app-wide model and effort')
  .addStringOption((o) =>
    o
      .setName('model')
      .setDescription('Set the app-wide chat model')
      .addChoices(...modelIds.map((id) => ({ name: id, value: id }))),
  )
  .addStringOption((o) =>
    o
      .setName('effort')
      .setDescription('Set the app-wide effort')
      .addChoices(...efforts.map((e) => ({ name: e, value: e }))),
  )

const memory = new SlashCommandBuilder()
  .setName('memory')
  .setDescription("View this channel's memory")

const mute = new SlashCommandBuilder().setName('mute').setDescription('Mute munin in this channel')

const unmute = new SlashCommandBuilder()
  .setName('unmute')
  .setDescription('Unmute munin in this channel')

const ephemeral = new SlashCommandBuilder()
  .setName('ephemeral')
  .setDescription(
    'Toggle this channel as ephemeral (auto-clears ~5 min after the last message, never remembered)',
  )

const clear = new SlashCommandBuilder()
  .setName('clear')
  .setDescription('Delete the last N messages in this channel')
  .addIntegerOption((o) =>
    o
      .setName('count')
      .setDescription('How many recent messages to delete')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(100),
  )

const commands = [config, memory, mute, unmute, ephemeral, clear]

export async function handleConfigInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const model = interaction.options.getString('model')
  const effort = interaction.options.getString('effort')

  // No options → view the app defaults plus this channel's state.
  if (model === null && effort === null) {
    const parentChannelId = interaction.channel?.isThread() ? interaction.channel.parentId : null
    const [app, s] = await Promise.all([
      getAppSettings(),
      resolveSettings(interaction.channelId, parentChannelId),
    ])
    const embed = new EmbedBuilder()
      .setTitle('Settings')
      .setColor(0x1e2547)
      .addFields(
        { name: 'Model', value: `\`${app.chat_model}\``, inline: true },
        { name: 'Effort', value: `\`${app.effort}\``, inline: true },
        { name: 'Replies here', value: s.enabled ? 'On' : 'Muted', inline: true },
        { name: 'Ephemeral', value: s.ephemeral ? 'Yes' : 'No', inline: true },
      )
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral })
    return
  }

  const patch: { chat_model?: string; effort?: Effort } = {}
  const changes: string[] = []
  if (model !== null) {
    patch.chat_model = model
    changes.push(`model → \`${model}\``)
  }
  if (effort !== null) {
    patch.effort = effort as Effort
    changes.push(`effort → \`${effort}\``)
  }

  await updateAppSettings(patch)
  await interaction.reply({
    content: `Updated ${changes.join(', ')}.`,
    flags: MessageFlags.Ephemeral,
  })
}

export async function handleMemoryInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const parentChannelId = interaction.channel?.isThread() ? interaction.channel.parentId : null
  const text = (await resolveMemory(interaction.channelId, parentChannelId)).trim()
  const embed = new EmbedBuilder()
    .setTitle('Memory')
    .setDescription(
      text ? (text.length > 4096 ? `${text.slice(0, 4095)}…` : text) : '_No memory yet._',
    )
    .setColor(0x1e2547)
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral })
}

export async function handleMuteInteraction(interaction: ChatInputCommandInteraction) {
  await setMuted(interaction.channelId, true)
  log.info({ channelId: interaction.channelId }, 'Munin muted in channel')
  await interaction.reply({
    content: 'Munin muted in this channel.',
    flags: MessageFlags.Ephemeral,
  })
}

export async function handleUnmuteInteraction(interaction: ChatInputCommandInteraction) {
  await setMuted(interaction.channelId, false)
  log.info({ channelId: interaction.channelId }, 'Munin unmuted in channel')
  await interaction.reply({
    content: 'Munin unmuted in this channel.',
    flags: MessageFlags.Ephemeral,
  })
}

export async function handleEphemeralInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const on = await toggleEphemeral(interaction.channelId)
  log.info(
    { channelId: interaction.channelId, ephemeral: on },
    `Channel ${on ? 'now' : 'no longer'} ephemeral`,
  )
  await interaction.reply({
    content: on
      ? 'This channel is now ephemeral. Messages clear about 5 minutes after the last one, and nothing here enters memory.'
      : 'This channel is no longer ephemeral.',
    flags: MessageFlags.Ephemeral,
  })
}

export async function handleClearInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const count = interaction.options.getInteger('count', true)
  const channel = interaction.channel
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    await interaction.reply({
      content: 'I can only clear a server text channel.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }
  const deleted = await channel.bulkDelete(count, true)
  await deleteMessages([...deleted.keys()])
  log.info({ channelId: channel.id, deleted: deleted.size }, 'Cleared messages')
  await interaction.reply({
    content:
      `Deleted ${deleted.size} message${deleted.size === 1 ? '' : 's'}.` +
      (deleted.size < count ? " (Messages older than 14 days can't be bulk-deleted.)" : ''),
    flags: MessageFlags.Ephemeral,
  })
}

export async function registerCommands(client: Client): Promise<void> {
  const json = commands.map((c) => c.toJSON())
  for (const guild of client.guilds.cache.values()) await guild.commands.set(json)
  log.info(
    { guilds: client.guilds.cache.size, commands: commands.length },
    'Slash commands registered',
  )
}
