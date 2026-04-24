import { useCallback, useMemo, useRef, useState } from "react";

type Mode = "discuss" | "debug" | "tdd";

interface ChatPanelProps {
  /** Path of the file currently open in the editor, if any. */
  attachablePath: string | null;
  /** Content of the file currently open in the editor, if any. */
  attachableContent: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
}

const PROMPTS: Record<Mode, string> = {
  discuss: `You are a senior PM / staff engineer helping the user think through a topic. Be structured, direct, and honest.

Rules:
- Lead every response with a one-line thesis.
- Break down complex answers into 3–5 bullet clusters.
- Call out uncertainty explicitly ("This assumes X; if not, then Y").
- Challenge the user's assumptions when warranted.
- No emojis.`,
  debug: `You are helping the user systematically debug an issue. Follow this framework:
1. Restate the symptom in the user's words.
2. Ask for the minimum reproduction — what exactly triggers it.
3. Enumerate hypotheses (3–5) ranked by likelihood.
4. For each hypothesis, name the single test that would confirm or reject it.
5. Have the user run the cheapest test first; iterate.

Do not propose fixes before the root cause is narrowed to one or two hypotheses.`,
  tdd: `You are guiding the user through strict Test-Driven Development. Enforce the Red → Green → Refactor loop.

Rules:
- Phase 1 (Red): propose ONE failing test first. Show the exact test code. Ask the user to run it and confirm it fails with the expected error.
- Phase 2 (Green): propose the minimum implementation that makes the test pass — no extras, no refactors. Wait for the user to confirm the test passes.
- Phase 3 (Refactor): only after green, propose refactors. One at a time. Tests must stay green.
- Never jump ahead. Never add a second test until the first is green.
- No emojis.`,
};

const MODE_LABELS: Record<Mode, string> = {
  discuss: "Discuss",
  debug: "Debug",
  tdd: "TDD",
};

export function ChatPanel({ attachablePath, attachableContent }: ChatPanelProps) {
  const [mode, setMode] = useState<Mode>("discuss");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [attachFile, setAttachFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    });
  };

  const send = useCallback(async () => {
    if (!draft.trim() || busy) return;
    if (!window.pmk) {
      setError("preload bridge missing");
      return;
    }
    setError(null);

    const userText =
      attachFile && attachablePath
        ? `Open file: \`${attachablePath}\`\n\n\`\`\`\n${attachableContent}\n\`\`\`\n\n${draft}`
        : draft;

    const nextHistory: Message[] = [
      ...messages,
      { role: "user", content: userText },
    ];
    setMessages([...nextHistory, { role: "assistant", content: "" }]);
    setDraft("");
    setAttachFile(false);
    setBusy(true);
    scrollToBottom();

    try {
      const full = await window.pmk.llm.chat(
        PROMPTS[mode],
        nextHistory,
        (chunk: string) => {
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
              next[next.length - 1] = {
                role: "assistant",
                content: last.content + chunk,
              };
            }
            return next;
          });
          scrollToBottom();
        },
      );
      setMessages((prev) => {
        const next = prev.slice();
        next[next.length - 1] = { role: "assistant", content: full };
        return next;
      });
    } catch (e) {
      setError((e as Error).message);
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setBusy(false);
    }
  }, [attachFile, attachableContent, attachablePath, busy, draft, messages, mode]);

  const reset = () => {
    if (busy) return;
    setMessages([]);
    setError(null);
  };

  const modeDescription = useMemo(() => {
    switch (mode) {
      case "discuss":
        return "Open-ended brainstorm. Same system prompt as `pmk discuss`.";
      case "debug":
        return "Symptom → hypotheses → one test. Same as `pmk debug`.";
      case "tdd":
        return "Red → Green → Refactor. Same as `pmk tdd`.";
    }
  }, [mode]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-neutral-800 px-3 py-2 text-xs">
        <span className="mr-auto text-[10px] uppercase tracking-widest text-neutral-600">
          Mode
        </span>
        {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={
              "rounded px-2 py-0.5 " +
              (mode === m
                ? "bg-neutral-800 text-white"
                : "text-neutral-500 hover:text-neutral-300")
            }
          >
            {MODE_LABELS[m]}
          </button>
        ))}
        <button
          type="button"
          onClick={reset}
          disabled={busy || messages.length === 0}
          className="ml-2 rounded border border-neutral-800 px-2 py-0.5 text-neutral-400 hover:bg-neutral-800 disabled:opacity-40"
          title="Clear conversation"
        >
          ↺
        </button>
      </div>

      <div className="border-b border-neutral-900 px-3 py-1 text-[10px] text-neutral-500">
        {modeDescription}
      </div>

      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-auto px-3 py-3 text-sm"
      >
        {messages.length === 0 && (
          <div className="pt-6 text-center text-xs text-neutral-600">
            Type a message below to start.
            <br />
            Uses your Claude Code OAuth — no extra setup.
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={
              "mb-4 rounded-md border px-3 py-2 " +
              (m.role === "user"
                ? "border-neutral-800 bg-neutral-900/60"
                : "border-neutral-800/60 bg-neutral-950")
            }
          >
            <div className="mb-1 text-[10px] uppercase tracking-widest text-neutral-600">
              {m.role === "user" ? "You" : "Assistant"}
            </div>
            <div className="whitespace-pre-wrap text-neutral-200">
              {m.content || (busy && i === messages.length - 1 ? "…" : "")}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="border-t border-red-900 bg-red-950/30 px-3 py-1 text-[11px] text-red-300">
          {error}
        </div>
      )}

      <div className="border-t border-neutral-800 bg-neutral-950 px-3 py-2">
        {attachablePath && (
          <label className="mb-1 flex items-center gap-2 text-[10px] text-neutral-500">
            <input
              type="checkbox"
              checked={attachFile}
              onChange={(e) => setAttachFile(e.target.checked)}
              disabled={busy}
              className="accent-neutral-400"
            />
            <span>
              Attach open file:{" "}
              <span className="text-neutral-400">{shortPath(attachablePath)}</span>
            </span>
          </label>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={
              busy
                ? "assistant is responding…"
                : "Type a message · ⌘+Enter to send"
            }
            rows={2}
            disabled={busy}
            className="min-h-[2.5rem] flex-1 resize-y rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            onClick={send}
            disabled={busy || !draft.trim()}
            className="rounded bg-neutral-100 px-3 py-1 text-sm text-neutral-900 hover:bg-white disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.slice(-3).join("/");
}
