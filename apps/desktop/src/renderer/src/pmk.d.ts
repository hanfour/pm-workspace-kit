export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  tracked: boolean;
  children?: TreeNode[];
}

export interface PmkApi {
  ping: () => string;
  version: () => string;
  fs: {
    listWorkspace: () => Promise<{ cwd: string; entries: TreeNode[] }>;
    readFile: (path: string) => Promise<string>;
    writeFile: (
      path: string,
      content: string,
    ) => Promise<{ size: number; mtime: number }>;
  };
  llm: {
    chat: (
      systemPrompt: string,
      messages: Array<{ role: "user" | "assistant"; content: string }>,
      onToken: (chunk: string) => void,
    ) => Promise<string>;
    status: () => Promise<{ providerName: string; hint?: string }>;
    saveApiKey: (key: string) => Promise<void>;
  };
}

declare global {
  interface Window {
    pmk?: PmkApi;
  }
}

export {};
