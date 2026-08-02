import { readFile } from 'node:fs/promises'
import { parseSync } from 'oxc-parser'

/**
 * Facts we extract from source that no manifest contains (plan §4).
 *
 * Everything here is lexically determined. Anything that isn't — a component
 * arriving through `children`, a `.map()` over a computed list, a third-party
 * component calling a dynamic API internally — is recorded as an `unresolved`
 * entry rather than guessed at.
 */
export interface SourceFacts {
  file: string
  isClientComponent: boolean
  /** Name of the default-exported component — the route's render root. */
  defaultExportName: string | null
  /** `export const dynamic = 'force-dynamic'` and friends. */
  routeConfig: Record<string, string | number | boolean>
  hasGenerateStaticParams: boolean
  imports: ImportRef[]
  /** `cookies()`, `headers()`, `draftMode()`, `connection()`, `searchParams` access. */
  dynamicApis: SiteRef[]
  fetches: FetchRef[]
  /** `'use cache'` directives, by the function they annotate when known. */
  useCacheSites: SiteRef[]
  /**
   * Value bindings this module exports. `'*'` when it re-exports a namespace,
   * which makes the export list unknowable from this file alone. Used to decide
   * whether a module can contain taint rather than pass it upwards.
   */
  exports: string[]
  components: ComponentFacts[]
  /** Parse failures and constructs we refuse to interpret. */
  unresolved: string[]
}

export interface ImportRef {
  specifier: string
  names: string[]
  line: number
}

export interface SiteRef {
  name: string
  line: number
  column: number
  /** Enclosing function name, when the call sits inside one. */
  inFunction: string | null
}

export interface FetchRef extends SiteRef {
  caching: 'no-store' | 'force-cache' | 'revalidate' | 'default'
}

export interface ComponentFacts {
  name: string
  line: number
  isAsync: boolean
  /** JSX element names rendered directly by this component. */
  renders: string[]
  suspense: SuspenseFacts[]
  /** True when it renders `{children}` or a component held in a variable/prop. */
  hasOpaqueChildren: boolean
}

export interface SuspenseFacts {
  line: number
  column: number
  /** Element names of the fallback, e.g. `p`. */
  fallback: string[]
  /** Element names rendered inside the boundary. */
  children: string[]
}

const DYNAMIC_APIS = new Set(['cookies', 'headers', 'draftMode', 'connection'])
const ROUTE_CONFIG_KEYS = new Set(['dynamic', 'revalidate', 'runtime', 'fetchCache', 'experimental_ppr', 'maxDuration'])

