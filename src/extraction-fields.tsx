import { Fragment, type ReactNode } from "react";
import { fieldTree, type FieldNode } from "./extraction-output";

export function ExtractionFields<T extends { key: string }>({
  fields,
  renderField,
}: {
  fields: T[];
  renderField: (field: T, name: string) => ReactNode;
}) {
  function render(nodes: FieldNode<T>[]): ReactNode {
    return nodes.map((node) => node.children.length ? (
      <details className="extraction-object" key={node.path} open>
        <summary aria-label={`${node.path} object`}>
          <strong>{node.name}</strong>
          <span>object · {node.children.length} fields</span>
        </summary>
        <div className="extraction-object-fields">{render(node.children)}</div>
      </details>
    ) : (
      <Fragment key={node.path}>{renderField(node.field!, node.name)}</Fragment>
    ));
  }
  return <>{render(fieldTree(fields))}</>;
}
