import { z } from 'zod'
import { CategoryChannel, ChannelType, type Client, type Guild, TextChannel } from 'discord.js'
import { makeTool } from '../makeTool'
import { fetchNonBotUsers, getAllThreads } from '../../discord/utils'
import { log } from '../../logger'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function channelTreeTool(client: Client, guild: Guild) {
  return makeTool({
    name: 'channel_tree',
    label: () => 'Looked at the channels',
    description:
      "Show the server's channels grouped by category, each channel and category with its id, its topic where it has one, and any threads nested under their channel. Reach for it to see what exists and grab the ids you need before linking a channel or thread with `<#id>`, creating a channel or category, deleting a category, moving a channel, or editing a channel's name or topic.",
    inputSchema: z.object({}),
    run: async () => {
      const threads = await getAllThreads(guild)
      const textChannels = client.channels.cache
        .values()
        .filter((c): c is TextChannel => c.type === ChannelType.GuildText)
        .toArray()
        .sort((a, b) => a.position - b.position)

      const threadsFor = (channel: TextChannel) => {
        return threads.filter((t) => t.parentId === channel.id)
      }

      const renderChildren = (channels: TextChannel[]) => {
        return channels
          .map((c) => {
            const threadLines = threadsFor(c).map((t) => `    - ${t.name} (${t.id})`)
            return [`- #${c.name} (${c.id})${c.topic ? ` "${c.topic}"` : ''}`, ...threadLines].join(
              '\n',
            )
          })
          .join('\n')
      }

      const categories = client.channels.cache
        .values()
        .filter((c): c is CategoryChannel => c.type === ChannelType.GuildCategory)
        .toArray()
        .sort((a, b) => a.position - b.position)
      const channelsByCategories = new Map<CategoryChannel | null, TextChannel[]>()
      categories.forEach((c) => channelsByCategories.set(c, []))
      for (const channel of textChannels) {
        const existing = channelsByCategories.get(channel.parent) ?? []
        channelsByCategories.set(channel.parent, [...existing, channel])
      }

      return channelsByCategories
        .entries()
        .map(
          ([category, channels]) =>
            `${category ? `${category.name} (${category.id})` : 'No Category'}\n${renderChildren(channels)}`,
        )
        .toArray()
        .join('\n\n')
    },
  })
}

export function createChannelTool(guild: Guild) {
  return makeTool({
    name: 'create_channel',
    label: (n) => `Created ${plural(n, 'channel')}`,
    description:
      'Create a new text channel or category by name and return its id. A new text channel lands outside any category; move it with set_channel_category. Fails if something of the same type with that name already exists.',
    inputSchema: z.object({
      type: z
        .enum(['text', 'category'])
        .describe('Whether to create a text channel or a category.'),
      name: z.string().describe('The name for the new channel or category.'),
      topic: z
        .string()
        .optional()
        .describe(
          'Optional topic for a text channel: the one-line description shown under its name. Categories cannot have one.',
        ),
    }),
    run: async ({ type, name, topic }) => {
      if (topic !== undefined && type !== 'text') {
        throw new Error('Only text channels can have a topic.')
      }
      const channelType = type === 'text' ? ChannelType.GuildText : ChannelType.GuildCategory
      const wanted =
        type === 'text' ? name.trim().toLowerCase().replace(/\s+/g, '-') : name.toLowerCase()
      const taken = guild.channels.cache.some(
        (c) => c.type === channelType && c.name.toLowerCase() === wanted,
      )
      if (taken) {
        throw new Error(
          `A ${type === 'text' ? 'text channel' : 'category'} named "${name}" already exists.`,
        )
      }

      const created = await guild.channels.create({ name, type: channelType, topic })
      return type === 'text'
        ? `Created text channel #${created.name} (${created.id}).`
        : `Created category "${created.name}" (${created.id}).`
    },
  })
}

