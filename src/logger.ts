import pino from 'pino'

export const log = pino({
  transport: {
    target: 'pino-pretty',
    // colorize is forced on; in prod journald that writes escape codes — set to auto/false there if noisy
    options: {
      colorize: true,
      singleLine: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
      ignore: 'pid,hostname',
    },
  },
})
