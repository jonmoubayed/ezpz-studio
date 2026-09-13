import { FieldSelect } from "./components/field-select";
import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Braces,
  Copy,
  FileScan,
  Plus,
  Search,
  Settings2,
} from "lucide-react";
import { Button, Badge, Heading, Empty } from "./ui";
import { useStudio } from "./store";
import { processorStarters, type Config } from "./domain";
import { ModelMark } from "./pages";
function fieldCount(c: Config) {
  try {
    return Object.keys(JSON.parse(c.schema).properties || {}).length;
  } catch {
    return 0;
  }
}
export function Processors() {
  const s = useStudio();
  const [creating, setCreating] = useState(!!s.newProcessorDraft);
  const [starter, setStarter] = useState(
    s.newProcessorDraft ? "current" : "blank",
  );
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const config =
    starter === "current" && s.newProcessorDraft
      ? s.newProcessorDraft
      : processorStarters.find((t) => t.id === starter)!.config;
  const begin = (id = "blank") => {
    setStarter(id);
    setCreating(true);
    const t = processorStarters.find((t) => t.id === id);
    setName(id === "blank" ? "" : (t?.name ?? ""));
    setDescription(t?.description ?? "");
  };
  return (
    <div className="processors-page">
      <Heading
        title={creating ? "New processor" : "Processors"}
        description={
          creating
            ? "Start with any document type. Every field and setting is editable."
            : "Reusable extractors, each with its own model, instructions, schema, and version history."
        }
        actions={
          !creating && (
            <Button variant="primary" onClick={() => begin()}>
              <Plus size={14} />
              New processor
            </Button>
          )
        }
      />
      {creating ? (
        <section className="processor-create panel">
          <div className="processor-create-intro">
            <Braces size={24} />
            <h2>Define your extractor</h2>
            <p>
              Save the configuration once. Reuse it in the playground and
              compare its iterations in evaluations.
            </p>
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await s.createProcessor(name, description, config);
            }}
          >
            <label>
              Processor name
              <input
                required
                maxLength={100}
                placeholder="e.g. Vendor invoice extraction"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Description
              <textarea
                rows={2}
                placeholder="What documents does this processor handle?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label>
              Starting schema
              <FieldSelect
                value={starter}
                onValueChange={(value) => {
                  setStarter(value);
                  const t = processorStarters.find((t) => t.id === value);
                  if (!name && t && t.id !== "blank") setName(t.name);
                }}
                aria-label="Starting schema"
                options={[
                  ...(s.newProcessorDraft
                    ? [
                        {
                          value: "current",
                          label: "Current playground configuration",
                        },
                      ]
                    : []),
                  ...processorStarters.map((t) => ({
                    value: t.id,
                    label: t.id === "blank" ? "Blank · fully custom" : t.name,
                  })),
                ]}
              />
            </label>
            <div className="processor-starter-preview">
              <span>
                {fieldCount(config)} initial fields · {config.model}
              </span>
              <p>{config.prompt}</p>
            </div>
            <div className="processor-create-actions">
              <Button
                onClick={() => {
                  setCreating(false);
                  s.setNewProcessorDraft(null);
                  setStarter("blank");
                }}
              >
                <ArrowLeft size={13} />
                Cancel
              </Button>
              <Button
                variant="primary"
                type="submit"
                disabled={s.busy || !name.trim()}
              >
                Create & customize <ArrowRight size={13} />
              </Button>
            </div>
          </form>
        </section>
      ) : (
        <>
          <div className="processor-starters">
            <span>QUICK START</span>
            {processorStarters
              .filter((t) => t.id !== "blank")
              .map((t) => (
                <button key={t.id} onClick={() => begin(t.id)}>
                  <Plus size={12} />
                  {t.name.replace(" extraction", "")}
                </button>
              ))}
            <small>Or start with a blank schema.</small>
          </div>
          <section className="panel processor-library">
            <div className="table-toolbar">
              <div className="search-box">
                <Search size={14} />
                <input
                  aria-label="Search processors"
                  placeholder="Search processors…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <span>{s.processors.length} saved processors</span>
            </div>
            <div className="eval-table-scroll">
              <table className="data-table processor-table">
                <thead>
                  <tr>
                    <th>Processor</th>
                    <th>Model</th>
                    <th>Schema</th>
                    <th>Version</th>
                    <th>Updated</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {s.processors
                    .filter((p) =>
                      `${p.name} ${p.description}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                    )
                    .map((p) => (
                      <tr key={p.id}>
                        <td>
                          <button
                            className="processor-name"
                            onClick={() => {
                              s.chooseProcessor(p);
                              s.navigate("Configuration");
                            }}
                          >
                            <span>
                              <FileScan size={16} />
                            </span>
                            <div>
                              <strong>{p.name}</strong>
                              <small>
                                {p.description || "Custom document extraction"}
                              </small>
                            </div>
                          </button>
                        </td>
                        <td>
                          <span className="eval-model">
                            <ModelMark provider={p.config.provider} />
                            {p.config.model}
                          </span>
                          <small>{p.config.parser}</small>
                        </td>
                        <td>{fieldCount(p.config)} fields</td>
                        <td>
                          <Badge>v{p.version}</Badge>
                        </td>
                        <td>
                          {new Date(p.updatedAt).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                        </td>
                        <td>
                          <div className="processor-row-actions">
                            <button
                              onClick={() => {
                                s.chooseProcessor(p);
                                s.navigate("Playground");
                              }}
                            >
                              Test <ArrowRight size={12} />
                            </button>
                            <button
                              aria-label={`Edit ${p.name}`}
                              title="Edit processor"
                              onClick={() => {
                                s.chooseProcessor(p);
                                s.navigate("Configuration");
                              }}
                            >
                              <Settings2 size={14} />
                            </button>
                            <button
                              aria-label={`Duplicate ${p.name}`}
                              title="Duplicate processor"
                              onClick={() => {
                                s.setNewProcessorDraft(
                                  structuredClone(p.config),
                                );
                                setStarter("current");
                                setName(`${p.name} copy`);
                                setDescription(p.description);
                                setCreating(true);
                              }}
                            >
                              <Copy size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {!s.processors.length && (
              <Empty
                title="Your first reusable extractor"
                description="Create a custom processor or use a starting schema above."
              />
            )}
          </section>
        </>
      )}
    </div>
  );
}
