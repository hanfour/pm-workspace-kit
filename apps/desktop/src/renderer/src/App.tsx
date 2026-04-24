import { useEffect, useState } from "react";

declare global {
  interface Window {
    pmk?: {
      ping: () => string;
      version: () => string;
    };
  }
}

export function App() {
  const [bridge, setBridge] = useState<string>("probing…");
  const [electronVer, setElectronVer] = useState<string>("");

  useEffect(() => {
    if (!window.pmk) {
      setBridge("bridge missing — check preload");
      return;
    }
    setBridge(window.pmk.ping());
    setElectronVer(window.pmk.version());
  }, []);

  return (
    <main className="flex h-screen flex-col items-center justify-center gap-6 font-sans">
      <h1 className="text-3xl font-semibold tracking-tight">pmk desktop</h1>
      <p className="text-sm text-neutral-400">
        M2.1 scaffold · Electron {electronVer || "…"} · bridge: {bridge}
      </p>
      <p className="text-xs text-neutral-500">
        Next milestone: 3-pane layout + Monaco editor (M2.2)
      </p>
    </main>
  );
}
