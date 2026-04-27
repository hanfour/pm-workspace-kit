import MonacoEditor, { type OnMount } from "@monaco-editor/react";
import type * as MonacoNS from "monaco-editor";
import { useCallback, useRef } from "react";
import { lintFrontMatter } from "../lint/frontmatter";

interface EditorProps {
  value: string;
  path: string | null;
  onChange: (next: string) => void;
  onSaveShortcut: () => void | Promise<void>;
}

function languageFor(path: string | null): string {
  if (!path) return "markdown";
  if (path.endsWith(".yml") || path.endsWith(".yaml")) return "yaml";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  return "markdown";
}

export function Editor({ value, path, onChange, onSaveShortcut }: EditorProps) {
  const monacoRef = useRef<typeof MonacoNS | null>(null);
  const editorRef = useRef<MonacoNS.editor.IStandaloneCodeEditor | null>(null);

  const onMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;

      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => {
          void onSaveShortcut();
        },
      );

      const refreshMarkers = () => {
        const model = editor.getModel();
        if (!model) return;
        const diagnostics = lintFrontMatter(model.getValue());
        const markers: MonacoNS.editor.IMarkerData[] = diagnostics.map((d) => ({
          severity: monaco.MarkerSeverity.Warning,
          message: d.message,
          startLineNumber: d.line,
          startColumn: 1,
          endLineNumber: d.line,
          endColumn: model.getLineMaxColumn(d.line),
        }));
        monaco.editor.setModelMarkers(model, "pmk-frontmatter", markers);
      };
      refreshMarkers();
      editor.onDidChangeModelContent(refreshMarkers);
    },
    [onSaveShortcut],
  );

  return (
    <MonacoEditor
      value={value}
      language={languageFor(path)}
      theme="vs-dark"
      onMount={onMount}
      onChange={(v) => onChange(v ?? "")}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        wordWrap: "on",
        lineNumbers: "on",
        renderWhitespace: "selection",
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
      }}
    />
  );
}
