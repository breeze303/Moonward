export const MiB = 1024 * 1024
export const MAX_FILE_BYTES = 5 * MiB
export const MAX_TURN_BYTES = 10 * MiB
export const MAX_FILES = 8
export const DEFAULT_MODEL_LIMITS = { outputTokens: 8_192, contextChars: 120_000 }
export const MAX_MODEL_LIMITS = { outputTokens: 128_000, contextChars: 1_000_000 }
export const MIN_OUTPUT_TOKENS = 16
export const MAX_MODELS = 50
export const acceptedMime = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain'] as const
export type FileMime = (typeof acceptedMime)[number]
export const effortLevels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof effortLevels)[number]
export type ReplyStatus = 'queued' | 'streaming' | 'completed' | 'stopped' | 'failed' | 'incomplete' | 'interrupted'
export type Citation = { url: string; title: string; start?: number; end?: number }
export type FileView = { id: string; name: string; mime: FileMime; size: number }
export type FileInput = { name: string; mime: FileMime; data: string }
export type ModelLimits = typeof DEFAULT_MODEL_LIMITS
export type Model = { id: string; label: string; vision: boolean; files: boolean; web: boolean; efforts: Effort[]; defaultEffort: Effort | null; limits: ModelLimits }
export type ModelConfig = Model & { enabled: boolean; summary: boolean }
export type ModelSelection = { models: ModelConfig[]; defaultId: string | null }
export type ModelCatalog = ModelSelection & { version: number }
export type GatewaySettings = { version: number; baseUrl: string; hasKey: boolean }
export type Thinking = { active: boolean; elapsedMs: number | null; summary: string }
export const MIN_PASSWORD_LENGTH = 10
export const MAX_PASSWORD_LENGTH = 128
export type Usage = { count: number; limit: number; day: string; inputTokens: number; outputTokens: number }
export type User = { id: string; name: string; email: string; role: 'admin' | 'user'; usage: Usage }
export type AdminUser = User & { disabled: boolean }
export type AdminUserInput = { email: string; name: string; password: string; limit?: number }
export type AdminUserPatch = Partial<AdminUserInput> & { disabled?: boolean }
export type Capacity = { running: number; waiting: number }
export type AdminAccountsView = { users: AdminUser[]; site: Usage; defaultUserLimit: number; capacity?:Capacity }
export type ChatSummary = { id: string; title: string; version: number; updatedAt: number; titlePending?: true }
export type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  status: ReplyStatus
  error: string | null
  model: string | null
  thinking: Thinking | null
  citations: Citation[]
  files: FileView[]
  siblings: string[]
}
export type Chat = ChatSummary & { messages: Message[]; activeRunId: string | null; cursor?: number }
export type RunReceipt = { runId: string; chat: Chat }
export type Turn = {
  chatId: string
  version: number
  action: 'send' | 'edit' | 'retry'
  target?: string
  text?: string
  files?: FileInput[]
  model: string
  effort?: Effort
  web?: boolean
}
export type ChatEvent =
  | { type: 'start'; chat: Chat }
  | { type: 'running' }
  | { type: 'delta'; content: string }
  | { type: 'replace'; content: string }
  | { type: 'thinking'; thinking: Thinking }
  | { type: 'done'; chat: Chat; usage: Usage }
  | { type: 'error'; code: string }
