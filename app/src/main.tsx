import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// StrictMode double-mounts cause two PTY sessions + spurious WS closes
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
