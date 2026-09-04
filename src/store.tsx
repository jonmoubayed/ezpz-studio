import { createContext, useContext, useState, type ReactNode } from "react";
import {
  defaultConfig,
  readStored,
  sampleDatasets,
  sampleDocuments,
  sampleRuns,
  type Config,
  type JsonValue,
  type Dataset,
  type Document,
  type Page,
  type Run,
} from "./domain";
import * as api from "./api";
type Review = {
  documentId: string;
  field: string;
  status: string;
  value: JsonValue;
  note: string;
  runId: string;
  at: string;
};
function useStore() {
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [page, setPageState] = useState<Page>(() => {
    try {
      const page = decodeURIComponent(location.hash.slice(1)) as Page;
      return [
        "Overview",
        "Playground",
        "Datasets",
        "Evaluations",
        "Hill climbing",
        "Review queue",
        "Settings",
      ].includes(page)
        ? page
        : "Overview";
    } catch {
      return "Overview";
    }
  });
  const [documents, setDocuments] = useState<Document[]>(sampleDocuments);
  const [datasets, setDatasets] = useState<Dataset[]>(sampleDatasets);
  const [runs, setRuns] = useState<Run[]>(
    readStored("ezpz-redesign-runs", sampleRuns),
  );
  const [selectedId, setSelectedId] = useState("sample-0");
  const [config, setConfig] = useState<Config>(
    readStored("ezpz-redesign-config", defaultConfig),
  );
  const [reviews, setReviews] = useState<Review[]>(
    readStored("ezpz-redesign-reviews", []),
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [processors, setProcessors] = useState<any[]>([]);
  const selected = documents.find((d) => d.id === selectedId) || documents[0];
  function navigate(p: Page) {
    setPageState(p);
    window.scrollTo({ top: 0, behavior: "instant" });
    location.hash = encodeURIComponent(p);
  }
  function updateConfig(c: Config) {
    setConfig(c);
    localStorage.setItem("ezpz-redesign-config", JSON.stringify(c));
  }
  function updateDocument(d: Document) {
    setDocuments((ds) => ds.map((x) => (x.id === d.id ? d : x)));
  }
  async function selectDocument(d: Document) {
    setSelectedId(d.id);
    if (mode === "live")
      try {
        updateDocument(await api.inspectDocument(d));
      } catch (e) {
        notifyError(e);
      }
  }
  function notifyError(e: unknown) {
    setMessage(
      e instanceof Error
        ? e.message
        : "Something went wrong. Please try again.",
    );
  }
  async function connect() {
    setBusy(true);
    try {
      const data = await api.loadWorkspace();
      setDocuments(data.documents);
      setDatasets(data.datasets);
      setRuns(data.runs);
      setProcessors(data.processors);
      setSelectedId(data.documents[0]?.id || "");
      setMode("live");
      setReviews([]);
      setMessage(
        "Connected to your local ezpz API. You are viewing real workspace data.",
      );
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  }
  function demo() {
    setMode("demo");
    setDocuments(sampleDocuments);
    setDatasets(sampleDatasets);
    setRuns(readStored("ezpz-redesign-runs", sampleRuns));
    setReviews(readStored("ezpz-redesign-reviews", []));
    setSelectedId("sample-0");
    setMessage(
      "Demo workspace loaded. Scores and extractions are illustrative fixtures.",
    );
  }
  function resetDemo() {
    localStorage.removeItem("ezpz-redesign-runs");
    localStorage.removeItem("ezpz-redesign-reviews");
    updateConfig(defaultConfig);
    demo();
    setMessage("Demo reset to the original sample documents and experiments.");
  }
  async function refresh() {
    if (mode === "live") {
      const data = await api.loadWorkspace();
      setRuns(data.runs);
      setDatasets(data.datasets);
      setProcessors(data.processors);
    }
  }
  async function upload(files: File[]) {
    setBusy(true);
    try {
      const added: Document[] = [];
      for (const f of files) {
        if (f.size > 25 * 1024 * 1024)
          throw new Error("Please choose files smaller than 25 MB.");
        added.push(
          mode === "live"
            ? await api.uploadDocument(f)
            : {
                id: crypto.randomUUID(),
                name: f.name,
                src: URL.createObjectURL(f),
                type: f.type,
                pages: 1,
                status: "Ready",
                fields: [],
              },
        );
      }
      setDocuments((d) => [...added, ...d]);
      if (added[0]) setSelectedId(added[0].id);
      setUploadOpen(false);
      navigate("Playground");
      setMessage(
        mode === "demo"
          ? "Files opened locally for this session. Connect the local API to extract your own documents."
          : "Documents uploaded to your local workspace.",
      );
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  }
  async function extract() {
    if (!selected) return;
    setBusy(true);
    try {
      if (mode === "demo") {
        if (!selected.sample)
          throw new Error(
            "Your file is ready to preview. Connect the local API in Settings to run a real extraction.",
          );
        updateDocument({
          ...selected,
          fields: sampleDocuments.find((d) => d.id === selected.id)!.fields,
        });
        setMessage(
          "Demo extraction loaded from the sample fixture. No model was called.",
        );
      } else {
        let processor = processors[0];
        if (!processor) {
          processor = await api.newProcessor(
            `studio-preview-${Date.now()}`,
            config,
          );
          setProcessors([processor]);
        }
        const result = await api.previewDocument(
          selected,
          config,
          processor.name,
        );
        const extraction = result.extraction || result;
        updateDocument({
          ...selected,
          fields: api.extractionFields(extraction),
          status: "Extracted",
          runId: undefined,
          warnings: extraction.warnings || result.warnings || [],
        });
        setMessage(
          "Extraction preview complete. This preview has not created an evaluation run.",
        );
      }
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  }
  async function benchmark(
    name: string,
    datasetId: string,
    configuration: Config = config,
  ) {
    setBusy(true);
    try {
      if (mode === "demo") {
        const ds = datasets.find((d) => d.id === datasetId);
        const r: Run = {
          ...sampleRuns[0],
          id: crypto.randomUUID(),
          name,
          model: configuration.model,
          provider: configuration.provider,
          score: 0.976,
          date: new Date().toISOString(),
          version: runs.length + 3,
          datasetId,
          dataset: ds?.name || "Demo benchmark",
          documents: ds?.count || 6,
        };
        const next = [r, ...runs];
        setRuns(next);
        localStorage.setItem("ezpz-redesign-runs", JSON.stringify(next));
        setMessage(
          "Demo run added using a fixed illustrative score. Connect the API to measure real changes.",
        );
      } else {
        await api.runBenchmark(datasetId, configuration, name);
        await refresh();
        setMessage(
          "Benchmark complete. The run and its configuration are saved in the local API.",
        );
      }
      return true;
    } catch (e) {
      notifyError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function review(
    d: Document,
    f: string,
    status: string,
    value: JsonValue,
    note: string,
  ) {
    setBusy(true);
    try {
      const runId = d.runId || "";
      if (mode === "live") {
        if (!runId)
          throw new Error(
            "Select a scored run in Evaluations to review a field. Previews do not have a saved evaluation.",
          );
        await api.saveFeedback(runId, d.id, f, status, value, note);
      }
      const next = [
        ...reviews.filter(
          (r) => !(r.documentId === d.id && r.field === f && r.runId === runId),
        ),
        {
          documentId: d.id,
          field: f,
          status,
          value,
          note,
          runId,
          at: new Date().toISOString(),
        },
      ];
      setReviews(next);
      if (mode === "demo")
        localStorage.setItem("ezpz-redesign-reviews", JSON.stringify(next));
      setMessage("Review saved. The original extraction remains preserved.");
      return true;
    } catch (e) {
      notifyError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return {
    mode,
    page,
    navigate,
    documents,
    setDocuments,
    datasets,
    setDatasets,
    runs,
    setRuns,
    selected,
    selectedId,
    selectDocument,
    setSelectedId,
    config,
    updateConfig,
    reviews,
    setReviews,
    review,
    message,
    setMessage,
    busy,
    setBusy,
    uploadOpen,
    setUploadOpen,
    upload,
    extract,
    benchmark,
    connect,
    demo,
    resetDemo,
    refresh,
    notifyError,
    updateDocument,
  };
}
type Store = ReturnType<typeof useStore>;
const Context = createContext<Store | null>(null);
export function StudioProvider({ children }: { children: ReactNode }) {
  const store = useStore();
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useStudio() {
  const context = useContext(Context);
  if (!context) throw new Error("Missing StudioProvider");
  return context;
}
