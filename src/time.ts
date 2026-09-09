import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.tz.setDefault('Europe/London')

// A time from the model: London wall-clock, or an absolute instant if it carries a Z.
export function parseTime(s: string) {
  return s.endsWith('Z') ? dayjs(s) : dayjs.tz(s)
}

export { dayjs }
