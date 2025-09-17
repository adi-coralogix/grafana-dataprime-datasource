import React from 'react';
import { InlineField, InlineFieldRow, CodeEditor } from '@grafana/ui';
import { QueryEditorProps } from '@grafana/data';
import { DataSource } from './datasource';
import { CoralogixDataSourceOptions, CoralogixQuery } from './types';

type Props = QueryEditorProps<DataSource, CoralogixQuery, CoralogixDataSourceOptions>;

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

      // Completion provider
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
          const insertRange = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: position.column,
            endColumn: position.column,
          };

          const suggestions: any[] = [];
          const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);

          // Datasets after `source `
          if (/\bsource\s+\S*$/i.test(line)) {
            for (const ds of ['logs', 'spans', 'default/logs', 'default/spans', 'system/engine.queries', 'system/alerts.history']) {
              suggestions.push({ label: ds, kind: monaco.languages.CompletionItemKind.EnumMember, insertText: ds, range });
            }
          }

          // At start or right after a pipe -> commands
          if (!line.trim() || /\|\s*$/i.test(line)) {
            const cmds = ['source logs', 'filter ', 'where ', 'choose ', 'project ', 'rename ', 'groupby ', 'sortby ', 'limit ', 'countby ', 'timechart '];
            for (const c of cmds) {
              suggestions.push({ label: c.trim(), kind: monaco.languages.CompletionItemKind.Keyword, insertText: c, range });
            }
          }

          // Field helpers
          const fieldGroups = ['$m.severity', '$m.timestamp', '$m.timestampMicros', '$l.applicationname', '$l.subsystemname', '$d.message'];
          for (const f of fieldGroups) {
            suggestions.push({ label: f, kind: monaco.languages.CompletionItemKind.Field, insertText: f, range });
          }

          // Next-step scaffolds
          suggestions.push({ label: '| filter …', kind: monaco.languages.CompletionItemKind.Keyword, insertText: ' | filter ', range: insertRange });
          suggestions.push({ label: '| groupby …', kind: monaco.languages.CompletionItemKind.Keyword, insertText: ' | groupby ', range: insertRange });
          suggestions.push({ label: '| choose …', kind: monaco.languages.CompletionItemKind.Keyword, insertText: ' | choose ', range: insertRange });

          // Fallback to ensure we never show "No suggestions"
          if (suggestions.length === 0) {
            for (const c of ['source logs', 'filter ', 'choose ', 'groupby ', 'sortby ', 'limit ']) {
              suggestions.push({ label: c.trim(), kind: monaco.languages.CompletionItemKind.Keyword, insertText: c, range: insertRange });
            }
          }

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