export function createThreadTool(guild: Guild) {
  return makeTool({
    name: 'create_thread',
    label: (n) => `Created ${plural(n, 'thread')}`,
    description:
      'Create a new thread in a text channel by name and return its id. Fails if something of the same name already exists in that channel.',
    inputSchema: z.object({
      channelId: z.string().describe('The id of the text channel to create the thread in.'),
      name: z
        .string()
        .describe(
          'The name for the new thread. Stick to a lowercase hyphenated name like channel names.',
        ),
    }),
    run: async ({ channelId, name }) => {
      const channel = guild.channels.cache.get(channelId)
      if (!channel || channel.type !== ChannelType.GuildText) {
        throw new Error(`No text channel found with id ${channelId}.`)
      }
      const wanted = name.trim().toLowerCase().replace(/\s+/g, '-')
      const taken = channel.threads.cache.some((t) => t.name.toLowerCase() === wanted)
      if (taken) {
        throw new Error(`A thread named "${name}" already exists in #${channel.name}.`)
      }

      const created = await channel.threads.create({ name })
      for (const member of await fetchNonBotUsers(guild)) {
        await created.members
          .add(member.id)
          .catch((err) =>
            log.error({ err, threadId: created.id, userId: member.id }, 'Thread add failed'),
          )
      }
      return `Created thread #${created.name} (${created.id}) in #${channel.name}.`
    },
  })
}

export function deleteCategoryTool(client: Client) {
  return makeTool({
    name: 'delete_category',
    label: (n) => `Deleted ${plural(n, 'category', 'categories')}`,
    description:
      'Delete a category by id. Its channels are not deleted — they just become uncategorised. Reports how many were orphaned.',
    inputSchema: z.object({
      categoryId: z.string().describe('The id of the category to delete.'),
    }),
    run: async ({ categoryId }) => {
      const category = client.channels.cache.get(categoryId)
      if (category?.type !== ChannelType.GuildCategory) {
        throw new Error(`No category found with id ${categoryId}.`)
      }
      const orphaned = category.children.cache.size
      const { name } = category
      await category.delete()
      return (
        `Deleted category "${name}".` +
        (orphaned ? ` ${orphaned} channel${orphaned === 1 ? '' : 's'} now uncategorised.` : '')
      )
    },
  })
}

export function setChannelCategoryTool(client: Client) {
  return makeTool({
    name: 'set_channel_category',
    label: (n) => `Moved ${plural(n, 'channel')}`,
    description:
      'Move a text channel into a category, or out of any category. Pass the channel id and the target category id (or null to remove it from its category). Get the ids from channel_tree.',
    inputSchema: z.object({
      channelId: z.string().describe('The id of the channel to move.'),
      categoryId: z
        .string()
        .nullable()
        .describe(
          'The id of the category to move it into, or null to remove it from any category.',
        ),
    }),
    run: async ({ channelId, categoryId }) => {
      const channel = client.channels.cache.get(channelId)
      if (channel?.type !== ChannelType.GuildText) {
        throw new Error(`No text channel found with id ${channelId}.`)
      }
      let categoryName: string | null = null
      if (categoryId !== null) {
        const category = client.channels.cache.get(categoryId)
        if (category?.type !== ChannelType.GuildCategory) {
          throw new Error(`No category found with id ${categoryId}.`)
        }
        categoryName = category.name
      }
      await channel.setParent(categoryId, { lockPermissions: false })
      return categoryName
        ? `Moved #${channel.name} into "${categoryName}".`
        : `Removed #${channel.name} from its category.`
    },
  })
}

export function editChannelTool(client: Client) {
  return makeTool({
    name: 'edit_channel',
    label: (n) => `Edited ${plural(n, 'channel')}`,
    description:
      'Rename a text channel, set its topic, or both. The topic is the one-line description shown ' +
      'under the channel name, good for saying what the channel is for. Pass the channel id and ' +
      'whichever of name and topic you want to change; leave a field out to keep it as it is, or ' +
      'pass an empty topic to clear it. Get ids from channel_tree.',
    inputSchema: z.object({
      channelId: z.string().describe('The id of the text channel to edit.'),
      name: z
        .string()
        .optional()
        .describe('New name. Stick to a lowercase hyphenated name like the other channels.'),
      topic: z.string().optional().describe('New topic, or an empty string to clear it.'),
    }),
    run: async ({ channelId, name, topic }) => {
      const channel = client.channels.cache.get(channelId)
      if (channel?.type !== ChannelType.GuildText) {
        throw new Error(`No text channel found with id ${channelId}.`)
      }
      if (name === undefined && topic === undefined) {
        throw new Error('Nothing to change: pass a name, a topic, or both.')
      }
      await channel.edit({ name, topic })
      return `Edited #${channel.name} (${channelId}).`
    },
  })
}

