import { Cron } from 'croner'
import { setupClient } from './discord/client'
import { sweepEphemeral, dispatchReminders, sweepMemoryJob } from './jobHandlers'
import { log } from './logger'

const client = await setupClient().catch((err) => {
  log.fatal({ err }, 'Startup failed, exiting')
  process.exit(1)
})

new Cron('* * * * *', { catch: (err) => log.error({ err }, 'Ephemeral sweep failed') }, () =>
  sweepEphemeral(client),
)
new Cron('* * * * *', { catch: (err) => log.error({ err }, 'Reminder dispatch failed') }, () =>
  dispatchReminders(client),
)
new Cron(
  '* * * * *',
  { protect: true, catch: (err) => log.error({ err }, 'Memory sweep failed') },
  async () => {
    const guilds = [...client.guilds.cache.values()]
    for (let i = 0; i < guilds.length; i++) {
      const guild = guilds[i]
      await sweepMemoryJob(client, guild, guilds.length - i)
    }
  },
)
