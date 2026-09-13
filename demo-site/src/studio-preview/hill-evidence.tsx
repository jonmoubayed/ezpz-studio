export type PairedComparison = {
  scored: number; fixed: number; regressed: number; net: number; gain: number;
  fields: { field: string; fixed: number; regressed: number; scored: number }[];
  regression_examples: { document_id: string; field: string; expected: unknown; before: unknown; after: unknown }[];
};
type Source = { page: number | null; text: string; selection: string };
export type Diagnosis = {
  run_id: string; scored: number; failed: number; failing_fields: number; scope: string;
  clusters: { field: string; failed: number; scored: number; pattern_count: number;
    patterns: { status: string; expected: unknown; actual: unknown; count: number;
      examples: { document_id: string; source: Source }[] }[];
    controls: { document_id: string; expected: unknown; actual: unknown; source: Source }[];
  }[];
};
const valueText = (value: unknown) => value === undefined ? 'Unavailable' : typeof value === 'string' ? value : JSON.stringify(value);
function SourceExcerpt({ source }: { source: Source }) {
  return <><small>{source.selection}{source.page != null ? ` · page ${source.page}` : ''}</small>{source.text && <blockquote>{source.text}</blockquote>}</>;
}
export function HillDiagnosis({ diagnosis }: { diagnosis: Diagnosis }) {
  return <details className="hill-diagnosis"><summary>Failure evidence · {diagnosis.failed} of {diagnosis.scored} fields failed across {diagnosis.failing_fields} field paths</summary>
    <p className="form-hint">{diagnosis.scope} These are observed mismatches; causes are hypotheses to test.</p>
    {diagnosis.clusters.map((cluster) => <details key={cluster.field} className="hill-cluster">
      <summary><strong>{cluster.field}</strong> · {cluster.failed}/{cluster.scored} failed · {cluster.pattern_count} patterns</summary>
      {cluster.patterns.map((pattern, index) => <div className="hill-pattern" key={index}>
        <strong>{pattern.count} document{pattern.count === 1 ? '' : 's'} · {pattern.status}</strong>
        <dl><dt>Expected</dt><dd>{valueText(pattern.expected)}</dd><dt>Extracted</dt><dd>{valueText(pattern.actual)}</dd></dl>
        {pattern.examples.map((example) => <details key={example.document_id}><summary>Source · {example.document_id}</summary><SourceExcerpt source={example.source} /></details>)}
      </div>)}
      {cluster.controls.map((control) => <details key={control.document_id}><summary>Passing control · {control.document_id}</summary><p>Expected and extracted: {valueText(control.expected)}</p><SourceExcerpt source={control.source} /></details>)}
    </details>)}
  </details>;
}
export function HillComparison({ comparison, label }: { comparison: PairedComparison; label: string }) {
  return <details className="hill-comparison"><summary>{label}: {comparison.fixed} fixed · {comparison.regressed} regressed · {comparison.net > 0 ? '+' : ''}{comparison.net} net / {comparison.scored} fields</summary>
    <div className="hill-table-scroll"><table><thead><tr><th>Field</th><th>Fixed</th><th>Regressed</th><th>Scored</th></tr></thead><tbody>
      {comparison.fields.filter((field) => field.fixed || field.regressed).map((field) => <tr key={field.field}><td>{field.field}</td><td>{field.fixed}</td><td>{field.regressed}</td><td>{field.scored}</td></tr>)}
    </tbody></table></div>
    {comparison.regression_examples.length > 0 && <details><summary>Regression examples (up to 12)</summary>{comparison.regression_examples.map((example) => <div className="hill-pattern" key={`${example.document_id}/${example.field}`}>
      <strong>{example.field} · {example.document_id}</strong><dl><dt>Expected</dt><dd>{valueText(example.expected)}</dd><dt>Previously</dt><dd>{valueText(example.before)}</dd><dt>Candidate</dt><dd>{valueText(example.after)}</dd></dl>
    </div>)}</details>}
  </details>;
}
