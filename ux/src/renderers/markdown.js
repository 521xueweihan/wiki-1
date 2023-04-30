import MarkdownIt from 'markdown-it'
import mdAttrs from 'markdown-it-attrs'
import mdDecorate from 'markdown-it-decorate'
import mdEmoji from 'markdown-it-emoji'
import mdTaskLists from 'markdown-it-task-lists'
import mdExpandTabs from 'markdown-it-expand-tabs'
import mdAbbr from 'markdown-it-abbr'
import mdSup from 'markdown-it-sup'
import mdSub from 'markdown-it-sub'
import mdMark from 'markdown-it-mark'
import mdMultiTable from 'markdown-it-multimd-table'
import mdFootnote from 'markdown-it-footnote'
// import mdImsize from 'markdown-it-imsize'
import katex from 'katex'
import underline from './modules/markdown-it-underline'
import 'katex/dist/contrib/mhchem'
import twemoji from 'twemoji'
import plantuml from './modules/plantuml'
import katexHelper from './modules/katex'

import hljs from 'highlight.js'

import { escape, findLast, times } from 'lodash-es'

export class MarkdownRenderer {
  constructor (conf = {}) {
    this.md = new MarkdownIt({
      html: true,
      breaks: true,
      linkify: true,
      typography: true,
      highlight (str, lang) {
        if (lang === 'diagram') {
          return `<pre class="diagram">${Buffer.from(str, 'base64').toString()}</pre>`
        } else if (['mermaid', 'plantuml'].includes(lang)) {
          return `<pre class="codeblock-${lang}"><code>${escape(str)}</code></pre>`
        } else {
          const highlighted = lang ? hljs.highlight(str, { language: lang, ignoreIllegals: true }) : hljs.highlightAuto(str)
          const lineCount = highlighted.value.match(/\n/g).length
          const lineNums = lineCount > 1 ? `<span aria-hidden="true" class="line-numbers-rows">${times(lineCount, n => '<span></span>').join('')}</span>` : ''
          return `<pre class="codeblock ${lineCount > 1 && 'line-numbers'}"><code class="language-${lang}">${highlighted.value}${lineNums}</code></pre>`
        }
      }
    })
      .use(mdAttrs, {
        allowedAttributes: ['id', 'class', 'target']
      })
      .use(mdDecorate)
      .use(underline)
      .use(mdEmoji)
      .use(mdTaskLists, { label: false, labelAfter: false })
      .use(mdExpandTabs)
      .use(mdAbbr)
      .use(mdSup)
      .use(mdSub)
      .use(mdMultiTable, { multiline: true, rowspan: true, headerless: true })
      .use(mdMark)
      .use(mdFootnote)
      // .use(mdImsize)

    // -> PLANTUML
    plantuml.init(this.md, {})

    // -> KATEX
    const macros = {}
    this.md.inline.ruler.after('escape', 'katex_inline', katexHelper.katexInline)
    this.md.renderer.rules.katex_inline = (tokens, idx) => {
      try {
        return katex.renderToString(tokens[idx].content, {
          displayMode: false, macros
        })
      } catch (err) {
        console.warn(err)
        return tokens[idx].content
      }
    }
    this.md.block.ruler.after('blockquote', 'katex_block', katexHelper.katexBlock, {
      alt: ['paragraph', 'reference', 'blockquote', 'list']
    })
    this.md.renderer.rules.katex_block = (tokens, idx) => {
      try {
        return '<p>' + katex.renderToString(tokens[idx].content, {
          displayMode: true, macros
        }) + '</p>'
      } catch (err) {
        console.warn(err)
        return tokens[idx].content
      }
    }

    // -> TWEMOJI
    this.md.renderer.rules.emoji = (token, idx) => {
      return twemoji.parse(token[idx].content, {
        callback (icon, opts) {
          return `/_assets/svg/twemoji/${icon}.svg`
        }
      })
    }

    // Inject line numbers for preview scroll sync
    this.linesMap = []
    const injectLineNumbers = (tokens, idx, options, env, slf) => {
      let line
      if (tokens[idx].map && tokens[idx].level === 0) {
        line = tokens[idx].map[0] + 1
        tokens[idx].attrJoin('class', 'line')
        tokens[idx].attrSet('data-line', String(line))
        this.linesMap.push(line)
      }
      return slf.renderToken(tokens, idx, options, env, slf)
    }
    this.md.renderer.rules.paragraph_open = injectLineNumbers
    this.md.renderer.rules.heading_open = injectLineNumbers
    this.md.renderer.rules.blockquote_open = injectLineNumbers
  }

  render (src) {
    this.linesMap = []
    return this.md.render(src)
  }

  getClosestPreviewLine (line) {
    return findLast(this.linesMap, n => n <= line)
  }
}
