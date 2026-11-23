import { defaultTreeAdapter as tree, html, parse, serialize } from 'parse5'
import type { DefaultTreeAdapterTypes as AST } from 'parse5'

const tags = new Set(`
  html head body title style
  a abbr address article aside b bdi bdo blockquote br caption cite code col colgroup
  data dd del details dfn div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6
  header hgroup hr i img ins kbd li main mark menu nav ol p picture pre q rp rt ruby
  s samp section small span strong sub summary sup table tbody td th thead time tr tfoot
  u ul var wbr button fieldset form input label legend meter optgroup option output
  progress select textarea
`.trim().split(/\s+/))
const attributes = new Set(`
  id class style title lang dir hidden role open alt width height colspan rowspan scope
  start reversed value type checked selected disabled readonly placeholder for multiple
  min max step low high optimum rows cols size datetime
`.trim().split(/\s+/))
const svgTags = new Set(`
  svg g defs symbol use title desc style path rect circle ellipse line polyline polygon text tspan textPath
  linearGradient radialGradient stop clipPath mask pattern marker
  filter feBlend feColorMatrix feComposite feDropShadow feFlood feGaussianBlur feMerge feMergeNode feOffset
  animate animateTransform animateMotion mpath set
`.trim().split(/\s+/))
const svgAttributes = new Set(`
  id class style role width height viewBox preserveAspectRatio
  x y x1 y1 x2 y2 cx cy r rx ry dx dy d points pathLength transform transform-origin transform-box
  fill fill-opacity fill-rule stroke stroke-opacity stroke-width stroke-linecap stroke-linejoin
  stroke-dasharray stroke-dashoffset stroke-miterlimit paint-order vector-effect color opacity display visibility
  font-family font-size font-weight font-style text-anchor dominant-baseline alignment-baseline
  textLength lengthAdjust startOffset rotate
  gradientUnits gradientTransform spreadMethod fx fy fr offset stop-color stop-opacity
  clip-path clip-rule clipPathUnits mask maskUnits maskContentUnits patternUnits patternContentUnits patternTransform
  marker-start marker-mid marker-end markerUnits markerWidth markerHeight refX refY orient
  filter filterUnits primitiveUnits in in2 result mode type values operator k1 k2 k3 k4 stdDeviation flood-color flood-opacity
`.trim().split(/\s+/))
const animationTags = new Set(['animate', 'animateTransform', 'animateMotion', 'set'])
const animationAttributes = new Set(`
  attributeName attributeType begin end dur min max repeatCount repeatDur restart
  from to by values calcMode keyTimes keySplines additive accumulate path keyPoints
`.trim().split(/\s+/))
const animationTargets = new Set(`
  x y x1 y1 x2 y2 cx cy r rx ry dx dy d points pathLength viewBox
  transform gradientTransform patternTransform
  opacity fill fill-opacity stroke stroke-opacity stroke-width stroke-dasharray stroke-dashoffset
  color stop-color stop-opacity offset visibility
`.trim().split(/\s+/))
const fragmentTags = new Set(['use', 'mpath', 'textPath', 'linearGradient', 'radialGradient', 'pattern'])
const localFragment = /^#[\w.-][\w.:-]*$/
const embeddedImage = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/]+={0,2}$/i
const policy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

function isAnnotation(name: string) {
  return name.startsWith('aria-') || name.startsWith('data-')
}

function sanitizeSvg(node: AST.Element) {
  const { tagName } = node
  if (!svgTags.has(tagName)) return false
  const animation = animationTags.has(tagName)
  if (animation) {
    // SMIL can change attributes after parsing, so its target must be safe as well.
    const target = node.attrs.find(({ name, namespace }) => !namespace && name === 'attributeName')?.value
    if (tagName !== 'animateMotion' && (!target || !animationTargets.has(target))) return false
  }
  node.attrs = node.attrs.filter(({ name, value, namespace }) => {
    if (name === 'href') {
      return (!namespace || namespace === html.NS.XLINK) && (animation || fragmentTags.has(tagName)) && localFragment.test(value)
    }
    if (namespace) return false
    if (name === 'attributeName' && tagName === 'animateMotion') return false
    return svgAttributes.has(name) || isAnnotation(name) || (animation && animationAttributes.has(name))
  })
  return true
}

export function htmlPreviewDocument(source: string) {
  // The HTML parser runs without a browser document. Nothing from the input can load during parsing.
  const doc = parse(source, { scriptingEnabled: false })
  const htmlElement = doc.childNodes.find((node): node is AST.Element => tree.isElementNode(node) && node.tagName === 'html')!
  const head = htmlElement.childNodes.find((node): node is AST.Element => tree.isElementNode(node) && node.tagName === 'head')!
  const pending: AST.ParentNode[] = [doc]
  while (pending.length) {
    const parent = pending.pop()!
    const inSvg = tree.isElementNode(parent) && parent.namespaceURI === html.NS.SVG
    parent.childNodes = parent.childNodes.filter((node) => {
      if (tree.isTextNode(node)) return true
      if (!tree.isElementNode(node)) return false
      if (node.namespaceURI === html.NS.SVG) {
        if ((!inSvg && node.tagName !== 'svg') || !sanitizeSvg(node)) return false
      } else {
        if (inSvg || node.namespaceURI !== html.NS.HTML || !tags.has(node.tagName)) return false
        node.attrs = node.attrs.filter(({ name, value, namespace }) => !namespace && (attributes.has(name) || isAnnotation(name) ||
          (node.tagName === 'img' && name === 'src' && embeddedImage.test(value))))
      }
      pending.push(node)
      return true
    })
  }
  // The fixed policy must precede model-provided CSS and markup in the isolated frame.
  const meta = (attrs: AST.Element['attrs']) => tree.createElement('meta', html.NS.HTML, attrs)
  const csp = meta([{ name: 'http-equiv', value: 'Content-Security-Policy' }, { name: 'content', value: policy }])
  if (head.childNodes.length) tree.insertBefore(head, csp, head.childNodes[0])
  else tree.appendChild(head, csp)
  tree.appendChild(head, meta([{ name: 'name', value: 'viewport' }, { name: 'content', value: 'width=device-width, initial-scale=1' }]))
  return `<!doctype html>${serialize(doc, { scriptingEnabled: false })}`
}
