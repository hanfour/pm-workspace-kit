import { useCallback, useEffect, useState } from "react";

interface FirstRunProps {
  onResolved: (providerName: string) => void;
}

/**
 * Shown when no LLM provider is available. Lets the user paste an
 * Anthropic API key which is stored encrypted via Electron safeStorage.
 * A "check again" button re-probes in case the user just logged into
 * Claude Code in another window.
 */
export function FirstRun({ onResolved }: FirstRunProps) {
  const [hint, setHint] = useState("checking auth…");
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<"probing" | "need-auth" | "saving" | "ok">(
    "probing",
  );
  const [error, setError] = useState<string | null>(null);

  const probe = useCallback(async () => {
    setStatus("probing");
    setError(null);
    const s = await window.pmk!.llm.status();
    if (s.providerName === "none") {
      setHint(s.hint ?? "No provider available.");
      setStatus("need-auth");
    } else {
      onResolved(s.providerName);
      setStatus("ok");
    }
  }, [onResolved]);

  useEffect(() => {
    void probe();
  }, [probe]);

  const submit = async () => {
    setStatus("saving");
    setError(null);
    try {
      await window.pmk!.llm.saveApiKey(key);
      setKey("");
      await probe();
    } catch (e) {
      setError((e as Error).message);
      setStatus("need-auth");
    }
  };

  if (status === "ok") return null;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-neutral-950/80 backdrop-blur">
      <div className="w-[28rem] rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-xl">
        <h2 className="text-lg font-semibold">Connect an LLM provider</h2>
        <p className="mt-2 text-sm text-neutral-400">
          {status === "probing" ? "Detecting auth…" : hint}
        </p>

        <div className="mt-6 space-y-3">
          <div>
            <label className="block text-xs uppercase tracking-wide text-neutral-500">
              Option A · Claude Code login
            </label>
            <p className="mt-1 text-xs text-neutral-400">
              Run <code className="rounded bg-neutral-800 px-1">claude login</code>{" "}
              in a terminal, then click <strong>Check again</strong>.
            </p>
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wide text-neutral-500">
              Option B · Paste an Anthropic API key
            </label>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-ant-..."
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm font-mono focus:border-neutral-500 focus:outline-none"
              disabled={status === "saving"}
            />
            <p className="mt-1 text-[10px] text-neutral-500">
              Stored encrypted via OS keychain (Electron safeStorage). Never written in plain text.
            </p>
          </div>
          {error && (
            <div className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={probe}
              disabled={status === "probing" || status === "saving"}
              className="rounded border border-neutral-700 px-3 py-1 text-sm hover:bg-neutral-800 disabled:opacity-40"
            >
              Check again
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!key || status === "saving"}
              className="rounded bg-neutral-100 px-3 py-1 text-sm text-neutral-900 hover:bg-white disabled:opacity-40"
            >
              {status === "saving" ? "Saving…" : "Save key"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
