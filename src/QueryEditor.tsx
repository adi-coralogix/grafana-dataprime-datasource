import React, { useEffect } from 'react';
import { CodeEditor, InlineField, InlineFieldRow } from '@grafana/ui';
import type { QueryEditorProps } from '@grafana/data';
import type { DataSource } from './datasource';
import type { CoralogixDataSourceOptions, CoralogixQuery } from './types';

type Props = QueryEditorProps<DataSource, CoralogixQuery, CoralogixDataSourceOptions>;
// Derive Monaco types from @grafana/ui's CodeEditor so they always match
type OnEditorMount = NonNullable<React.ComponentProps<typeof CodeEditor>['onEditorDidMount']>;
type MonacoEditor = Parameters<OnEditorMount>[0];
type Monaco = Parameters<OnEditorMount>[1];

// Monaco is a module singleton — providers accumulate across re-renders unless disposed.
let _completionDisposable: { dispose(): void } | undefined;

const FUNCTIONS = [
  'aggregate', 'block', 'bottom', 'choose', 'convert', 'count', 'countby', 'create',
  'dedupeby', 'distinct', 'enrich', 'explode', 'extract', 'filter', 'find', 'groupby',
  'join', 'limit', 'lucene', 'move', 'multigroupby', 'orderby', 'redact', 'remove',
  'replace', 'stitch', 'top', 'union', 'wildfind', 'where', 'project', 'rename',
  'sortby', 'lookup', 'timeseries',
];
const KEYWORDS_FOR_COLOR = [...FUNCTIONS, 'source'];
const OPERATORS = ['==', '!=', 'in', 'not in', '=~', '!~', '>', '>=', '<', '<='];

// Fields per namespace, keyed by source type
const FIELDS: Record<'logs' | 'spans', Record<'l' | 'm' | 'd', string[]>> = {
  logs: {
    l: ['applicationname', 'subsystemname', 'computerName', 'IPAddress', 'threadId', 'className', 'methodName'],
    m: ['severity', 'timestamp', 'timestampMicros', 'logId', 'priorityClass', 'processingTimestamp'],
    d: ['message', 'body', 'msg', 'level', 'levelname', 'trace_id', 'span_id', 'traceId', 'spanId'],
  },
  spans: {
    l: ['applicationName', 'subsystemName', 'serviceName', 'operationName'],
    m: ['traceId', 'spanId', 'parentSpanId', 'name', 'startTimeUnixNano', 'durationNano', 'kind', 'statusCode', 'statusMessage'],
    d: ['traceID', 'spanID', 'operationName', 'duration', 'startTime', 'parentId', 'process.serviceName'],
  },
};

