// A friendly status phrase per tool, given how many times it ran this flush.
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export const toolLabels: Record<string, (n: number) => string> = {
  update_memory: () => 'Updated memory',
  web_search: (n) => (n === 1 ? 'Searched the web' : `Ran ${n} web searches`),
  web_extract: (n) => `Read ${plural(n, 'page')}`,
  create_reminder: (n) => `Set ${plural(n, 'reminder')}`,
  delete_reminder: (n) => `Cancelled ${plural(n, 'reminder')}`,
  list_reminders: () => 'Checked reminders',
  channel_tree: () => 'Looked at the channels',
  create_category: (n) => `Created ${plural(n, 'category', 'categories')}`,
  delete_category: (n) => `Deleted ${plural(n, 'category', 'categories')}`,
  set_channel_category: (n) => `Moved ${plural(n, 'channel')}`,
  start_work: (n) => `Handed off ${plural(n, 'task')} to Claude Code`,
}
