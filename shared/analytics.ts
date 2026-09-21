export const userSortKeys = ['displayName', 'activeDays', 'interactions', 'successes', 'messages', 'conversations', 'totalTokens', 'skillLoads', 'features', 'lastSeen'] as const
export type UserSortKey = typeof userSortKeys[number]
