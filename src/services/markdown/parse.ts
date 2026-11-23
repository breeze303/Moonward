import type { Node as MdAstNode, Nodes, Parent, RootContent, Root, Text } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { cjkFriendlyExtension } from 'micromark-extension-cjk-friendly'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-llm-math'
import type { Citation } from '../../../shared/contract.ts'

export type Source = Citation & { index: number }

export interface CitationNode extends MdAstNode {
  type: 'citation'
  source: Source
}

declare module 'mdast' {
  interface RootContentMap {
    citation: CitationNode
  }

  interface PhrasingContentMap {
    citation: CitationNode
  }
}

const text = (value: string): Text => ({ type: 'text', value })

/**
 * 解析正文，并把渲染器不单独处理的节点提前换掉，渲染时无需再读原文：
 * - Sources are inserted into the AST without changing Markdown syntax or code fences.
 * - disableLink 时链接只保留文字
 * - 删除线保留原样的 ~ 定界符，脚注、引用式链接与定义显示原文
 */
export function toMdAst(
  input: string,
  { sources, disableLink }: { sources: Citation[] | undefined; disableLink: boolean }
): Root {
  const ast = fromMarkdown(input, {
    extensions: [
      // codeIndented 语法导致有前导空格的列表无法正常渲染
      { ...gfm(), disable: { null: ['codeIndented'] } },
      cjkFriendlyExtension(),
      math({ singleDollarTextMath: true }),
    ],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  })
  const raw = (node: Nodes) => input.slice(node.position?.start.offset, node.position?.end.offset)
  // 先处理子节点，再按需把当前节点换成若干节点
  const simplify = (node: Nodes): Nodes[] => {
    if ('children' in node) {
      ;(node as Parent).children = node.children.flatMap(simplify) as RootContent[]
    }
    switch (node.type) {
      case 'link':
        return disableLink ? node.children : [node]
      case 'delete': {
        // 解析器保证首尾定界符等长
        const delimiter = raw(node).match(/^~+/)?.[0] ?? ''
        return [text(delimiter), ...node.children, text(delimiter)]
      }
      case 'footnoteReference':
      case 'imageReference':
      case 'linkReference':
        return [text(raw(node))]
      case 'footnoteDefinition':
      case 'definition':
        return [{ type: 'paragraph', children: [text(raw(node))] }]
      default:
        return [node]
    }
  }
  simplify(ast)
  const textBlocks: Extract<Nodes, { type: 'paragraph' | 'heading' }>[] = []
  const visit = (node: Nodes) => {
    if ((node.type === 'paragraph' || node.type === 'heading') && node.position) textBlocks.push(node)
    else if ('children' in node) node.children.forEach(visit)
  }
  if (sources?.length) visit(ast)
  sources?.forEach((source, i) => {
    if (source.end === undefined) return
    const end = source.end
    const block = textBlocks.find((node) => (node.position!.start.offset ?? 0) < end && end <= (node.position!.end.offset ?? 0))
    if (block) block.children.push({ type: 'citation', source: { ...source, index: i + 1 } })
  })
  return ast
}
