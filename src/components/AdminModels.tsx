import { Check, PencilLine, Plus, RefreshCw, RotateCcw, Star, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DEFAULT_MODEL_LIMITS, effortLevels, MAX_MODEL_LIMITS, MAX_MODELS, MIN_OUTPUT_TOKENS } from '../../shared/contract.ts'
import type { ModelCatalog, ModelConfig, ModelSelection } from '../../shared/contract.ts'
import { api, errorText } from '../services/api/appClient.ts'
import { effortNames } from './ModelControls.tsx'
import { IconButton, Loading, Modal, Notice } from './ui.tsx'
import styles from './AdminModels.module.css'

const emptyModel: ModelConfig = {
  id: '', label: '', enabled: true, vision: false, files: false, web: false, efforts: [], defaultEffort: null, summary: false,
  limits: DEFAULT_MODEL_LIMITS,
}

const capabilities = [
  ['vision', '图片理解'], ['files', '文档附件'], ['web', '联网搜索'], ['summary', '请求公开思考摘要'],
] as const

export function AdminModels({ changed }: { changed: () => void }) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [available, setAvailable] = useState<string[] | null>(null)
  const [reading, setReading] = useState(false)
  const [gatewayError, setGatewayError] = useState('')
  const [editor, setEditor] = useState<ModelConfig | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [extractor,setExtractor]=useState<{model:string|null;calls:number;failures:number}|null>(null)
  useEffect(()=>{void api<NonNullable<typeof extractor>>('/admin/memory').then(setExtractor).catch(()=>{})},[])

  async function refreshCatalog() {
    setError(''); setNotice('')
    try { setCatalog(await api<ModelCatalog>('/admin/models')) } catch (failure) { setError(errorText(failure)) }
  }

  async function refreshGateway(refresh = false) {
    setReading(true); setGatewayError('')
    try { setAvailable(await api<string[]>(`/admin/models/available${refresh ? '?refresh=1' : ''}`)) }
    catch (failure) { setAvailable(null); setGatewayError(errorText(failure)) }
    finally { setReading(false) }
  }

  useEffect(() => { void refreshCatalog(); void refreshGateway() }, [])

  async function save({ models, defaultId }: ModelSelection) {
    if (!catalog || pending) return
    setPending(true); setError(''); setNotice('')
    try {
      const selected = models.find((model) => model.id === defaultId && model.enabled) ?? models.find((model) => model.enabled)
      setCatalog(await api<ModelCatalog>('/admin/models', 'PUT', { version: catalog.version, selection: { models, defaultId: selected?.id ?? null } }))
      setEditor(null); setNotice('模型配置已保存')
      changed()
    } catch (failure) { setError(errorText(failure)) }
    finally { setPending(false) }
  }

  function edit(model: ModelConfig) { setError(''); setNotice(''); setEditor(model) }
  function closeEditor() { if (!pending) { setEditor(null); setError('') } }

  return <section aria-label="模型管理">
    {extractor&&catalog&&<label>自动记忆提取模型 <select value={extractor.model??''} disabled={pending} onChange={async e=>{const model=e.target.value||null;setPending(true);try{await api('/admin/memory','PUT',{model});setExtractor({...extractor,model})}catch(e){setError(errorText(e))}finally{setPending(false)}}}><option value="">不提取</option>{catalog.models.filter(m=>m.enabled).map(m=><option key={m.id} value={m.id}>{m.label}</option>)}</select><small> 调用 {extractor.calls} · 失败 {extractor.failures}</small></label>}
    <div className={styles.toolbar}>
      <h2>模型目录</h2>
      <div className="actions">
        <IconButton label="重新读取模型配置" disabled={pending} onClick={() => void refreshCatalog()}><RotateCcw size={16} /></IconButton>
        <IconButton label="刷新网关模型" disabled={reading || pending} onClick={() => void refreshGateway(true)}><RefreshCw size={16} className={reading ? 'spinner' : undefined} /></IconButton>
        <button type="button" className="button primary" disabled={!catalog || pending || catalog.models.length >= MAX_MODELS} onClick={() => edit(emptyModel)}><Plus size={16} />添加模型</button>
      </div>
    </div>
    {gatewayError && <Notice>{gatewayError}</Notice>}
    {error && !editor && <Notice>{error}</Notice>}
    {!catalog ? !error && <Loading /> : <>
      <div className={styles.meta}>
        <span>{catalog.models.length ? `${catalog.models.length} 个模型` : '暂无模型'}</span>
      </div>
      <ul className={styles.modelList}>
        {catalog.models.map((model) => {
          const isDefault = catalog.defaultId === model.id
          const listed = available?.includes(model.id)
          return <li key={model.id}>
            <div className={styles.identity}><strong>{model.label}</strong>{model.label !== model.id && <code>{model.id}</code>}</div>
            <div className={styles.status}>
              {isDefault && <span className="badge">默认</span>}
              <span className="badge muted">{model.enabled ? '已启用' : '已停用'}</span>
              <span className={listed ? styles.available : undefined}>{listed ? '网关可用' : available ? '网关未列出' : '网关未核验'}</span>
            </div>
            <div className={styles.rowActions}>
              <IconButton label={`将 ${model.label} 设为默认`} disabled={isDefault || !model.enabled || pending} onClick={() => void save({ models: catalog.models, defaultId: model.id })}>
                <Star size={16} fill={isDefault ? 'currentColor' : 'none'} />
              </IconButton>
              <IconButton label={`编辑 ${model.label}`} disabled={pending} onClick={() => edit(model)}><PencilLine size={16} /></IconButton>
            </div>
          </li>
        })}
      </ul>
      {editor && <ModelEditor initial={editor} catalog={catalog} available={available ?? []} error={error} pending={pending} close={closeEditor}
        onSave={(model) => void save({ models: editor.id ? catalog.models.map((item) => item.id === editor.id ? model : item) : [...catalog.models, model], defaultId: catalog.defaultId })}
        remove={() => void save({ models: catalog.models.filter(({ id }) => id !== editor.id), defaultId: catalog.defaultId })} />}
    </>}
    {notice && <div className={styles.saved} role="status"><Check size={16} />{notice}</div>}
  </section>
}

