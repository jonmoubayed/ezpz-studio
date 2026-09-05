import "../demo/install-network";
import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";
import App from "./App";
import { StudioProvider } from "./store";
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <main style={{ padding: 48, fontFamily: "sans-serif" }}>
        <h1>Something didn’t load</h1>
        <p>{this.state.error}</p>
        <button onClick={() => location.reload()}>Reload studio</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <StudioProvider>
      <App />
    </StudioProvider>
  </ErrorBoundary>,
);
