import type { FileInput, ChatEvent, RunReceipt, Turn } from '../../../shared/contract.ts'
import { readServerSentEvents } from './sse.ts'

const labels: Record<string, string> = {
  queue_full: '等待队列已满，请稍后重试。',
  unauthenticated: '登录已过期，请重新登录。', disabled: '此账号已停用。', forbidden: '没有操作权限。',
  not_found: '找不到这项内容。', invalid_origin: '站点地址与服务器配置不一致。', invalid_input: '请检查输入后重试。',
  invalid_credentials: '邮箱或密码不正确。',
  setup_required: '站点尚未初始化。', admin_exists: '站点已经初始化，请登录。',
  invite_invalid: '邀请已过期、已使用或无效。', email_exists: '此邮箱已注册。', signup_failed: '创建账号失败，请稍后重试。',
  cannot_disable_admin: '不能停用管理员。', cannot_delete_admin: '不能删除管理员。', rate_limited: '尝试次数过多，请稍后再试。',
  credential_missing: '此账号的密码记录异常，无法修改密码。',
  user_limit: '你已用完今日次数。', site_limit: '本站今日额度已用完。', user_busy: '你的并发生成已达上限，请等任意一条结束后再试。',
  site_busy: '目前有太多对话正在生成，请稍后重试。', chat_busy: '这段对话正在生成，请等待回复完成。',
  conflict: '对话已在另一设备更新。已刷新，请确认后重试。', invalid_branch: '无法在当前分支执行此操作。',
  chat_limit: '已达到会话数量上限。', message_limit: '当前会话已达到消息上限，请新建会话。',
  gateway_unconfigured: '站点尚未配置模型网关。', gateway_models: '暂时无法读取模型列表，请稍后重试。',
  gateway_auth: '网关拒绝了 API Key，请确认密钥及权限。', gateway_url: '请输入有效的公网 HTTPS API 基础地址。',
  gateway_key_required: '首次设置或更换 API 地址时，需要输入 API Key。', gateway_key_unreadable: '现有 API Key 无法解密，请联系管理员重新输入。',
  gateway_busy: '有对话正在排队或生成，请等任务结束后再修改 API 配置。', gateway_conflict: '网关配置已更新，请刷新后重试。',
  model_unavailable: '当前模型不可用，请重新选择。', model_attachment: '所选模型不支持当前分支里的附件类型。',
  catalog_conflict: '模型配置已被更新，请重新读取后再编辑。',
  model_feature: '当前模型不支持所选的推理或联网设置。', attachment_too_large: '附件超过单个 5 MiB 或单轮 10 MiB 的限制。',
  payload_too_large: '请求太大，请减少附件或文字。', invalid_file: '文件内容或格式不受支持。',
  context_too_large: '当前分支的上下文或累计附件已超限，请缩短输入或新建会话。', file_quota: '附件存储已满，请删除不再需要的会话。',
  upstream_failed: '模型请求失败，可以手动重试。', upstream_limit: '网关达到限额，请稍后再试。',
  upstream_timeout: '等待模型响应超时。已收到的内容会保留。', interrupted: '连接已中断。已收到的内容会保留。',
  upstream_interrupted: '模型网关提前断开。已收到的内容会保留。',
  incomplete: '模型没有完成这条回复。', reply_too_large: '回复超过当前模型的输出保护阈值。已收到的内容会保留。',
  upstream_output_limit: '已达到上游生成 token 上限。已收到的内容会保留。',
  save_failed: '暂时无法保存回复，请刷新核对历史。', internal_error: '服务暂时不可用，请稍后重试。', unavailable: '站点正在重启，请稍后重试。',
  network: '无法连接站点，请检查网络。',
}

export class ApiError extends Error {
  code: string
  status: number
  constructor(code: string, status = 0) {
    super(labels[code] || (status === 401 ? labels.unauthenticated : labels.internal_error))
    this.code = code
    this.status = status
  }
}

export const label = (code: string) => labels[code] || labels.internal_error
export const errorText = (error: unknown) => error instanceof ApiError ? error.message : labels.network

async function request(path: string, method: string, data?: unknown, signal?: AbortSignal) {
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      method, signal, cache: 'no-store',
      ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ApiError('network')
  }
  if (!response.ok) {
    const result = await response.json().catch(() => null) as { code?: string } | null
    throw new ApiError(result?.code || (response.status === 401 ? 'unauthenticated' : 'internal_error'), response.status)
  }
  return response
}

export async function api<T>(path: string, method = 'GET', data?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await request(path, method, data, signal)
  return res.status === 204 ? undefined as T : res.json() as Promise<T>
}

export const enqueue = (turn: Turn, signal: AbortSignal) => api<RunReceipt>('/runs', 'POST', turn, signal)

export async function* respond(runId: string, signal: AbortSignal) {
  const res = await request(`/runs/${runId}/events`, 'GET', undefined, signal)
  if (!res.body || !res.headers.get('Content-Type')?.includes('text/event-stream')) throw new ApiError('upstream_failed')
  try {
    for await (const { data } of readServerSentEvents(res.body, signal)) yield JSON.parse(data) as ChatEvent
  } catch (failure) {
    if (signal.aborted) throw failure
    throw new ApiError('interrupted')
  }
}

export function encodeFile(file: File, mime: FileInput['mime']): Promise<FileInput> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new ApiError('invalid_file'))
    reader.onload = () => resolve({ name: file.name, mime, data: String(reader.result).split(',', 2)[1] })
    reader.readAsDataURL(file)
  })
}
