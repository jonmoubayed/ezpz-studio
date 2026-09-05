import { lazy, Suspense, useEffect, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Box,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  ChevronRight,
  Command,
  Database,
  FileScan,
  FlaskConical,
  FolderOpen,
  HelpCircle,
  House,
  Layers,
  Menu,
  MessageSquareText,
  Monitor,
  Mountain,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { FileUpload } from "./components/extend/file-upload";
import { Button, Modal, Notice, Busy } from "./ui";
import { useStudio } from "./store";
import { Overview, HillClimbing, Datasets, Settings } from "./pages";
import { Playground, ReviewQueue } from "./workbench";
import { Processors } from "./processors";
import { Evaluations } from "./evaluations";
const Configuration = lazy(() =>
  import("./configuration").then((m) => ({ default: m.Configuration })),
);
import type { Page } from "./domain";
const navigation: { page: Page; icon: typeof House; label?: string }[] = [
  { page: "Overview", icon: House },
  { page: "Playground", icon: FileScan },
  { page: "Processors", icon: Layers },
  { page: "Datasets", icon: Database },
  { page: "Evaluations", icon: ChartNoAxesCombined },
  { page: "Hill climbing", icon: Mountain },
  { page: "Review queue", icon: MessageSquareText },
];
export default function App() {
  const s = useStudio();
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sidebar, setSidebar] = useState(false);
  const [help, setHelp] = useState(false);
  const [mobile, setMobile] = useState(
    () => matchMedia("(max-width:760px)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(max-width:760px)");
    const change = () => setMobile(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const remaining = s.documents.reduce(
    (n, d) =>
      n +
      d.fields.filter(
        (f) =>
          (s.mode === "demo" || !!d.runId) &&
          (f.confidence < 0.9 ||
            (f.status && f.status !== "correct" && f.status !== "unscored")) &&
          !s.reviews.some(
            (r) =>
              r.documentId === d.id &&
              r.field === f.key &&
              r.runId === (d.runId || ""),
          ),
      ).length,
    0,
  );
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebar(false);
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", listener);
    const hash = () => {
      const p = decodeURIComponent(location.hash.slice(1)) as Page;
      if (
        [
          ...navigation.map((n) => n.page),
          "Settings",
          "Configuration",
        ].includes(p)
      )
        s.navigate(p);
    };
    window.addEventListener("hashchange", hash);
    return () => {
      document.removeEventListener("keydown", listener);
      window.removeEventListener("hashchange", hash);
    };
  }, []);
  function navigate(p: Page) {
    s.navigate(p);
    setSidebar(false);
    setSearchOpen(false);
  }
  const currentNavigation =
    s.page === "Configuration"
      ? s.activeProcessor
        ? "Processors"
        : "Playground"
      : s.page;
  const nav = (item: (typeof navigation)[number]) => (
    <button
      key={item.page}
      onClick={() => navigate(item.page)}
      className={`nav-item ${currentNavigation === item.page ? "active" : ""}`}
      aria-current={currentNavigation === item.page ? "page" : undefined}
    >
      <item.icon size={17} />
      <span>{item.page}</span>
      {item.page === "Review queue" && remaining > 0 && (
        <span className="nav-count">{remaining}</span>
      )}
      {currentNavigation === item.page && item.page !== "Review queue" && (
        <span className="active-dot" />
      )}
    </button>
  );
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {sidebar && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside
        id="studio-navigation"
        inert={mobile && !sidebar}
        className={`sidebar ${sidebar ? "is-open" : ""}`}
      >
        <a href="#Overview" className="brand" aria-label="ezpz studio home">
          <span className="brand-mark">
            <img src="/assets/brand/field-mark.png" width={24} height={24} alt="" />
          </span>
          <strong>
            ezpz<span>studio</span>
          </strong>
          <span className="brand-version">beta</span>
        </a>
        <button
          className="workspace-switch"
          onClick={() => navigate("Settings")}
        >
          <span className="workspace-symbol">
            <Box size={17} />
          </span>
          <span>
            <strong>My workspace</strong>
            <small>Local environment</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <button className="search-trigger" onClick={() => setSearchOpen(true)}>
          <Search size={15} />
          <span>Quick search</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="nav-caption">WORKSPACE</div>
        <nav>
          {navigation.slice(0, 4).map(nav)}
          <div className="nav-caption loop-caption">EXPERIMENT & IMPROVE</div>
          {navigation.slice(4).map(nav)}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-card">
            <span className="local-orbit">
              <ShieldCheck size={19} />
            </span>
            <strong>Your models. Your data.</strong>
            <p>
              A little less black box.
              <br />A lot more possibility.
            </p>
            <button onClick={() => navigate("Settings")}>
              Explore connections
              <ArrowUpRight size={13} />
            </button>
          </div>
          <button
            className={`nav-item ${s.page === "Settings" ? "active" : ""}`}
            onClick={() => navigate("Settings")}
          >
            <Settings2 size={17} />
            Settings
          </button>
          <button className="nav-item" onClick={() => setHelp(true)}>
            <BookOpen size={17} />
            Getting started
            <ArrowUpRight size={14} />
          </button>
          <div className="sidebar-footer">
            <span className="avatar">
              <Monitor size={15} />
            </span>
            <div>
              <strong>Local workspace</strong>
              <small>
                <i />
                {s.mode === "demo" ? "Demo mode" : "API connected"}
              </small>
            </div>
            <Monitor size={16} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              aria-expanded={sidebar}
              aria-controls="studio-navigation"
              onClick={() => setSidebar(true)}
            >
              <Menu size={18} />
            </button>
            <Box size={15} />
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{s.page}</strong>
          </div>
          <div className="topbar-right">
            <span className={`connection-pill ${s.mode}`}>
              <i />
              {s.mode === "demo" ? "Demo workspace" : "Local API connected"}
            </span>
            <button
              className="icon-button"
              aria-label="Open getting started guide"
              onClick={() => setHelp(true)}
            >
              <HelpCircle size={18} />
            </button>
            <span className="avatar small" title="Local workspace">
              <Monitor size={13} />
            </span>
          </div>
        </header>
        <main
          id="main"
          className={`main-content ${s.page === "Playground" || s.page === "Review queue" ? "workbench-main" : ""}`}
        >
          {s.message && (
            <Notice onClose={() => s.setMessage("")}>{s.message}</Notice>
          )}
          {s.page === "Overview" ? (
            <Overview />
          ) : s.page === "Playground" ? (
            <Playground />
          ) : s.page === "Configuration" ? (
            <Suspense fallback={<Busy label="Loading configuration editor…" />}>
              <Configuration
                key={`${s.activeProcessorId || "scratch"}-${s.configRevision}`}
              />
            </Suspense>
          ) : s.page === "Processors" ? (
            <Processors />
          ) : s.page === "Evaluations" ? (
            <Evaluations />
          ) : s.page === "Hill climbing" ? (
            <HillClimbing />
          ) : s.page === "Datasets" ? (
            <Datasets />
          ) : s.page === "Review queue" ? (
            <ReviewQueue />
          ) : (
            <Settings />
          )}
        </main>
        <footer className="app-footer">
          <span>
            <i /> Local-first. Model-agnostic. Open possibilities.
          </span>
          <span>
            {s.mode === "demo"
              ? "Illustrative demo data · no model calls"
              : "Connected to your ezpz backend"}
            <span className="footer-sep">/</span>ezpz studio
          </span>
        </footer>
      </div>
      <Modal
        title="Add documents"
        description={
          s.mode === "demo"
            ? "Preview files in this browser. Sample documents have simulated extraction results."
            : "Upload source documents to your local ezpz workspace."
        }
        open={s.uploadOpen}
        onClose={() => s.setUploadOpen(false)}
      >
        <FileUpload
          accept=".pdf,.png,.jpg,.jpeg,.txt,.csv"
          description="PDF, PNG, JPG, TXT or CSV · up to 25 MB each"
          showBorderBeam={false}
          showFileList={false}
          onFilesAccepted={s.upload}
        />
        {s.busy && <Busy label="Adding documents…" />}
      </Modal>
      <Modal
        title="Jump to anything"
        description="Find a workspace page or document."
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
      >
        <div className="search-box large">
          <Search size={18} />
          <input
            autoFocus
            aria-label="Search workspace"
            placeholder="Search pages and documents…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <kbd>ESC</kbd>
        </div>
        <div className="command-results">
          {navigation
            .filter((n) => n.page.toLowerCase().includes(search.toLowerCase()))
            .map((n) => (
              <button key={n.page} onClick={() => navigate(n.page)}>
                <n.icon size={17} />
                {n.page}
                <ArrowRight size={15} />
              </button>
            ))}
          {s.documents
            .filter((d) => d.name.toLowerCase().includes(search.toLowerCase()))
            .slice(0, 6)
            .map((d) => (
              <button
                key={d.id}
                onClick={() => {
                  s.selectDocument(d);
                  navigate("Playground");
                }}
              >
                <FileScan size={17} />
                {d.name}
                <ArrowRight size={15} />
              </button>
            ))}
        </div>
      </Modal>
      <Modal
        title="Your document improvement loop"
        description="A few small steps from raw files to reliable extraction."
        open={help}
        onClose={() => setHelp(false)}
      >
        <div className="guide">
          {[
            [
              "01",
              "Explore a document",
              "Open Playground, select a source, and inspect each field alongside its citation.",
            ],
            [
              "02",
              "Measure what matters",
              "Create a dataset with ground truth, then compare immutable evaluation runs.",
            ],
            [
              "03",
              "Try a better configuration",
              "Change the prompt, parser, or model in Hill climbing and run the same benchmark.",
            ],
            [
              "04",
              "Close the feedback loop",
              "Correct uncertain fields in the review queue. Keep feedback separate from the original extraction.",
            ],
          ].map(([n, t, d]) => (
            <div key={n}>
              <span>{n}</span>
              <section>
                <h3>{t}</h3>
                <p>{d}</p>
              </section>
            </div>
          ))}
        </div>
        <Button
          variant="primary"
          onClick={() => {
            navigate("Playground");
            setHelp(false);
          }}
        >
          Open playground
          <ArrowRight size={15} />
        </Button>
      </Modal>
    </div>
  );
}
