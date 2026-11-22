export interface HistoricalMessage { role: 'user' | 'assistant'; kind: string; threadId: string; runId: string | null; itemId: string; providerThreadId: string | null; status: string; text: string }
export function handoffBudget(input: {tokenCap: number; userText: string; attachments: {type: string}[]; providerThread: {contextUsage: {usedTokens: number; maxTokens?: number} | null}; nativeContextEstimate: number; modelContextWindow?: number}): number
export function selectHistory(input: { messages: HistoricalMessage[]; budget: number; coverage: string; omittedItems?: number; omittedItemIds?: string[] }): {messages: HistoricalMessage[]; context: string; omittedItems: number; omittedItemIds: string[]}
export function renderHistory(messages: HistoricalMessage[], context: string): string
export function historyCost(messages: HistoricalMessage[], context: string): number
