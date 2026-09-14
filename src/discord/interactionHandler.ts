import { log } from '../logger'
import { type Interaction } from 'discord.js'
import { match } from 'ts-pattern'
import { markReminderReceived, snoozeReminder } from '../repositories/reminders'
import {
  handleConfigInteraction,
  handleMemoryInteraction,
  handleMuteInteraction,
  handleUnmuteInteraction,
  handleEphemeralInteraction,
  handleClearInteraction,
} from './commands'

export async function interactionHandler(interaction: Interaction): Promise<void> {
  if (interaction.isButton()) {
    const [action, id] = interaction.customId.split(':')
    await match({ action, id })
      .with({ action: 'reminder_ack' }, async ({ id }) => {
        try {
          await markReminderReceived(id)
          await interaction.update({
            content: `${interaction.message.content}\n-# Acknowledged by ${interaction.user.username}`,
            components: [],
          })
        } catch (err) {
          log.error({ err, customId: interaction.customId }, 'Reminder ack failed')
        }
        return
      })
      .with({ action: 'reminder_snooze_1hr' }, async ({ id }) => {
        try {
          await snoozeReminder(id, 60)
          await interaction.update({
            content: `${interaction.message.content}\n-# Snoozed for 1 hour`,
            components: [],
          })
          await new Promise((r) => setTimeout(r, 3000))
          await interaction.deleteReply()
        } catch (err) {
          log.error({ err, customId: interaction.customId }, 'Reminder snooze failed')
        }
        return
      })
      .with({ action: 'reminder_snooze_5min' }, async ({ id }) => {
        try {
          await snoozeReminder(id, 5)
          await interaction.update({
            content: `${interaction.message.content}\n-# Snoozed for 5 minutes`,
            components: [],
          })
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
        .with('memory', () => handleMemoryInteraction(interaction))
        .with('mute', () => handleMuteInteraction(interaction))
        .with('unmute', () => handleUnmuteInteraction(interaction))
        .with('ephemeral', () => handleEphemeralInteraction(interaction))
        .with('clear', () => handleClearInteraction(interaction))
        .otherwise(async () => {})
    } catch (err) {
      log.error({ err, command: interaction.commandName }, 'Interaction failed')
    }
  }

  return
}
