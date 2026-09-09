import { z } from 'zod'
import { makeTool } from './makeTool'
import { dayjs } from '../time'

// Read-only tools over Plates, Josh's workout tracker. Public API, fixed host, his own data.

type Exercise = { id: string; name: string; muscleGroup: string }
type Log = { exerciseId: string; weight: number; reps: number; date: string; setType: string }

const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`https://plates.jhickey.sh/api${path}`)
  if (!res.ok) throw new Error(`Plates ${path} returned ${res.status}`)
  return res.json()
}

const day = (date: string) => dayjs.tz(date).format('YYYY-MM-DD')
const byDate = (a: Log, b: Log) => a.date.localeCompare(b.date)

export const platesTools = () => [
  makeTool({
    name: 'plates_exercises',
    label: () => 'Checked Plates exercises',
    description:
      "Every exercise in Plates (Josh's workout tracker) with its id and muscle group. The id is what plates_exercise_logs takes.",
    inputSchema: z.object({}),
    run: async () => JSON.stringify(await get('/exercises')),
  }),
  makeTool({
    name: 'plates_logs',
    label: () => 'Read Plates workouts',
    description:
      'Every set Josh logged in Plates between two dates (YYYY-MM-DD, inclusive), oldest first, one line each: date, exercise, weight×reps, set type. Keep the window to a few weeks; the whole history is hundreds of sets.',
    inputSchema: z.object({ from: z.iso.date(), to: z.iso.date() }),
    run: async ({ from, to }) => {
      const [exercises, logs] = await Promise.all([
        get<Exercise[]>('/exercises'),
        get<Log[]>('/logs'),
      ])
      const names = new Map(exercises.map((e) => [e.id, e.name]))
      return (
        logs
          .filter((l) => day(l.date) >= from && day(l.date) <= to)
          .sort(byDate)
          .map(
            (l) => `${day(l.date)} ${names.get(l.exerciseId)} ${l.weight}kg×${l.reps} ${l.setType}`,
          )
          .join('\n') || `No sets between ${from} and ${to}.`
      )
    },
  }),
  makeTool({
    name: 'plates_exercise_logs',
    label: () => 'Read an exercise history from Plates',
    description:
      'Every set Josh has logged for one exercise, oldest first, one line each: date, weight×reps, set type. Get the id from plates_exercises.',
    inputSchema: z.object({ exerciseId: z.uuid() }),
    run: async ({ exerciseId }) => {
      const logs = await get<Log[]>(`/exercises/${exerciseId}/logs`)
      return (
        logs
          .sort(byDate)
          .map((l) => `${day(l.date)} ${l.weight}kg×${l.reps} ${l.setType}`)
          .join('\n') || 'No sets logged for that exercise.'
      )
    },
  }),
  makeTool({
    name: 'plates_notes',
    label: () => 'Read Plates notes',
    description: "Josh's per-day training notes from Plates, newest first.",
    inputSchema: z.object({}),
    run: async () => JSON.stringify(await get('/notes')),
  }),
  makeTool({
    name: 'plates_weigh_ins',
    label: () => 'Checked Plates weigh-ins',
    description: "Josh's bodyweight weigh-ins from Plates, newest first.",
    inputSchema: z.object({}),
    run: async () => JSON.stringify(await get('/weigh-ins')),
  }),
]
