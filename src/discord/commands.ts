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
  setIndexChannel,
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
  .setDescription("View or change this channel's model and effort")
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

const mute = new SlashCommandBuilder().setName("mute").setDescription("Mute or unmute munin in this channel").addBooleanOption((b) => b.setName("everywhere").setDescription("Apply across every channel, not just this one"))

const ephemeral = new SlashCommandBuilder()
  .setName('ephemeral')
  .setDescription('Toggle this channel as ephemeral (auto-clears ~5 min after the last message, never remembered)')

const index = new SlashCommandBuilder()
  .setName('index')
  .setDescription('Make this channel the live index of all channels')

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

const commands = [config, mute, ephemeral, index, clear]



export async function handleConfigInteraction(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const model = interaction.options.getString('model')
  const effort = interaction.options.getString('effort')
  if (model !== null || effort !== null) {
    await updateConfig({
      channelId: interaction.channelId,
      ...(model !== null && { model: model === DEFAULT ? null : model }),
      ...(effort !== null && { effort: effort === DEFAULT ? null : (effort as Effort) })
    })
  }

  const parentChannelId = interaction.channel?.isThread() ? interaction.channel.parentId : null
  const resolved = await resolveSettings(interaction.channelId, parentChannelId)
  const embed = new EmbedBuilder()
    .setTitle('Channel config')
    .setColor(0x1e2547)
    .addFields(
      { name: 'Model', value: `\`${resolved.model}\``, inline: true },
      { name: 'Effort', value: `\`${resolved.effort}\``, inline: true }
    )
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

export async function handleIndexInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
  await setIndexChannel(interaction.channelId)
  log.info({ channelId: interaction.channelId }, 'index channel set')
  await interaction.reply({
    content: 'This channel is now the index. It refreshes automatically as channels are used.',
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