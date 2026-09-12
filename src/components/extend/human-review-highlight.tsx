// Extracted from Extend UI bounding-box-citations (MIT). See EXTEND-LICENSE.md.
import { cn } from "@/lib/utils";
export type ReviewLocation = {
  source?: "model";
  page: number;
  area: { left: number; top: number; width: number; height: number };
};
const REVIEW_HIGHLIGHT_STYLE =
  "border-blue-500/70 bg-blue-500/12 shadow-[0_4px_16px_rgb(59_130_246_/_10%)]";
export function HumanReviewHighlight({
  location,
}: {
  location: ReviewLocation;
}) {
  const area = location.area;
  return (
    <div
      role="img"
      aria-label={`${location.source === "model" ? "Model-estimated source box" : "Source citation"} on page ${location.page}`}
      title={location.source === "model" ? "Model-estimated location" : "Source citation"}
      data-source-citation
      className={cn(
        "pointer-events-none absolute z-10 border",
        REVIEW_HIGHLIGHT_STYLE,
      )}
      style={{
        // Keep citations visible above the app's unlayered global border reset.
        borderColor: "rgba(59, 130, 246, 0.7)",
        borderStyle: location.source === "model" ? "dashed" : "solid",
        left: `${area.left}%`,
        top: `${area.top}%`,
        width: `${area.width}%`,
        height: `${area.height}%`,
      }}
    />
  );
}
