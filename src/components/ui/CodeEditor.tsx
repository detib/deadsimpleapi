import { useEffect, useRef } from 'react'

import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { xml } from '@codemirror/lang-xml'
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
  rectangularSelection,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

export type EditorLanguage = 'json' | 'xml' | 'html' | 'javascript' | 'graphql' | 'text'

export interface CodeEditorProps {
  value: string
  onChange?: (value: string) => void
  language?: EditorLanguage
  readOnly?: boolean
  wrap?: boolean
  fontSize?: number
  placeholder?: string
  /** Highlights {{variables}} as chips, matching the single-line inputs. */
  highlightVariables?: boolean
  showLineNumbers?: boolean
  className?: string
  ariaLabel?: string
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

/**
 * Colours reference the design tokens rather than literals, so the editor
 * follows the light/dark switch without rebuilding any extension.
 */
const baseTheme = EditorView.theme({
  '&': {
    color: 'var(--bone)',
    backgroundColor: 'transparent',
    height: '100%',
  },
  '.cm-content': {
    fontFamily: 'var(--font-data)',
    padding: '8px 0',
    caretColor: 'var(--signal)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-data)',
    lineHeight: '1.55',
    overflow: 'auto',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--faint)',
    border: 'none',
    borderRight: '1px solid var(--edge-soft)',
    paddingRight: '2px',
    userSelect: 'none',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--mute)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--rail) 45%, transparent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--signal) 26%, transparent)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--signal)', borderLeftWidth: '2px' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--signal) 22%, transparent)',
    outline: 'none',
    color: 'inherit',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'color-mix(in srgb, var(--trace) 18%, transparent)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--rail)',
    border: '1px solid var(--edge)',
    color: 'var(--mute)',
    borderRadius: '3px',
    padding: '0 4px',
    margin: '0 2px',
  },
  '.cm-panels': {
    backgroundColor: 'var(--chassis-2)',
    color: 'var(--bone)',
    borderTop: '1px solid var(--edge)',
  },
  '.cm-panel input, .cm-panel button': {
    fontFamily: 'var(--font-ui)',
    fontSize: '12px',
    background: 'var(--rail)',
    color: 'var(--bone)',
    border: '1px solid var(--edge)',
    borderRadius: '3px',
    padding: '2px 6px',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--rail)',
    border: '1px solid var(--edge)',
    borderRadius: '4px',
    color: 'var(--bone)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'color-mix(in srgb, var(--signal) 24%, transparent)',
    color: 'var(--bone)',
  },
  '.cm-placeholder': { color: 'var(--faint)' },
})

const highlightStyle = HighlightStyle.define([
  { tag: t.propertyName, color: 'var(--trace)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--jade)' },
  { tag: [t.number, t.integer, t.float], color: 'var(--violet)' },
  { tag: [t.bool, t.null, t.atom], color: 'var(--amber-2)' },
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--signal)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--faint)', fontStyle: 'italic' },
  { tag: [t.tagName], color: 'var(--trace)' },
  { tag: [t.attributeName], color: 'var(--violet)' },
  { tag: [t.attributeValue], color: 'var(--jade)' },
  { tag: [t.punctuation, t.separator, t.bracket], color: 'var(--mute)' },
  { tag: [t.function(t.variableName), t.definition(t.variableName)], color: 'var(--signal)' },
  { tag: [t.variableName], color: 'var(--bone)' },
  { tag: t.invalid, color: 'var(--rust)' },
])

/* ------------------------------------------------------------------ */
/* Variable chips                                                      */
/* ------------------------------------------------------------------ */

const varMatcher = new MatchDecorator({
  regexp: /\{\{\s*[^{}\s][^{}]*\}\}/g,
  decoration: Decoration.mark({ class: 'cm-var' }),
})

const variablePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = varMatcher.createDeco(view)
    }
    update(update: ViewUpdate) {
      this.decorations = varMatcher.updateDeco(update, this.decorations)
    }
  },
  { decorations: (v) => v.decorations },
)

/* ------------------------------------------------------------------ */

function languageExtension(language: EditorLanguage): Extension {
  switch (language) {
    case 'json':
      return json()
    case 'xml':
      return xml()
    case 'html':
      return html()
    case 'javascript':
      return javascript()
    // GraphQL has no dedicated grammar here; JS braces and strings are a
    // closer fit than plain text and give bracket matching for free.
    case 'graphql':
      return javascript()
    default:
      return []
  }
}

export function CodeEditor({
  value,
  onChange,
  language = 'text',
  readOnly = false,
  wrap = true,
  fontSize = 12.5,
  placeholder,
  highlightVariables = false,
  showLineNumbers = true,
  className,
  ariaLabel,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const langComp = useRef(new Compartment())
  const wrapComp = useRef(new Compartment())
  const roComp = useRef(new Compartment())
  const sizeComp = useRef(new Compartment())
  const lineComp = useRef(new Compartment())

  useEffect(() => {
    if (!host.current) return

    const extensions: Extension[] = [
      lineComp.current.of(showLineNumbers ? [lineNumbers(), highlightActiveLineGutter(), foldGutter()] : []),
      history(),
      drawSelection(),
      rectangularSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      syntaxHighlighting(highlightStyle),
      baseTheme,
      langComp.current.of(languageExtension(language)),
      wrapComp.current.of(wrap ? EditorView.lineWrapping : []),
      roComp.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      sizeComp.current.of(EditorView.theme({ '.cm-scroller': { fontSize: `${fontSize}px` } })),
      highlightVariables ? variablePlugin : [],
      placeholder ? placeholderExt(placeholder) : [],
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current?.(update.state.doc.toString())
      }),
      EditorView.contentAttributes.of(ariaLabel ? { 'aria-label': ariaLabel } : {}),
    ]

    const instance = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host.current,
    })
    view.current = instance

    return () => {
      instance.destroy()
      view.current = null
    }
    // Built once; every prop below is pushed in through a compartment instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* Controlled value: only replace the document when it actually diverged,
     otherwise every keystroke would reset the cursor. */
  useEffect(() => {
    const instance = view.current
    if (!instance) return
    const current = instance.state.doc.toString()
    if (current === value) return
    instance.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor: Math.min(instance.state.selection.main.anchor, value.length) },
    })
  }, [value])

  useEffect(() => {
    view.current?.dispatch({
      effects: langComp.current.reconfigure(languageExtension(language)),
    })
  }, [language])

  useEffect(() => {
    view.current?.dispatch({
      effects: wrapComp.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    })
  }, [wrap])

  useEffect(() => {
    view.current?.dispatch({
      effects: roComp.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    })
  }, [readOnly])

  useEffect(() => {
    view.current?.dispatch({
      effects: sizeComp.current.reconfigure(
        EditorView.theme({ '.cm-scroller': { fontSize: `${fontSize}px` } }),
      ),
    })
  }, [fontSize])

  useEffect(() => {
    view.current?.dispatch({
      effects: lineComp.current.reconfigure(
        showLineNumbers ? [lineNumbers(), highlightActiveLineGutter(), foldGutter()] : [],
      ),
    })
  }, [showLineNumbers])

  return <div className={`codeeditor${className ? ` ${className}` : ''}`} ref={host} />
}
