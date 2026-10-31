import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';

// The VS Code editor, loaded only when an administrator opens raw data.
self.MonacoEnvironment = {
  getWorker() { return new Worker('/vendor/monaco/editor.worker.js?v=20261031-2', { type: 'module' }); },
};
monaco.languages.register({ id: 'onepay-json' });
monaco.languages.setMonarchTokensProvider('onepay-json', {
  tokenizer: { root: [
    [/[{}\[\]]/, '@brackets'],
    [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'key'],
    [/"(?:[^"\\]|\\.)*"/, 'string'],
    [/\b(?:true|false|null)\b/, 'keyword'],
    [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
  ] },
});
monaco.editor.defineTheme('onepay-vscode', {
  base: 'vs-dark', inherit: true,
  rules: [{ token: 'key', foreground: '9CDCFE' }, { token: 'string', foreground: 'CE9178' }, { token: 'number', foreground: 'B5CEA8' }, { token: 'keyword', foreground: '569CD6' }],
  colors: { 'editor.background': '#1e1e1e' },
});
export function createRawEditor(container, value) {
  return monaco.editor.create(container, {
    value, language: 'onepay-json', theme: 'onepay-vscode', readOnly: true,
    automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
    fontSize: 13, lineHeight: 21, wordWrap: 'on', padding: { top: 12 },
    renderLineHighlight: 'none', folding: true, ariaLabel: '只读原始 JSON 数据',
  });
}
