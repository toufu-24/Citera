import { describe, expect, it } from "vitest";

import { exportPapers } from "./index";
import type { ExportPaper } from "./index";

const paper: ExportPaper = {
  id: "pap_01JTEST0000000000000000000",
  title: "Signals & Systems: 100% Reproducible",
  authors: [
    { displayName: "Ada Lovelace", givenName: "Ada", familyName: "Lovelace" },
    { displayName: "Alan Turing" },
  ],
  publicationYear: 2026,
  publicationDate: "2026-07-13",
  venue: "Journal, of Tests",
  volume: "12",
  issue: "3",
  pages: "10-20",
  publisher: "Test & Co.",
  paperType: "article-journal",
  status: "reading",
  rating: 5,
  doi: "10.1000/test_1",
  sourceUrl: "https://example.test/paper?a=1&b=2",
  abstract: 'First line\nSecond "quoted" line',
  keywords: ["signals"],
  tags: ["reading list", { name: "important" }],
};

describe("exportPapers", () => {
  it("produces escaped BibTeX with a stable citation key", () => {
    const result = exportPapers([paper], "bibtex");
    expect(result.fileExtension).toBe("bib");
    expect(result.content).toContain("@article{Lovelace2026Signals,");
    expect(result.content).toContain("title = {Signals \\& Systems: 100\\% Reproducible}");
    expect(result.content).toContain("author = {Lovelace, Ada and Alan Turing}");
    expect(result.content).toContain("doi = {10.1000/test\\_1}");
    expect(result.content).toContain("keywords = {signals, reading list, important}");
  });

  it("maps papers to valid CSL-JSON", () => {
    const result = exportPapers([paper], "csl-json");
    const parsed = JSON.parse(result.content);
    expect(parsed[0]).toMatchObject({
      id: "Lovelace2026Signals",
      type: "article-journal",
      title: paper.title,
      author: [{ family: "Lovelace", given: "Ada" }, { literal: "Alan Turing" }],
      issued: { "date-parts": [[2026, 7, 13]] },
      DOI: "10.1000/test_1",
    });
  });

  it("emits repeatable RIS fields and single-line values", () => {
    const result = exportPapers([paper], "ris");
    expect(result.content).toContain("TY  - JOUR\r\n");
    expect(result.content).toContain("AU  - Ada Lovelace\r\nAU  - Alan Turing");
    expect(result.content).toContain('AB  - First line Second "quoted" line');
    expect(result.content).toContain("SP  - 10\r\nEP  - 20");
    expect(result.content.endsWith("ER  - ")).toBe(true);
  });

  it("uses RFC 4180 quoting for CSV and preserves full objects in JSON", () => {
    const csv = exportPapers([paper], "csv").content;
    expect(csv).toContain("Signals & Systems: 100% Reproducible");
    expect(csv).toContain('"Journal, of Tests"');
    expect(csv).toContain('"First line\nSecond ""quoted"" line"');

    const json = JSON.parse(exportPapers([paper], "json").content);
    expect(json).toEqual([paper]);
  });

  it("neutralizes spreadsheet formula prefixes in CSV", () => {
    const csv = exportPapers(
      [{ ...paper, title: '=HYPERLINK("https://example.test")' }],
      "csv",
    ).content;
    expect(csv).toContain('"\'=HYPERLINK(""https://example.test"")"');
  });

  it("disambiguates colliding citation keys", () => {
    const duplicate = { ...paper, id: "other" };
    const bibtex = exportPapers([paper, duplicate], "bibtex").content;
    expect(bibtex).toContain("@article{Lovelace2026Signalsa,");
    expect(bibtex).toContain("@article{Lovelace2026Signalsb,");
  });
});
