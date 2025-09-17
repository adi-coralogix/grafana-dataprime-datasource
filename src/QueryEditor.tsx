import React from 'react';
import { InlineField, InlineFieldRow, CodeEditor } from '@grafana/ui';
import { QueryEditorProps } from '@grafana/data';
import { DataSource } from './datasource';
import { CoralogixDataSourceOptions, CoralogixQuery } from './types';

type Props = QueryEditorProps<DataSource, CoralogixQuery, CoralogixDataSourceOptions>;

// Full DataPrime functions/commands (excluding 'source')
const FUNCTIONS = [
  'aggregate', 'block', 'bottom', 'choose', 'convert', 'count', 'countby', 'create', 'dedupeby', 'distinct', 'enrich', 'explode', 'extract', 'filter', 'find', 'groupby', 'join', 'limit', 'lucene', 'move', 'multigroupby', 'orderby', 'redact', 'remove', 'replace', 'stitch', 'top', 'union', 'wildfind', 'where', 'project', 'rename', 'sortby', 'lookup'
];
const KEYWORDS_FOR_COLOR = [...FUNCTIONS, 'source'];
const FIELDS = ['$d.message', '$d.body', '$m.severity', '$m.timestamp', '$m.timestampMicros', '$l.applicationname', '$l.subsystemname'];
const OPERATORS = ['==', '!=', 'in', 'not in', '=~', '!~', '>', '>=', '<', '<='];

export function QueryEditor({ query, onChange, onRunQuery }: Props) {
  const onQueryTextChange = (value?: string) => {
    onChange({ ...query, text: value ?? '' });
  };

  const { text } = query;

  const onEditorMount = (editor: any, monaco: any) => {
    try {
      if (!monaco.languages.getLanguages().some((l: any) => l.id === 'dataprime')) {
        monaco.languages.register({ id: 'dataprime' });
      }

      // Tokenizer + theme for colors similar to Coralogix
      monaco.languages.setMonarchTokensProvider('dataprime', {
        keywords: KEYWORDS_FOR_COLOR,
        operators: OPERATORS,
        tokenizer: {
          root: [
            [/\|/, 'operator'],
            [/\$[dml]\.[a-zA-Z_][\w]*/, 'variable'],
            [/[a-zA-Z_][\w]*/, {
              cases: {
                '@keywords': 'function',
                '@default': 'identifier',
              },
            }],
            [/\d+/, 'number'],
            [/\s+/, 'white'],
            [/\=~|!~|==|!=|>=|<=|>|</, 'operator'],
            [/\'([^\\']|\\.)*\'/, 'string'],
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

      // Completion provider with context
      monaco.languages.registerCompletionItemProvider('dataprime', {
        triggerCharacters: [' ', '|', '$', '.', '(', ',', '\'', '"', '='],
        provideCompletionItems: (model: any, position: any) => {
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };

          const suggestions: any[] = [];
          const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
          const trimmed = line.trimEnd();

          const pushFuncs = () => {
            for (const f of FUNCTIONS) {
              suggestions.push({ label: f, kind: monaco.languages.CompletionItemKind.Function, insertText: f + ' ', range, sortText: 'a' });
            }
          };
          const pushFields = () => {
            for (const f of FIELDS) {
              suggestions.push({ label: f, kind: monaco.languages.CompletionItemKind.Field, insertText: f, range, sortText: 'a' });
            }
          };
          const pushOps = () => {
            for (const op of OPERATORS) {
              suggestions.push({ label: op, kind: monaco.languages.CompletionItemKind.Operator, insertText: ' ' + op + ' ', range, sortText: 'b' });
            }
          };

          // 1) After pipe → only functions
          if (/\|\s*$/i.test(trimmed) || trimmed.length === 0) {
            pushFuncs();
            return { suggestions };
          }

          // 2) After function name + space → fields
          const fnMatch = /(?:^|\|\s*)([a-zA-Z_][\w]*)\s+$/.exec(trimmed);
          if (fnMatch && (FUNCTIONS as string[]).includes(fnMatch[1])) {
            pushFields();
            return { suggestions };
          }

          // 3) After a field token → operators
          if (/\$[dml]\.[a-zA-Z_][\w]*\s*$/.test(trimmed)) {
            pushOps();
            return { suggestions };
          }

          // 4) Special: after `source ` suggest ONLY datasets logs/spans
          if (/\bsource\s+\S*$/.test(trimmed)) {
            for (const ds of ['logs', 'spans']) {
              suggestions.push({ label: ds, kind: monaco.languages.CompletionItemKind.EnumMember, insertText: ds, range, sortText: 'a' });
            }
            return { suggestions };
          }

          // Fallback: prefer functions, then fields
          pushFuncs();
          pushFields();
          return { suggestions };
        },
      });

      const model = editor.getModel && editor.getModel();
      if (model && model.getLanguageId && model.getLanguageId() !== 'dataprime') {
        monaco.editor.setModelLanguage(model, 'dataprime');
      }

      editor.updateOptions({
        quickSuggestions: { other: true, comments: true, strings: true },
        quickSuggestionsDelay: 0,
        suggestOnTriggerCharacters: true,
        wordBasedSuggestions: false,
      });
      const triggerSuggest = () => editor.trigger('dp-inline', 'editor.action.triggerSuggest', {});
      editor.onDidChangeModelContent(triggerSuggest);
      setTimeout(triggerSuggest, 0);
    } catch (e) {}
  };

  const editorValue =
    text || "source logs | limit 100";

  return (
    <div className="gf-form-group">
      <InlineFieldRow>
        <InlineField label="Query" grow>
          <CodeEditor
            language={'dataprime'}
            value={editorValue}
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
