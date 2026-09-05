import {
  withExpectedValues,
  expectedValues,
  equalValues,
} from "./result-model";
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import {
  defaultConfig,
  readStored,
  sampleDatasets,
  sampleGroups,
  sampleProcessors,
  type Processor,
  type EvalGroup,
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
import {
  evaluationDocuments,
  demoEvaluationDocuments,
} from "./evaluation-model";
export type ExpectedSaveResult = {
  ok: boolean;
  groundTruthSaved: boolean;
  dataset?: Dataset;
  alreadyMember?: boolean;
  error?: string;
};
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
  const initialDemo = new URLSearchParams(location.search).get("demo") === "1";
  const [mode, setMode] = useState<"demo" | "live">(
    initialDemo ? "demo" : "live",
  );
  const [connection, setConnection] = useState<
    "connecting" | "ready" | "offline"
  >(initialDemo ? "ready" : "connecting");
  const [adapters, setAdapters] = useState<api.AdapterCatalog | null>(null);
  const [reviewDocuments, setReviewDocuments] = useState<Document[]>([]);
  const [reviewRunId, setReviewRunId] = useState("");
  const [reviewLoading, setReviewLoading] = useState(false);
  const connectionAttempt = useRef(0);
  const reviewAttempt = useRef(0);
  const documentRequest = useRef(0);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);

  const [page, setPageState] = useState<Page>(() => {
    try {
      const page = decodeURIComponent(location.hash.slice(1)) as Page;
      return [
        "Overview",
        "Configuration",
        "Processors",
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
  const [documents, setDocuments] = useState<Document[]>(
    initialDemo ? sampleDocuments : [],
  );
  const [datasets, setDatasets] = useState<Dataset[]>(
    initialDemo ? sampleDatasets : [],
  );
  const [runs, setRuns] = useState<Run[]>(
    (initialDemo
      ? readStored<Run[]>("ezpz-redesign-runs", sampleRuns)
      : []
    ).map((r) => ({
      ...sampleRuns.find((sample) => sample.id === r.id),
      ...r,
    })),
  );
  const [evalGroups, setEvalGroups] = useState<EvalGroup[]>(
    initialDemo ? readStored("ezpz-redesign-groups", sampleGroups) : [],
  );
  const [selectedId, setSelectedId] = useState("sample-0");
  const [config, setConfig] = useState<Config>(
    initialDemo
      ? readStored("ezpz-redesign-config", defaultConfig)
      : defaultConfig,
  );
  const [reviews, setReviews] = useState<Review[]>(
    initialDemo ? readStored("ezpz-redesign-reviews", []) : [],
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [processors, setProcessors] = useState<Processor[]>(
    initialDemo ? readStored("ezpz-redesign-processors", sampleProcessors) : [],
  );
  const [activeProcessorId, setActiveProcessorId] = useState<string>(
    initialDemo ? readStored("ezpz-redesign-active-processor", "") : "",
  );
  const [configRevision, setConfigRevision] = useState(0);
  const [newProcessorDraft, setNewProcessorDraft] = useState<Config | null>(
    null,
  );
  const activeProcessor = processors.find((p) => p.id === activeProcessorId);
  function chooseProcessor(p: Processor, config = p.config) {
    setActiveProcessorId(p.id);
    localStorage.setItem(
      mode === "demo"
        ? "ezpz-redesign-active-processor"
        : "ezpz-live-active-processor",
      JSON.stringify(p.id),
    );
    setConfig(structuredClone(config));
    localStorage.setItem(
      mode === "demo" ? "ezpz-redesign-config" : `ezpz-live-config:${p.id}`,
      JSON.stringify(config),
    );
    setConfigRevision((v) => v + 1);
  }
  function persistProcessors(next: Processor[]) {
    setProcessors(next);
    if (mode === "demo")
      localStorage.setItem("ezpz-redesign-processors", JSON.stringify(next));
  }
  async function createProcessor(name: string, description: string, c: Config) {
    setBusy(true);
    try {
      if (
        processors.some(
          (p) => p.name.toLowerCase() === name.trim().toLowerCase(),
        )
      )
        throw new Error(
          "A processor with this name already exists. Choose a different name.",
        );
      const id = crypto.randomUUID(),
        date = new Date().toISOString();
      const p: Processor =
        mode === "live"
          ? api.normalizeProcessor(
              await api.newProcessor(name.trim(), c, description),
            )
          : {
              id,
              name: name.trim(),
              description,
              config: structuredClone(c),
              version: 1,
              versionId: id,
              updatedAt: date,
              versions: [{ id, version: 1, config: structuredClone(c), date }],
            };
      persistProcessors([p, ...processors]);
      chooseProcessor(p);
      setNewProcessorDraft(null);
      navigate("Configuration");
      setMessage(
        "Processor saved. Customize its configuration and test it in the playground.",
      );
      return true;
    } catch (e) {
      notifyError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function saveProcessor(name: string, description: string) {
    if (!activeProcessor) return false;
    setBusy(true);
    try {
      if (!name.trim()) throw new Error("Give this processor a name.");
      if (
        processors.some(
          (p) =>
            p.id !== activeProcessor.id &&
            p.name.toLowerCase() === name.trim().toLowerCase(),
        )
      )
        throw new Error("A processor with this name already exists.");
      let next: Processor;
      if (mode === "live") {
        await api.saveProcessorVersion(activeProcessor.id, config, {
          name: name.trim(),
          description,
        });
        next = api.normalizeProcessor(
          (await api.request(`/processors/${activeProcessor.id}`)).processor,
        );
      } else {
        const version = activeProcessor.version + 1,
          id = crypto.randomUUID(),
          date = new Date().toISOString();
        next = {
          ...activeProcessor,
          name: name.trim(),
          description,
          config: structuredClone(config),
          version,
          versionId: id,
          updatedAt: date,
          versions: [
            { id, version, config: structuredClone(config), date },
            ...activeProcessor.versions,
          ],
        };
      }
      persistProcessors(processors.map((p) => (p.id === next.id ? next : p)));
      setMessage(`Saved ${next.name} · version ${next.version}.`);
      return true;
    } catch (e) {
      notifyError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function saveAsProcessor() {
    setNewProcessorDraft(structuredClone(config));
    navigate("Processors");
  }
  const selected = documents.find((d) => d.id === selectedId) || documents[0];
  function navigate(p: Page) {
    setPageState(p);
    window.scrollTo({ top: 0, behavior: "instant" });
    location.hash = encodeURIComponent(p);
  }
  function updateConfig(c: Config) {
    setConfig(c);
    localStorage.setItem(
      mode === "demo"
        ? "ezpz-redesign-config"
        : `ezpz-live-config:${activeProcessorId || "scratch"}`,
      JSON.stringify(c),
    );
  }
  function updateDocument(d: Document) {
    setDocuments((ds) => ds.map((x) => (x.id === d.id ? d : x)));
  }
  function selectDocument(d: Document) {
    setSelectedId(d.id);
    if (mode === "live")
      localStorage.setItem("ezpz-live-document", JSON.stringify(d.id));
  }
  useEffect(() => {
    if (mode !== "live" || connection !== "ready" || !selectedId) return;
    const abort = new AbortController();
    const attempt = ++documentRequest.current;
    const doc = documents.find((d) => d.id === selectedId);
    if (doc) {
      updateDocument({ ...doc, fields: [], runId: undefined, warnings: [] });
      api
        .inspectDocument(doc, activeProcessorId, abort.signal)
        .then((result) => {
          if (!abort.signal.aborted && attempt === documentRequest.current)
            updateDocument(result);
        })
        .catch((e) => {
          if (!abort.signal.aborted) notifyError(e);
        });
    }
    return () => abort.abort();
  }, [selectedId, activeProcessorId, mode, connection, workspaceRevision]);
  function notifyError(e: unknown) {
    setMessage(
      e instanceof Error
        ? e.message
        : "Something went wrong. Please try again.",
    );
  }
  async function loadReviewRun(
    id: string,
    workspace = documents,
    live = mode === "live",
  ) {
    const attempt = ++reviewAttempt.current;
    setReviewLoading(true);
    setReviewDocuments([]);
    setReviews([]);
    setReviewRunId(id);
    try {
      if (live) {
        const { run } = await api.request(`/runs/${encodeURIComponent(id)}`);
        if (attempt !== reviewAttempt.current) return false;
        setReviewDocuments(evaluationDocuments(run, workspace));
        setReviews(
          (run.review_decisions || []).map((r: any) => ({
            documentId: r.document_id,
            field: r.field_path,
            status: r.status,
            value: r.corrected_value,
            note: r.note || "",
            runId: id,
            at: r.updated_at,
          })),
        );
        localStorage.setItem("ezpz-live-review-run", JSON.stringify(id));
      } else {
        const run = runs.find((r) => r.id === id);
        if (run) setReviewDocuments(demoEvaluationDocuments(run));
        setReviews(readStored("ezpz-redesign-reviews", []));
      }
      return true;
    } catch (e) {
      if (attempt === reviewAttempt.current) notifyError(e);
      return false;
    } finally {
      if (attempt === reviewAttempt.current) setReviewLoading(false);
    }
  }
  async function connect() {
    const attempt = ++connectionAttempt.current;
    setBusy(true);
    setMode("live");
    setConnection("connecting");
    setMessage("");
    ++reviewAttempt.current;
    setReviewRunId("");
    setReviewDocuments([]);
    setReviews([]);
    try {
      await api.request("/ready", { signal: AbortSignal.timeout(5000) });
      const data = await api.loadWorkspace();
      if (attempt !== connectionAttempt.current) return;
      setDocuments(data.documents);
      setDatasets(data.datasets);
      setRuns(data.runs);
      setProcessors(data.processors);
      setEvalGroups(data.evalGroups);
      setAdapters(data.adapters);
      const savedDocument = readStored("ezpz-live-document", "");
      setSelectedId(
        data.documents.find((d) => d.id === savedDocument)?.id ||
          data.documents[0]?.id ||
          "",
      );
      const savedProcessor = readStored("ezpz-live-active-processor", "");
      const processor =
        data.processors.find((p) => p.id === savedProcessor) ||
        data.processors[0];
      setActiveProcessorId(processor?.id || "");
      setConfig(
        readStored(
          `ezpz-live-config:${processor?.id || "scratch"}`,
          processor?.config || defaultConfig,
        ),
      );
      setConfigRevision((v) => v + 1);
      setConnection("ready");
      setWorkspaceRevision((v) => v + 1);
      const url = new URL(location.href);
      url.searchParams.delete("demo");
      history.replaceState(null, "", url);
      const savedReview = readStored("ezpz-live-review-run", "");
      const run = data.runs.find((r) => r.id === savedReview) || data.runs[0];
      if (run) await loadReviewRun(run.id, data.documents, true);
    } catch (e) {
      if (attempt === connectionAttempt.current) {
        setConnection("offline");
        notifyError(e);
      }
    } finally {
      if (attempt === connectionAttempt.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (!initialDemo) void connect();
    return () => {
      ++connectionAttempt.current;
      ++reviewAttempt.current;
    };
  }, []);
  function demo() {
    ++connectionAttempt.current;
    ++reviewAttempt.current;
    setReviewLoading(false);
    setBusy(false);
    setConnection("ready");
    setReviewRunId("");
    setReviewDocuments([]);
    setConfig(readStored("ezpz-redesign-config", defaultConfig));
    setConfigRevision((v) => v + 1);
    const url = new URL(location.href);
    url.searchParams.set("demo", "1");
    history.replaceState(null, "", url);
    setMode("demo");
    setProcessors(readStored("ezpz-redesign-processors", sampleProcessors));
    setActiveProcessorId(readStored("ezpz-redesign-active-processor", ""));
    setDocuments(sampleDocuments);
    setDatasets(sampleDatasets);
    setEvalGroups(readStored("ezpz-redesign-groups", sampleGroups));
    setRuns(
      readStored<Run[]>("ezpz-redesign-runs", sampleRuns).map((r) => ({
        ...sampleRuns.find((sample) => sample.id === r.id),
        ...r,
      })),
    );
    setReviews(readStored("ezpz-redesign-reviews", []));
    setSelectedId("sample-0");
    setMessage(
      "Demo workspace loaded. Scores and extractions are illustrative fixtures.",
    );
  }
  function resetDemo() {
    localStorage.removeItem("ezpz-redesign-groups");
    localStorage.removeItem("ezpz-redesign-processors");
    localStorage.removeItem("ezpz-redesign-active-processor");
    localStorage.removeItem("ezpz-redesign-runs");
    localStorage.removeItem("ezpz-redesign-reviews");
    localStorage.removeItem("ezpz-redesign-config");
    demo();
    setMessage("Demo reset to the original sample documents and experiments.");
  }
  async function refresh() {
    if (mode === "live") {
      const data = await api.loadWorkspace();
      setDocuments((current) =>
        data.documents.map((d) => ({
          ...current.find((old) => old.id === d.id),
          ...d,
          fields: current.find((old) => old.id === d.id)?.fields || [],
        })),
      );
      setRuns(data.runs);
      setAdapters(data.adapters);
      setDatasets(data.datasets);
      setProcessors(data.processors);
      setEvalGroups(data.evalGroups);
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
      if (added[0]) selectDocument(added[0]);
      setUploadOpen(false);
      navigate(page === "Configuration" ? "Configuration" : "Playground");
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
    if (!selected) return null;
    ++documentRequest.current;
    setBusy(true);
    try {
      if (mode === "demo") {
        if (!selected.sample)
          throw new Error(
            "Your file is ready to preview. Connect the local API in Settings to run a real extraction.",
          );
        const extracted = withExpectedValues(
          {
            ...selected,
            fields: sampleDocuments.find((d) => d.id === selected.id)!.fields,
          },
          expectedValues(selected),
        );
        updateDocument(extracted);
        if (page !== "Configuration")
          setMessage(
            "Demo extraction loaded from the sample fixture. No model was called.",
          );
        return extracted;
      } else {
        let processor = activeProcessor || processors[0];
        if (!processor) {
          processor = api.normalizeProcessor(
            await api.newProcessor(`studio-preview-${Date.now()}`, config),
          );
          setProcessors([processor]);
        }
        const result = await api.previewDocument(
          selected,
          config,
          processor.id,
        );
        const extraction = result.extraction || result;
        const { ground_truth } = await api.request(
          `/documents/${selected.id}/ground-truth`,
        );
        const extracted: Document = {
          ...selected,
          fields: api.extractionFields(extraction, ground_truth),
          groundTruth: ground_truth?.value || {},
          status: "Extracted",
          runId: undefined,
          warnings: extraction.warnings || result.warnings || [],
        };
        updateDocument(extracted);
        if (page !== "Configuration")
          setMessage(
            "Extraction preview complete. This preview has not created an evaluation run.",
          );
        return extracted;
      }
    } catch (e) {
      notifyError(e);
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function benchmark(
    name: string,
    datasetId: string,
    configuration: Config = config,
    group?: { id?: string; name?: string; processorId?: string },
  ) {
    setBusy(true);
    try {
      if (mode === "demo") {
        const ds = datasets.find((d) => d.id === datasetId);
        let targetGroup = evalGroups.find((g) =>
          group?.id
            ? g.id === group.id
            : !group?.name && g.datasetId === datasetId,
        );
        if (!targetGroup) {
          targetGroup = {
            id: crypto.randomUUID(),
            name: group?.name || `${name} · iterations`,
            datasetId,
          };
          const nextGroups = [...evalGroups, targetGroup];
          setEvalGroups(nextGroups);
          localStorage.setItem(
            "ezpz-redesign-groups",
            JSON.stringify(nextGroups),
          );
        }
        const r: Run = {
          ...sampleRuns[0],
          id: crypto.randomUUID(),
          name,
          groupId: targetGroup.id,
          groupName: targetGroup.name,
          config: structuredClone(configuration),
          experimentId: crypto.randomUUID(),
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
        await api.runBenchmark(datasetId, configuration, name, {
          ...group,
          processorId: group?.processorId || activeProcessor?.id,
        });
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
  function updateExpectedValues(id: string, value: Record<string, JsonValue>) {
    setDocuments((ds) =>
      ds.map((d) => (d.id === id ? withExpectedValues(d, value) : d)),
    );
  }
  async function saveExpectedValues(
    d: Document,
    value: Record<string, JsonValue>,
    target?: { id?: string; name?: string },
  ): Promise<ExpectedSaveResult> {
    setMessage("");
    setBusy(true);
    let groundTruthSaved = false;
    let dataset: Dataset | undefined;
    let alreadyMember = false;
    try {
      if (mode === "live") {
        const saved = await api.saveGroundTruth(d.id, value);
        if (!equalValues(saved.ground_truth?.value ?? null, value))
          throw new Error(
            "The API did not confirm the expected values. Please retry.",
          );
        groundTruthSaved = true;
        updateExpectedValues(d.id, value);
        if (target) {
          if (target.id) {
            const data = await api.request(
              `/datasets/${encodeURIComponent(target.id)}`,
            );
            dataset = {
              id: data.dataset.id,
              name: data.dataset.name,
              description: data.dataset.description || "",
              count: data.documents.length,
              members: data.documents.map((doc: any) => doc.id),
            };
            alreadyMember = dataset.members!.includes(d.id);
          } else {
            const created = await api.createDataset(target.name!.trim(), []);
            dataset = {
              id: created.id,
              name: created.name,
              description: created.description || "",
              count: 0,
              members: [],
            };
            // Keep the created ID even if adding the document fails, so retry cannot create another dataset.
            setDatasets((ds) => [
              ...ds.filter((item) => item.id !== dataset!.id),
              dataset!,
            ]);
          }
          // An existing member only needs its ground truth updated; preserve its split and tags.
          if (!alreadyMember) await api.addDatasetDocument(dataset.id, d.id);
          const { manifest } = await api.request(
            `/datasets/${encodeURIComponent(dataset.id)}/manifest`,
          );
          const member = manifest.documents.find(
            (doc: any) => doc.document_id === d.id,
          );
          if (!member || !equalValues(member.ground_truth, value))
            throw new Error(
              "Could not verify this document and its expected values in the dataset. Please retry.",
            );
          dataset = {
            ...dataset,
            count: manifest.documents.length,
            members: manifest.documents.map((doc: any) => doc.document_id),
          };
          setDatasets((ds) => [
            ...ds.filter((item) => item.id !== dataset!.id),
            dataset!,
          ]);
        }
      } else {
        updateExpectedValues(d.id, value);
        groundTruthSaved = true;
        if (target) {
          const current = datasets.find((item) => item.id === target.id);
          if (target.id && !current)
            throw new Error("Dataset not found. Choose another dataset.");
          const members =
            current?.members ||
            (current
              ? documents
                  .filter((doc) => doc.sample)
                  .slice(0, current.count)
                  .map((doc) => doc.id)
              : []);
          alreadyMember = members.includes(d.id);
          const nextMembers = [...new Set([...members, d.id])];
          dataset = {
            id: current?.id || crypto.randomUUID(),
            name: current?.name || target.name!.trim(),
            description: current?.description || "Added from expected values",
            count: nextMembers.length,
            members: nextMembers,
          };
          setDatasets((ds) => [
            ...ds.filter((item) => item.id !== dataset!.id),
            dataset!,
          ]);
        }
      }
      return { ok: true, groundTruthSaved, dataset, alreadyMember };
    } catch (e) {
      const reason = e instanceof Error ? e.message : "Please try again.";
      const error = groundTruthSaved
        ? `Ground truth was saved, but the dataset operation could not be confirmed. ${reason}`
        : `Ground truth could not be saved. ${reason}`;
      setMessage(error);
      return { ok: false, groundTruthSaved, dataset, alreadyMember, error };
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
    updateExpectedValues,
    saveExpectedValues,
    connection,
    adapters,
    reviewDocuments:
      mode === "demo" && !reviewRunId ? documents : reviewDocuments,
    reviewRunId,
    reviewLoading,
    loadReviewRun,
    page,
    navigate,
    documents,
    setDocuments,
    datasets,
    setDatasets,
    runs,
    evalGroups,
    processors,
    configRevision,
    activeProcessor,
    activeProcessorId,
    chooseProcessor,
    createProcessor,
    saveProcessor,
    saveAsProcessor,
    newProcessorDraft,
    setNewProcessorDraft,
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
