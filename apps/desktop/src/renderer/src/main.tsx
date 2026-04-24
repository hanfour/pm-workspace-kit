import React from "react";
import ReactDOM from "react-dom/client";
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { App } from "./App";
import "./index.css";

// Load Monaco from the bundled package instead of the default CDN.
// Electron's CSP blocks external scripts and we want offline support.
loader.config({ monaco });

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
