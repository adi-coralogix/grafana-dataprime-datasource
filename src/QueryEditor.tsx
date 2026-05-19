import React from 'react';
import { CodeEditor, InlineField, InlineFieldRow } from '@grafana/ui';
import type { QueryEditorProps } from '@grafana/data';
import { DataSource } from './datasource';
import type { CoralogixDataSourceOptions, CoralogixQuery } from './types';

type Props = QueryEditorProps<DataSource, CoralogixQuery, CoralogixDataSourceOptions>;
// Derive Monaco types from @grafana/ui's CodeEditor so they always match
type OnEditorMount = NonNullable<React.ComponentProps<typeof CodeEditor>['onEditorDidMount']>;
type MonacoEditor = Parameters<OnEditorMount>[0];
type Monaco = Parameters<OnEditorMount>[1];

const FUNCTIONS = [
  'aggregate', 'block', 'bottom', 'choose', 'convert', 'count', 'countby', 'create',
  'dedupeby', 'distinct', 'enrich', 'explode', 'extract', 'filter', 'find', 'groupby',
  'join', 'limit', 'lucene', 'move', 'multigroupby', 'orderby', 'redact', 'remove',
  'replace', 'stitch', 'top', 'union', 'wildfind', 'where', 'project', 'rename',
  'sortby', 'lookup',
];
const KEYWORDS_FOR_COLOR = [...FUNCTIONS, 'source'];
const FIELDS = [
  '$d.message', '$d.body',
  '$m.severity', '$m.timestamp', '$m.timestampMicros',
  '$l.applicationname', '$l.subsystemname',
];
const OPERATORS = ['==', '!=', 'in', 'not in', '=~', '!~', '>', '>=', '<', '<='];

export function QueryEditor({ query, onChange, onRunQuery: _onRunQuery }: Props) {
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

      monaco.languages.registerCompletionItemProvider('dataprime', {
        triggerCharacters: [' ', '|', '$', '.', '(', ',', "'", '"', '='],
        provideCompletionItems: (model, position) => {
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const suggestions: any[] = [];
          const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
          const trimmed = line.trimEnd();

          const pushFuncs = () => {
            for (const f of FUNCTIONS) {
              suggestions.push({
                label: f,
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: f + ' ',
                range,
                sortText: 'a',
              });
            }
          };
          const pushFields = () => {
            for (const f of FIELDS) {
              suggestions.push({
                label: f,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: f,
                range,
                sortText: 'a',
              });
            }
          };
          const pushOps = () => {
            for (const op of OPERATORS) {
              suggestions.push({
                label: op,
                kind: monaco.languages.CompletionItemKind.Operator,
                insertText: ' ' + op + ' ',
                range,
                sortText: 'b',
              });
            }
          };

          if (/\|\s*$/i.test(trimmed) || trimmed.length === 0) {
            pushFuncs();
            return { suggestions };
          }

          const fnMatch = /(?:^|\|\s*)([a-zA-Z_]\w*)\s+$/.exec(trimmed);
          if (fnMatch && (FUNCTIONS as string[]).includes(fnMatch[1])) {
            pushFields();
            return { suggestions };
          }

          if (/\$[dml]\.[a-zA-Z_]\w*\s*$/.test(trimmed)) {
            pushOps();
            return { suggestions };
          }

          if (/\bsource\s+\S*$/.test(trimmed)) {
            for (const ds of ['logs', 'spans']) {
              suggestions.push({
                label: ds,
                kind: monaco.languages.CompletionItemKind.EnumMember,
                insertText: ds,
                range,
                sortText: 'a',
              });
            }
            return { suggestions };
          }

          pushFuncs();
          pushFields();
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
