import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { Config } from "./domain";
import { Button } from "./ui";
import { generateProcessorCode } from "./processor-code";

export function ProcessorCodePanel({ config, valid }: { config: Config; valid: boolean }) {
  const snippet = useMemo<{ code?: string; setup?: string[]; error: string }>(() => {
    if (!valid) return { error: "Apply or discard your schema changes to generate code for the current configuration." };
    try { return { ...generateProcessorCode(config), error: "" }; }
    catch (error) { return { error: (error as Error).message }; }
  }, [config, valid]);
  const [status, setStatus] = useState("");
  const codeRef = useRef<HTMLTextAreaElement>(null);
  const revision = useRef(0);
  useEffect(() => { revision.current++; setStatus(""); }, [snippet]);
  async function copy() {
    if (!snippet.code) return;
    const current = revision.current;
    try {
      await navigator.clipboard.writeText(snippet.code);
      if (current === revision.current) setStatus("Copied to clipboard");
    } catch {
      if (current !== revision.current) return;
      codeRef.current?.focus();
      codeRef.current?.select();
      setStatus("Clipboard unavailable. Code selected; press ⌘C or Ctrl+C to copy.");
    }
  }
  return (
    <div className="processor-code-panel">
      <div className="processor-code-heading">
        <div><h2>Use this processor in code</h2><p>Python · {config.parser} → {config.model}</p></div>
        <Button onClick={copy} disabled={!snippet.code}>
          {status === "Copied to clipboard" ? <Check size={14} /> : <Copy size={14} />}
          {status === "Copied to clipboard" ? "Copied" : "Copy code"}
        </Button>
      </div>
      {snippet.error ? <p className="schema-error" role="alert">{snippet.error}</p> : <>
        <p className="processor-code-note">Uses your current instructions and full output schema. Run the snippet in your Python environment.</p>
        <ul className="processor-code-setup">{snippet.setup?.map(line => <li key={line}>{line}</li>)}</ul>
        <textarea ref={codeRef} className="processor-code-editor" aria-label="Python processor code" value={snippet.code} readOnly spellCheck={false} wrap="off" />
      </>}
      <p className="processor-code-status" role="status">{status}</p>
    </div>
  );
}