function ModelEditor({ initial, catalog, available, error, pending, close, onSave, remove }: {
  initial: ModelConfig; catalog: ModelCatalog; available: string[]; error: string; pending: boolean
  close: () => void; onSave: (model: ModelConfig) => void; remove: () => void
}) {
  const [draft, setDraft] = useState(initial)
  const [issue, setIssue] = useState('')
  const id = draft.id.trim()
  const isDefault = initial.id === catalog.defaultId
  const candidates = available.filter((model) => !catalog.models.some((entry) => entry.id === model))
  const update = (patch: Partial<ModelConfig>) => setDraft((previous) => ({ ...previous, ...patch }))

  return <Modal title={initial.id ? '编辑模型' : '添加模型'} className={styles.dialog} close={close}>
    {(issue || error) && <Notice>{issue || error}</Notice>}
    <form className={styles.form} onSubmit={(event) => {
      event.preventDefault()
      if (!/^[a-zA-Z0-9._:/-]{1,100}$/.test(id)) { setIssue('请输入有效的模型 ID。'); return }
      if (!initial.id && catalog.models.some((model) => model.id === id)) { setIssue('这个模型已在目录中。'); return }
      const form = new FormData(event.currentTarget)
      const limits = { contextChars: Number(form.get('contextChars')), outputTokens: Number(form.get('outputTokens')) }
      setIssue('')
      onSave({ ...draft, id, label: draft.label.trim() || id, limits })
    }}>
      <fieldset disabled={pending} className={styles.fields}>
        {!initial.id && candidates.length > 0 && <label>网关模型 <select value={candidates.includes(id) ? id : ''} onChange={(event) => {
          update({ id: event.target.value }); setIssue('')
        }}><option value="">手动输入</option>{candidates.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>}
        <label>模型 ID<input required maxLength={100} autoFocus={!initial.id} readOnly={Boolean(initial.id)} value={draft.id} onChange={(event) => {
          update({ id: event.target.value }); setIssue('')
        }} /></label>
        <label>模型显示名称<input maxLength={100} autoFocus={Boolean(initial.id)} placeholder={id || undefined} value={draft.label} onChange={(event) => update({ label: event.target.value })} /></label>
        <label className={styles.check}><input type="checkbox" checked={draft.enabled}
          onChange={(event) => update({ enabled: event.target.checked })} />启用模型{isDefault && <span className="badge">默认</span>}</label>
        <fieldset>
          <legend>模型能力</legend>
          <div className={styles.checks}>
            {capabilities.map(([key, name]) => <label key={key} className={styles.check}><input type="checkbox" checked={draft[key]} onChange={(event) => update({ [key]: event.target.checked })} />{name}</label>)}
          </div>
        </fieldset>
        <fieldset>
          <legend>可选推理深度</legend>
          <div className={styles.checks}>
            {effortLevels.map((level) => <label key={level} className={styles.check}>
              <input type="checkbox" checked={draft.efforts.includes(level)} onChange={(event) => update(event.target.checked
                ? { efforts: [...draft.efforts, level] }
                : { efforts: draft.efforts.filter((item) => item !== level), ...(draft.defaultEffort === level ? { defaultEffort: null } : {}) })} />{effortNames[level]}
            </label>)}
          </div>
        </fieldset>
        <label>默认推理深度<select value={draft.defaultEffort ?? ''} onChange={(event) => update({ defaultEffort: draft.efforts.find((level) => level === event.target.value) ?? null })}>
          <option value="">由网关决定</option>{effortLevels.filter((level) => draft.efforts.includes(level)).map((level) => <option key={level} value={level}>{effortNames[level]}</option>)}
        </select></label>
        <fieldset className={styles.limits}>
          <legend>长度限制</legend>
          <div>
            <label>上下文上限（字符）<input name="contextChars" type="number" min={1} max={MAX_MODEL_LIMITS.contextChars} step={1}
              defaultValue={initial.limits?.contextChars ?? DEFAULT_MODEL_LIMITS.contextChars} required /></label>
            <label>最大输出（token）<input name="outputTokens" type="number" min={MIN_OUTPUT_TOKENS} max={MAX_MODEL_LIMITS.outputTokens} step={1}
              defaultValue={initial.limits?.outputTokens ?? DEFAULT_MODEL_LIMITS.outputTokens} required /></label>
          </div>
        </fieldset>
      </fieldset>
      <div className={`modal-actions ${styles.footer}`}>
        {initial.id && <IconButton label="移除模型配置" className="danger-text" disabled={pending} onClick={remove}><Trash2 size={16} /></IconButton>}
        <button type="button" className="button secondary" disabled={pending} onClick={close}>取消</button>
        <button type="submit" className="button primary" disabled={pending}>保存模型</button>
      </div>
    </form>
  </Modal>
}