export async function readSourceFacts(absPath: string, relPath: string): Promise<SourceFacts> {
  const facts: SourceFacts = {
    file: relPath,
    isClientComponent: false,
    defaultExportName: null,
    routeConfig: {},
    hasGenerateStaticParams: false,
    imports: [],
    dynamicApis: [],
    fetches: [],
    useCacheSites: [],
    exports: [],
    components: [],
    unresolved: [],
  }

  let code: string
  try {
    code = await readFile(absPath, 'utf8')
  } catch {
    facts.unresolved.push('file could not be read')
    return facts
  }

  let program: OxcNode
  try {
    const result = parseSync(absPath, code, { sourceType: 'module' })
    if (result.errors.length > 0) {
      facts.unresolved.push(`${result.errors.length} parse error(s); facts may be incomplete`)
    }
    program = result.program as unknown as OxcNode
  } catch (error) {
    facts.unresolved.push(`parser threw: ${(error as Error).message}`)
    return facts
  }

  const lineIndex = buildLineIndex(code)
  const at = (offset: number) => positionAt(lineIndex, offset)

  facts.isClientComponent = hasDirective(program, 'use client')

  walk(program, null, (node, fnName) => {
    switch (node.type) {
      case 'ImportDeclaration':
        // `import type` is erased before anything reaches a bundler, so a
        // type-only edge can never affect bundle size or the client boundary.
        // Following them also produces a flood of unresolvable-import warnings
        // for type aliases that no runtime resolver is meant to find.
        if (node.importKind === 'type') break
        facts.imports.push({
          specifier: String(node.source?.value ?? ''),
          names: (node.specifiers ?? []).map(importedName),
          line: at(node.start).line,
        })
        break

      case 'ExportNamedDeclaration':
        collectRouteConfig(node, facts)
        if (node.exportKind !== 'type') facts.exports.push(...exportedNames(node))
        // `export { Hero } from './Hero'` is an edge in the module graph just as
        // much as an import is. Missing it means barrel files — the exact
        // structure that causes the over-inclusion this tool exists to find —
        // terminate the graph walk one file too early.
        if (node.source?.value && node.exportKind !== 'type') {
          facts.imports.push({
            specifier: String(node.source.value),
            names: (node.specifiers ?? []).map((s: OxcNode) => String(s.local?.name ?? s.exported?.name ?? '')),
            line: at(node.start).line,
          })
        }
        break

      case 'ExportAllDeclaration':
        // Whatever the other module exports, this one now exports too — and this
        // file cannot say what that is.
        facts.exports.push('*')
        if (node.source?.value) {
          facts.imports.push({ specifier: String(node.source.value), names: ['*'], line: at(node.start).line })
        }
        break

      case 'ExportDefaultDeclaration': {
        const decl = node.declaration
        const name = decl?.id?.name ?? decl?.name
        if (typeof name === 'string') facts.defaultExportName = name
        facts.exports.push(typeof name === 'string' ? name : 'default')
        break
      }

      case 'CallExpression': {
        const callee = calleeName(node)
        if (callee && DYNAMIC_APIS.has(callee)) {
          const p = at(node.start)
          facts.dynamicApis.push({ name: callee, line: p.line, column: p.column, inFunction: fnName })
        }
        if (callee === 'fetch') {
          const p = at(node.start)
          facts.fetches.push({
            name: 'fetch',
            line: p.line,
            column: p.column,
            inFunction: fnName,
            caching: fetchCaching(node),
          })
        }
        break
      }

    }

    if (isFunctionLike(node)) {
      const name = functionName(node)
      if (name === 'generateStaticParams') facts.hasGenerateStaticParams = true

      // `searchParams` forces dynamic rendering only as a **page prop**. Matching
      // the bare identifier instead flags every `url.searchParams`, every plain
      // function parameter that happens to share the name, and every client-side
      // `useSearchParams()` result — which on a real 25-route app tainted nearly
      // every route through one shared string utility.
      if (isPageFile(relPath) && !facts.isClientComponent && destructuresSearchParams(node)) {
        const p = at(node.start)
        facts.dynamicApis.push({ name: 'searchParams', line: p.line, column: p.column, inFunction: name ?? fnName })
      }
      if (hasDirective(node.body ?? null, 'use cache')) {
        const p = at(node.start)
        facts.useCacheSites.push({ name: name ?? '<anonymous>', line: p.line, column: p.column, inFunction: fnName })
      }
      // A component is a capitalised function that returns JSX.
      if (name && /^[A-Z]/.test(name)) {
        const jsx = collectJsx(node, at)
        if (jsx.renders.length > 0 || jsx.suspense.length > 0) {
          facts.components.push({
            name,
            line: at(node.start).line,
            isAsync: Boolean(node.async),
            renders: jsx.renders,
            suspense: jsx.suspense,
            hasOpaqueChildren: jsx.opaque,
          })
        }
      }
    }
  })

  if (facts.components.some((c) => c.hasOpaqueChildren)) {
    facts.unresolved.push('renders components passed as children or props; shell prediction is partial here')
  }

  return facts
}

/* ── JSX ───────────────────────────────────────────────────────────────── */

/**
 * `renders` must mean "rendered directly by this component, outside any boundary".
 * A generic walk would also collect the elements *inside* each `<Suspense>` and
 * the elements of its `fallback`, which is precisely backwards: those are the
 * components that fell out of the shell, not the ones that stayed in it.
 *
 * So descent stops at a Suspense element — its contents are recorded against the
 * boundary instead.
 */
