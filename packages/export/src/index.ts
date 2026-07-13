import { exportBibTeX } from "./bibtex";
import { exportCslJson } from "./csl";
import { exportCsv } from "./csv";
import { exportRis } from "./ris";
import type { ExportFormat, ExportPaper, ExportResult } from "./types";

export * from "./bibtex";
export * from "./csl";
export * from "./csv";
export * from "./ris";
export * from "./types";

/** Synchronous text export suitable for a Worker response or Queue-generated R2 object. */
export function exportPapers(papers: readonly ExportPaper[], format: ExportFormat): ExportResult {
  switch (format) {
    case "bibtex":
      return {
        content: exportBibTeX(papers),
        mediaType: "application/x-bibtex; charset=utf-8",
        fileExtension: "bib",
      };
    case "csl-json":
      return {
        content: exportCslJson(papers),
        mediaType: "application/vnd.citationstyles.csl+json; charset=utf-8",
        fileExtension: "json",
      };
    case "ris":
      return {
        content: exportRis(papers),
        mediaType: "application/x-research-info-systems; charset=utf-8",
        fileExtension: "ris",
      };
    case "csv":
      return {
        content: exportCsv(papers),
        mediaType: "text/csv; charset=utf-8",
        fileExtension: "csv",
      };
    case "json":
      return {
        content: JSON.stringify(papers, null, 2),
        mediaType: "application/json; charset=utf-8",
        fileExtension: "json",
      };
  }
}
