import { log } from '../logger'
import { type Interaction, EmbedBuilder } from 'discord.js'
import { match } from 'ts-pattern'
import { markReminderReceived, snoozeReminder } from '../repositories/reminders'
import {
  handleConfigInteraction,
  handleSettingsInteraction,
  handleMemoryInteraction,
  handleMuteInteraction,
  handleEphemeralInteraction,
  handleClearInteraction,
  handleReminderChannelInteraction,
} from './commands'

export async function interactionHandler(interaction: Interaction): Promise<void> {
  if (interaction.isButton()) {
    const [action, id] = interaction.customId.split(':')
    await match({ action, id })
      .with({ action: 'reminder_ack' }, async ({ id }) => {
        try {
          await markReminderReceived(id)
          const embed = EmbedBuilder.from(interaction.message.embeds[0])
            .setColor(0x3bb273)
            .setFooter({ text: `Acknowledged by ${interaction.user.username}` })
          await interaction.update({ embeds: [embed], components: [] })
        } catch (err) {
          log.error({ err, customId: interaction.customId }, 'Reminder ack failed')
        }
        return
      })
      .with({ action: 'reminder_snooze' }, async ({ id }) => {
        try {
          await snoozeReminder(id)
          const embed = EmbedBuilder.from(interaction.message.embeds[0])
            .setColor(0xf1c40f)
            .setFooter({ text: `Snoozed by ${interaction.user.username}` })
          await interaction.update({ embeds: [embed], components: [] })
          await new Promise((r) => setTimeout(r, 3000))
          await interaction.deleteReply()
        } catch (err) {
          log.error({ err, customId: interaction.customId }, 'Reminder snooze failed')
        }
        return
      })
      .otherwise(async () => {})
    return
  }

  if (interaction.isChatInputCommand()) {
    try {
      await match(interaction.commandName)
        .with('config', () => handleConfigInteraction(interaction))
        .with('settings', () => handleSettingsInteraction(interaction))
        .with('memory', () => handleMemoryInteraction(interaction))
        .with('mute', () => handleMuteInteraction(interaction))
        .with('ephemeral', () => handleEphemeralInteraction(interaction))
        .with('clear', () => handleClearInteraction(interaction))
        .with('reminder-channel', () => handleReminderChannelInteraction(interaction))
        .otherwise(async () => {})
    } catch (err) {
      log.error({ err, command: interaction.commandName }, 'Interaction failed')
    }
  }

  return
}
