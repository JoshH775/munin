import {
  type ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js'
import { efforts, listModelIds, type Effort } from '../ai'
import { resolveSettings, updateConfig } from '../repositories/channelSettings'
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

const commands = [config]

export async function registerCommands(client: Client): Promise<void> {
  const json = commands.map((c) => c.toJSON())
  for (const guild of client.guilds.cache.values()) await guild.commands.set(json)
  log.info({ guilds: client.guilds.cache.size, commands: commands.length }, 'slash commands registered')
}

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