export function QueryEditor({ query, onChange }: Props) {
  // When Grafana navigates to a linked span it sets query.query to the traceID.
  // Synthesize the DataPrime filter so Monaco reflects what's actually running.
  useEffect(() => {
    if (query.query && /^[0-9a-f]{16,64}$/i.test(query.query.trim())) {
      const synthesized = `source spans | filter $d.traceID == '${query.query.trim()}'`;
      if (query.text !== synthesized) {
        onChange({ ...query, text: synthesized });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.query]);

  const onQueryTextChange = (value?: string) => {
    onChange({ ...query, text: value ?? '' });
  };

  const onEditorMount = (editor: MonacoEditor, monaco: Monaco) => {
    try {
      if (!monaco.languages.getLanguages().some((l) => l.id === 'dataprime')) {
        monaco.languages.register({ id: 'dataprime' });
      }

      monaco.languages.setMonarchTokensProvider('dataprime', {
        keywords: KEYWORDS_FOR_COLOR,
        operators: OPERATORS,
        tokenizer: {
          root: [
            [/\|/, 'operator'],
            [/\$[dml]\.[a-zA-Z_]\w*/, 'variable'],
            [
              /[a-zA-Z_]\w*/,
              {
                cases: {
                  '@keywords': 'function',
                  '@default': 'identifier',
                },
              },
            ],
            [/\d+/, 'number'],
            [/\s+/, 'white'],
            [/=~|!~|==|!=|>=|<=|>|</, 'operator'],
            [/'([^\\']|\\.)*'/, 'string'],
          ],
        },
      });

      monaco.editor.defineTheme('dataprime-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'function', foreground: '4FC3F7' },
          { token: 'variable', foreground: 'CE93D8' },
          { token: 'operator', foreground: 'FFB74D' },
          { token: 'string', foreground: 'A5D6A7' },
          { token: 'number', foreground: '90CAF9' },
        ],
        colors: {},
      });
      monaco.editor.setTheme('dataprime-dark');

      // Dispose any previously registered provider so re-renders don't stack duplicates
      _completionDisposable?.dispose();
      _completionDisposable = monaco.languages.registerCompletionItemProvider('dataprime', {
        triggerCharacters: [' ', '|', '$', '.', '(', ',', "'", '"', '='],
        provideCompletionItems: (model, position) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const suggestions: any[] = [];
          const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
          const trimmed = line.trimEnd();
          const fullText = model.getValue();
          const source = /\bsource\s+spans\b/i.test(fullText) ? 'spans' : 'logs';

          // Default range covers the current word
          const word = model.getWordUntilPosition(position);
          const wordRange = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };

          // ── Field reference: user typed $l.app, $m.trac, $d.mes, etc. ──
          // Match captures: [0]=full "$l.foo", [1]=namespace, [2]=partial name after dot
          const fieldRef = /\$([dml])\.(\w*)$/.exec(line);
          if (fieldRef) {
            const ns = fieldRef[1] as 'l' | 'm' | 'd';
            const partial = fieldRef[2].toLowerCase();
            // Replace from the '$' character so the whole "$l.foo" is replaced
            const refRange = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: position.column - fieldRef[0].length,
              endColumn: position.column,
            };
            const candidates = FIELDS[source][ns] ?? [];
            for (const name of candidates) {
              if (!partial || name.toLowerCase().startsWith(partial)) {
                suggestions.push({
                  label: `$${ns}.${name}`,
                  kind: monaco.languages.CompletionItemKind.Field,
                  insertText: `$${ns}.${name}`,
                  range: refRange,
                  sortText: 'a',
                });
              }
            }
            // Also offer operators if field is complete
            if (candidates.some((n) => n.toLowerCase() === partial)) {
              for (const op of OPERATORS) {
                suggestions.push({
                  label: op,
                  kind: monaco.languages.CompletionItemKind.Operator,
                  insertText: ' ' + op + ' ',
                  range: wordRange,
                  sortText: 'b',
                });
              }
            }
            return { suggestions };
          }

          // ── Just typed '$': offer $d. $l. $m. namespaces ──
          if (line.endsWith('$')) {
            const dollarRange = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: position.column - 1,
              endColumn: position.column,
            };
            for (const ns of ['d', 'l', 'm']) {
              suggestions.push({
                label: `$${ns}.`,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: `$${ns}.`,
                range: dollarRange,
                command: { id: 'editor.action.triggerSuggest', title: '' },
                sortText: 'a',
              });
            }
            return { suggestions };
          }

          // ── After a field reference, offer operators ──
          if (/\$[dml]\.[a-zA-Z_]\w*\s*$/.test(trimmed)) {
            for (const op of OPERATORS) {
              suggestions.push({
                label: op,
                kind: monaco.languages.CompletionItemKind.Operator,
                insertText: ' ' + op + ' ',
                range: wordRange,
                sortText: 'b',
              });
            }
            return { suggestions };
          }

          // ── After 'source', offer data sources (only when not yet followed by a pipe) ──
          if (/(?:^|\|)\s*source\s+\w*$/.test(trimmed)) {
            for (const ds of ['logs', 'spans']) {
              suggestions.push({
                label: ds,
                kind: monaco.languages.CompletionItemKind.EnumMember,
                insertText: ds,
                range: wordRange,
                sortText: 'a',
              });
            }
            return { suggestions };
          }

          // ── After '|' or at start: offer functions ──
          const pushFuncs = () => {
            for (const f of FUNCTIONS) {
              suggestions.push({
                label: f,
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: f + ' ',
                range: wordRange,
                sortText: 'a',
              });
            }
          };
          const pushAllFields = () => {
            for (const ns of ['l', 'm', 'd'] as const) {
              for (const name of FIELDS[source][ns]) {
                suggestions.push({
                  label: `$${ns}.${name}`,
                  kind: monaco.languages.CompletionItemKind.Field,
                  insertText: `$${ns}.${name}`,
                  range: wordRange,
                  sortText: 'a',
                });
              }
            }
          };

          if (/\|\s*$/.test(trimmed) || trimmed.length === 0) {
            pushFuncs();
            return { suggestions };
          }

          const fnMatch = /(?:^|\|\s*)([a-zA-Z_]\w*)\s+$/.exec(trimmed);
          if (fnMatch && (FUNCTIONS as string[]).includes(fnMatch[1])) {
            pushAllFields();
            return { suggestions };
          }

          pushFuncs();
          pushAllFields();
          return { suggestions };
        },
      });

      const model = editor.getModel?.();
      if (model?.getLanguageId?.() !== 'dataprime') {
        monaco.editor.setModelLanguage(model!, 'dataprime');
      }

      editor.updateOptions({
        quickSuggestions: { other: true, comments: true, strings: true },
        quickSuggestionsDelay: 0,
        suggestOnTriggerCharacters: true,
        wordBasedSuggestions: false,
      });

      editor.onDidChangeModelContent(() => {
        editor.trigger('dp-inline', 'editor.action.triggerSuggest', {});
      });
      setTimeout(() => editor.trigger('dp-inline', 'editor.action.triggerSuggest', {}), 0);
    } catch (e) {
      console.error('[DataPrime] Monaco initialisation failed:', e);
    }
  };

  return (
    <div className="gf-form-group">
      <InlineFieldRow>
        <InlineField label="Query" grow>
          <CodeEditor
            language="dataprime"
            value={query.text || 'source logs | limit 100'}
            onChange={onQueryTextChange}
            height={180}
            showMiniMap={false}
            onEditorDidMount={onEditorMount}
            monacoOptions={{
              wordWrap: 'on',
              quickSuggestions: { other: true, comments: true, strings: true },
              quickSuggestionsDelay: 0,
              suggestOnTriggerCharacters: true,
            }}
          />
        </InlineField>
      </InlineFieldRow>
    </div>
  );
}