export function renameCategoryTool(client: Client) {
  return makeTool({
    name: 'rename_category',
    label: (n) => `Renamed ${plural(n, 'category', 'categories')}`,
    description:
      'Rename a category by id. Pass the category id and the new name. Get the ids from channel_tree.',
    inputSchema: z.object({
      categoryId: z.string().describe('The id of the category to rename.'),
      newName: z.string().describe('The new name for the category.'),
    }),
    run: async ({ categoryId, newName }) => {
      const category = client.channels.cache.get(categoryId)
      if (category?.type !== ChannelType.GuildCategory) {
        throw new Error(`No category found with id ${categoryId}.`)
      }
      const oldName = category.name
      await category.setName(newName)
      return `Renamed category "${oldName}" (${categoryId}) to "${newName}".`
    },
  })
}

export function postMessageTool(client: Client) {
  return makeTool({
    name: 'post_message',
    description:
      'Post a new message to a specific channel or thread by id, not necessarily the one you are in. ' +
      'Use it to say something in a different channel, like leaving a note where it belongs or flagging ' +
      'something elsewhere; get ids from channel_tree. This is not how you reply to the current ' +
      'conversation (that is just the text you write back), so reach for it only when you mean a specific other channel.',
    inputSchema: z.object({
      channelId: z.string().describe('The id of the channel or thread to post in.'),
      content: z.string().describe('The message content to post.'),
    }),
    label(n) {
      return `Posted ${plural(n, 'message')}`
    },
    run: async ({ channelId, content }) => {
      const channel = await client.channels.fetch(channelId).catch(() => null)
      if (!channel || !channel.isTextBased() || channel.isDMBased()) {
        throw new Error(
          'No text channel or thread with that id. Call channel_tree for the list of ids.',
        )
      }
      const sent = await channel.send({ content })
      return `Posted message in <#${channelId}> (id ${sent.id}).`
    },
  })
}

export function editMessageTool(client: Client) {
  return makeTool({
    name: 'edit_message',
    description:
      'Edit one of your own past messages by id, replacing its whole content (Discord only lets a bot ' +
      'edit messages it sent). Pass the channel or thread id and the message id, from search_messages or ' +
      'the recent transcript. Use it to fix or update something you posted rather than posting a correction.',
    inputSchema: z.object({
      channelId: z.string().describe('The id of the channel or thread containing the message.'),
      messageId: z.string().describe('The id of the message to edit.'),
      newContent: z.string().describe('The new content for the message.'),
    }),
    label(n) {
      return `Edited ${plural(n, 'message')}`
    },
    run: async ({ messageId, newContent, channelId }) => {
      const channel = await client.channels.fetch(channelId).catch(() => null)
      if (!channel || !channel.isTextBased() || channel.isDMBased()) {
        throw new Error(
          'No text channel or thread with that id. Call channel_tree for the list of ids.',
        )
      }
      const message = await channel.messages.fetch(messageId).catch(() => null)
      if (!message) {
        throw new Error(`No message found with id ${messageId} in channel ${channelId}.`)
      }
      await message.edit({ content: newContent })
      return `Edited message ${messageId} in <#${channelId}>.`
    },
  })
}

export function pinMessageTool(client: Client) {
  return makeTool({
    name: 'pin_message',
    description:
      'Pin a message by id so it stays at the top of its channel or thread. Pass the channel or thread ' +
      'id and the message id, from search_messages or the recent transcript. Reach for it when the user ' +
      'asks to pin something, or when a message is worth keeping handy.',
    inputSchema: z.object({
      channelId: z.string().describe('The id of the channel or thread containing the message.'),
      messageId: z.string().describe('The id of the message to pin.'),
    }),
    label(n) {
      return `Pinned ${plural(n, 'message')}`
    },
    run: async ({ messageId, channelId }) => {
      const channel = await client.channels.fetch(channelId).catch(() => null)
      if (!channel || !channel.isTextBased() || channel.isDMBased()) {
        throw new Error(
          'No text channel or thread with that id. Call channel_tree for the list of ids.',
        )
      }
      const message = await channel.messages.fetch(messageId).catch(() => null)
      if (!message) {
        throw new Error(`No message found with id ${messageId} in channel ${channelId}.`)
      }
      await message.pin()
      return `Pinned message ${messageId} in <#${channelId}>.`
    },
  })
}
