const messages = {
  mermaidSwitchLabel: 'Mermaid 视图', mermaidDiagram: '图表', mermaidCode: '代码',
  mermaidEmpty: '无图表内容', mermaidRenderFail: '图表无法渲染', mermaidLoading: '正在渲染图表',
  htmlSwitchLabel: 'HTML 视图', htmlSource: '源码', htmlPreview: '预览', htmlPreviewTitle: 'HTML 预览', htmlPreviewLoading: '正在加载预览',
  copy: '复制', copied: '已复制', copyFailed: '复制失败',
}
const translate = (key: keyof typeof messages) => messages[key]
export const useTranslate = () => translate
