/**
 * A stand-in for workerd's `HTMLRewriter`, which Node does not have (`tests/api-setup.ts` installs
 * it on `globalThis` when it is missing). It covers what `src/` uses and no more: element handlers
 * on a bare tag-name selector, called for the FIRST such open tag only, whose `prepend` /
 * `append` insert right after it / right before its close tag, and a document `end` handler whose
 * `append` adds at the end. It buffers the body — the real one streams — so a test proves which
 * pages are rewritten and where the tag lands, not lol-html's parsing.
 */

type Insert = { at: number; html: string }

interface FakeElement {
  prepend(content: string, options?: { html?: boolean }): FakeElement
  append(content: string, options?: { html?: boolean }): FakeElement
}

interface ElementHandlers {
  element?(el: FakeElement): void
}

interface DocumentHandlers {
  end?(end: { append(content: string, options?: { html?: boolean }): void }): void
}

function escapeText(content: string): string {
  return content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export class FakeHTMLRewriter {
  private readonly elements: Array<{ tag: string; handlers: ElementHandlers }> = []
  private readonly documents: DocumentHandlers[] = []

  on(selector: string, handlers: ElementHandlers): this {
    if (!/^[a-z][a-z0-9-]*$/i.test(selector)) {
      throw new Error(`FakeHTMLRewriter: only a tag-name selector is supported, not ${selector}`)
    }
    this.elements.push({ tag: selector.toLowerCase(), handlers })
    return this
  }

  onDocument(handlers: DocumentHandlers): this {
    this.documents.push(handlers)
    return this
  }

  transform(res: Response): Response {
    const elements = this.elements
    const documents = this.documents
    const body = (async () => {
      const html = await res.text()
      const inserts: Insert[] = []
      const matches = elements
        .map(({ tag, handlers }) => {
          const open = new RegExp(`<${tag}(\\s[^>]*)?>`, 'i').exec(html)
          if (!open) return null
          const close = new RegExp(`</${tag}\\s*>`, 'i').exec(html.slice(open.index))
          return {
            handlers,
            start: open.index,
            afterOpen: open.index + open[0].length,
            beforeClose: close ? open.index + close.index : html.length,
          }
        })
        .filter(m => m !== null)
        .sort((a, b) => a.start - b.start)
      for (const m of matches) {
        const el: FakeElement = {
          prepend: (content, options) => {
            inserts.push({ at: m.afterOpen, html: options?.html ? content : escapeText(content) })
            return el
          },
          append: (content, options) => {
            inserts.push({ at: m.beforeClose, html: options?.html ? content : escapeText(content) })
            return el
          },
        }
        m.handlers.element?.(el)
      }
      for (const handlers of documents) {
        handlers.end?.({
          append: (content, options) => {
            inserts.push({ at: html.length, html: options?.html ? content : escapeText(content) })
          },
        })
      }
      let out = html
      for (const insert of inserts.sort((a, b) => b.at - a.at)) {
        out = `${out.slice(0, insert.at)}${insert.html}${out.slice(insert.at)}`
      }
      return out
    })()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(await body))
        controller.close()
      },
    })
    const headers = new Headers(res.headers)
    headers.delete('Content-Length')
    return new Response(stream, { status: res.status, statusText: res.statusText, headers })
  }
}

/** Install the fake as the global `HTMLRewriter` unless a real one is there. */
export function installFakeHTMLRewriter(): void {
  const g = globalThis as { HTMLRewriter?: unknown }
  if (typeof g.HTMLRewriter === 'undefined') g.HTMLRewriter = FakeHTMLRewriter
}