function collectJsx(fn: OxcNode, at: (o: number) => Position) {
  const renders: string[] = []
  const suspense: SuspenseFacts[] = []
  let opaque = false

  const descend = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) descend(child)
      return
    }
    const current = node as OxcNode
    if (typeof current.type !== 'string') return

    if (current.type === 'JSXElement') {
      const name = jsxName(current.openingElement)
      if (name === 'Suspense') {
        const p = at(current.start)
        suspense.push({
          line: p.line,
          column: p.column,
          fallback: fallbackElements(current.openingElement),
          children: childElements(current),
        })
        return // Do not descend: everything below is postponed, not shell.
      }
      if (name) renders.push(name)
    }

    // `{children}` and `{Component}` are not lexically resolvable. `{title}` is
    // just a string prop — treating every interpolation as an opaque component
    // makes the unknown list mostly noise, which is how a trustworthy signal gets
    // ignored. Only `children` and capitalised identifiers can be components.
    if (current.type === 'JSXExpressionContainer' && current.expression?.type === 'Identifier') {
      const name = String(current.expression.name ?? '')
      if (name === 'children' || /^[A-Z]/.test(name)) opaque = true
    }

    for (const key of Object.keys(current)) {
      if (SKIP_KEYS.has(key)) continue
      descend(current[key])
    }
  }

  descend(fn)
  return { renders: [...new Set(renders)], suspense, opaque }
}

function fallbackElements(opening: OxcNode | undefined): string[] {
  const attr = (opening?.attributes ?? []).find((a: OxcNode) => a.name?.name === 'fallback')
  if (!attr?.value) return []
  const out: string[] = []
  walk(attr.value, null, (n) => {
    if (n.type === 'JSXElement') {
      const name = jsxName(n.openingElement)
      if (name) out.push(name)
    }
  })
  return out
}

function childElements(element: OxcNode): string[] {
  const out: string[] = []
  for (const child of element.children ?? []) {
    walk(child, null, (n) => {
      if (n.type === 'JSXElement') {
        const name = jsxName(n.openingElement)
        if (name) out.push(name)
      }
    })
  }
  return [...new Set(out)]
}

function jsxName(opening: OxcNode | undefined): string | null {
  const name = opening?.name
  if (!name) return null
  if (name.type === 'JSXIdentifier') return name.name ?? null
  // `<React.Suspense>` — take the property so it matches the bare form.
  if (name.type === 'JSXMemberExpression') return name.property?.name ?? null
  return null
}

/**
 * The names an `export` statement introduces, in any of its spellings:
 * `export function f`, `export const a = 1, b = 2`, `export { a, b }`, and
 * `export { a } from './x'`. Type-only specifiers are skipped — they are erased
 * before any bundler sees them and can carry no runtime behaviour.
 */
function exportedNames(node: OxcNode): string[] {
  const names: string[] = []

  const decl = node.declaration
  if (decl) {
    if (typeof decl.id?.name === 'string') names.push(decl.id.name)
    for (const d of decl.declarations ?? []) {
      if (typeof d.id?.name === 'string') names.push(d.id.name)
    }
  }

  for (const spec of node.specifiers ?? []) {
    if (spec.exportKind === 'type') continue
    const name = spec.exported?.name ?? spec.local?.name
    if (typeof name === 'string') names.push(name)
  }

  return names
}

/* ── declarations ──────────────────────────────────────────────────────── */

function collectRouteConfig(node: OxcNode, facts: SourceFacts): void {
  const decl = node.declaration
  if (!decl) return
  if (decl.type === 'FunctionDeclaration' && decl.id?.name === 'generateStaticParams') {
    facts.hasGenerateStaticParams = true
    return
  }
  if (decl.type !== 'VariableDeclaration') return

  for (const d of decl.declarations ?? []) {
    const key = d.id?.name
    if (!key || !ROUTE_CONFIG_KEYS.has(key)) continue
    const init = d.init
    if (!init) continue
    if (init.type === 'Literal' && (typeof init.value === 'string' || typeof init.value === 'number' || typeof init.value === 'boolean')) {
      facts.routeConfig[key] = init.value
    } else {
      // A computed route config can't be read statically, and guessing at it
      // would produce a confidently wrong rendering mode.
      facts.unresolved.push(`export const ${key} is computed; value unknown`)
    }
  }
}

/**
 * `fetch(url)` is uncached by default under Cache Components — which is exactly the
 * silent failure mode the shell engine exists to catch, so the default is recorded
 * explicitly rather than treated as absence of information.
 */
