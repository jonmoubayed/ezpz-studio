import { displayValue, type JsonValue } from "./domain";

export function isObjectArray(
  value: JsonValue,
): value is Record<string, JsonValue>[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item !== null && typeof item === "object" && !Array.isArray(item),
    )
  );
}

export function StructuredValue({
  value,
  label,
}: {
  value: JsonValue;
  label: string;
}) {
  if (!isObjectArray(value)) return <code>{displayValue(value)}</code>;
  if (!value.length) return <p className="structured-empty">No items</p>;
  const columns = [...new Set(value.flatMap((row) => Object.keys(row)))];
  const wideColumns = new Set(
    columns.filter((key) =>
      value.some(
        (row) =>
          typeof row[key] === "string" && (row[key] as string).length > 40,
      ),
    ),
  );
  return (
    <div
      className="structured-table-scroll"
      role="region"
      aria-label={`${label} table, ${value.length} ${value.length === 1 ? "row" : "rows"}`}
      tabIndex={0}
    >
      <table className="structured-table" aria-label={label}>
        <thead>
          <tr>
            <th scope="col" className="structured-row-number">
              #
            </th>
            {columns.map((key) => (
              <th
                scope="col"
                key={key}
                className={
                  wideColumns.has(key) ? "structured-text-column" : undefined
                }
              >
                {key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {value.map((row, index) => (
            <tr key={index}>
              <th scope="row" className="structured-row-number">
                {index + 1}
              </th>
              {columns.map((key) => (
                <td
                  key={key}
                  className={
                    wideColumns.has(key) ? "structured-text-column" : undefined
                  }
                >
                  {Object.hasOwn(row, key) ? (
                    <code>{displayValue(row[key])}</code>
                  ) : (
                    <span
                      className="structured-missing"
                      aria-label="Missing value"
                    >
                      —
                    </span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