function fetchCaching(call: OxcNode): FetchRef['caching'] {
  const options = call.arguments?.[1]
  if (!options || options.type !== 'ObjectExpression') return 'default'

  for (const prop of options.properties ?? []) {
    const key = prop.key?.name ?? prop.key?.value
    if (key === 'cache' && prop.value?.type === 'Literal') {
      const value = String(prop.value.value)
      if (value === 'no-store') return 'no-store'
      if (value === 'force-cache') return 'force-cache'
    }
    if (key === 'next' && prop.value?.type === 'ObjectExpression') {
      for (const sub of prop.value.properties ?? []) {
        if ((sub.key?.name ?? sub.key?.value) === 'revalidate') return 'revalidate'
      }
    }
  }
  return 'default'
}

const isPageFile = (file: string): boolean => /(?:^|\/)page\.[jt]sx?$/.test(file)

/** `function Page({ searchParams }: Props)` — the only form that forces dynamic rendering. */
function destructuresSearchParams(fn: OxcNode): boolean {
  for (const param of fn.params ?? []) {
    const pattern = param?.type === 'AssignmentPattern' ? param.left : param
    if (pattern?.type !== 'ObjectPattern') continue
    for (const prop of pattern.properties ?? []) {
      if ((prop.key?.name ?? prop.key?.value) === 'searchParams') return true
    }
  }
  return false
}

function hasDirective(node: OxcNode | null, directive: string): boolean {
  const body = node?.type === 'Program' ? node.body : node?.body
  const statements = Array.isArray(body) ? body : (body as OxcNode | undefined)?.body
  if (!Array.isArray(statements)) return false

  for (const statement of statements) {
    if (statement.type !== 'ExpressionStatement') break
    const expression = statement.expression
    if (expression?.type !== 'Literal' || typeof expression.value !== 'string') break
    if (expression.value === directive) return true
  }
  return false
}

/* ── generic walker ────────────────────────────────────────────────────── */

interface Position {
  line: number
  column: number
}

type OxcNode = {
  type: string
  start: number
  end: number
  [key: string]: unknown
} & Record<string, any>

const SKIP_KEYS = new Set(['start', 'end', 'type', 'range', 'loc', 'parent'])

function walk(node: unknown, fnName: string | null, visit: (node: OxcNode, fnName: string | null) => void): void {
  if (node === null || typeof node !== 'object') return

  if (Array.isArray(node)) {
    for (const child of node) walk(child, fnName, visit)
    return
  }

  const current = node as OxcNode
  if (typeof current.type !== 'string') return

  // `const Chart = () => …` — the name lives on the declarator, not the function,
  // so carry it down before anything asks the function what it is called.
  if (current.type === 'VariableDeclarator' && current.id?.type === 'Identifier' && isFunctionLike(current.init ?? {})) {
    current.init.__inferredName = current.id.name
  }

  visit(current, fnName)

  const nextFnName = isFunctionLike(current) ? (functionName(current) ?? fnName) : fnName
  for (const key of Object.keys(current)) {
    if (SKIP_KEYS.has(key)) continue
    walk(current[key], nextFnName, visit)
  }
}

function isFunctionLike(node: OxcNode): boolean {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  )
}

function functionName(node: OxcNode): string | null {
  if (node.id?.name) return String(node.id.name)
  // `const Foo = () => …` / `export const Foo = function () {}`
  const parentId = node.__inferredName
  return typeof parentId === 'string' ? parentId : null
}

function calleeName(call: OxcNode): string | null {
  const callee = call.callee
  if (!callee) return null
  if (callee.type === 'Identifier') return String(callee.name)
  if (callee.type === 'MemberExpression' && callee.property?.type === 'Identifier') {
    return String(callee.property.name)
  }
  return null
}

function importedName(spec: OxcNode): string {
  if (spec.type === 'ImportDefaultSpecifier') return 'default'
  if (spec.type === 'ImportNamespaceSpecifier') return '*'
  return String(spec.imported?.name ?? spec.local?.name ?? '')
}

function buildLineIndex(code: string): number[] {
  const starts = [0]
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1)
  return starts
}

function positionAt(starts: number[], offset: number): Position {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (starts[mid]! <= offset) low = mid
    else high = mid - 1
  }
  return { line: low + 1, column: offset - starts[low]! }
}
