import { describe, expect, it } from "vitest";

import { extractDocumentMetadata } from "./extractor";

function htmlDocument(html: string): Document {
  const result = document.implementation.createHTMLDocument("");
  result.documentElement.innerHTML = html;
  return result;
}

describe("extractDocumentMetadata", () => {
  it("extracts Citation metadata, DOI, authors, and a PDF URL", () => {
    const page = htmlDocument(`
      <head>
        <meta name="citation_title" content="A Reliable Paper" />
        <meta name="citation_author" content="Ada Lovelace" />
        <meta name="citation_author" content="Grace Hopper" />
        <meta name="citation_publication_date" content="2025-04-12" />
        <meta name="citation_journal_title" content="Journal of Useful Tests" />
        <meta name="citation_doi" content="https://doi.org/10.1234/TEST.7" />
        <meta name="citation_pdf_url" content="/paper.pdf" />
      </head>
      <body></body>
    `);

    const metadata = extractDocumentMetadata(page, "https://example.test/articles/7");

    expect(metadata).toMatchObject({
      title: "A Reliable Paper",
      publicationYear: 2025,
      venue: "Journal of Useful Tests",
      doi: "10.1234/test.7",
      pdfUrl: "https://example.test/paper.pdf",
      isPdf: false,
    });
    expect(metadata.authors.map((author) => author.displayName)).toEqual([
      "Ada Lovelace",
      "Grace Hopper",
    ]);
    expect(metadata.detectedSources).toEqual(expect.arrayContaining(["citation", "doi", "pdf"]));
  });

  it("uses Dublin Core when Citation metadata is unavailable", () => {
    const page = htmlDocument(`
      <head>
        <meta name="DC.Title" content="Dublin Core Paper" />
        <meta name="DC.Creator" content="Katherine Johnson" />
        <meta name="DCTERMS.Date" content="2024" />
        <meta name="DC.Identifier" content="doi:10.5555/dc-1" />
      </head>
      <body></body>
    `);

    const metadata = extractDocumentMetadata(page, "https://repository.test/item/1");

    expect(metadata.title).toBe("Dublin Core Paper");
    expect(metadata.authors[0]?.displayName).toBe("Katherine Johnson");
    expect(metadata.detectedSources).toContain("dublin-core");
  });

  it("extracts ScholarlyArticle JSON-LD", () => {
    const page = htmlDocument(`
      <head>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "ScholarlyArticle",
            "headline": "Structured Knowledge",
            "author": [{"@type":"Person","name":"Mary Jackson"}],
            "datePublished": "2023-08-03",
            "identifier": "10.7777/jsonld.9",
            "encoding": "/downloads/structured.pdf"
          }
        </script>
      </head>
      <body></body>
    `);

    const metadata = extractDocumentMetadata(page, "https://publisher.test/paper");

    expect(metadata.title).toBe("Structured Knowledge");
    expect(metadata.publicationYear).toBe(2023);
    expect(metadata.doi).toBe("10.7777/jsonld.9");
    expect(metadata.pdfUrl).toBe("https://publisher.test/downloads/structured.pdf");
    expect(metadata.detectedSources).toContain("json-ld");
  });

  it("detects arXiv and direct PDF pages without structured metadata", () => {
    const page = htmlDocument(
      "<head><title>Attention Paper</title></head><body>arXiv:2401.12345v2</body>",
    );
    const metadata = extractDocumentMetadata(
      page,
      "https://arxiv.org/pdf/2401.12345v2.pdf",
      "application/pdf",
    );

    expect(metadata.arxivId).toBe("2401.12345");
    expect(metadata.pdfUrl).toBe("https://arxiv.org/pdf/2401.12345v2.pdf");
    expect(metadata.isPdf).toBe(true);
    expect(metadata.detectedSources).toEqual(expect.arrayContaining(["arxiv", "pdf"]));
  });

  it("prefers a link that is both labelled PDF and ends in .pdf", () => {
    const page = htmlDocument(`
      <head><title>Linked paper</title></head>
      <body>
        <a href="/preview">PDF preview</a>
        <a href="/files/final.pdf">Download PDF</a>
      </body>
    `);
    const metadata = extractDocumentMetadata(page, "https://example.test/article");
    expect(metadata.pdfUrl).toBe("https://example.test/files/final.pdf");
  });

  it("preserves balanced parentheses in a DOI", () => {
    const page = htmlDocument(`
      <head><meta name="citation_doi" content="10.1000/example(2025)" /></head>
      <body></body>
    `);
    const metadata = extractDocumentMetadata(page, "https://example.test/article");
    expect(metadata.doi).toBe("10.1000/example(2025)");
  });

  it("drops an unsafe PDF target supplied by page metadata", () => {
    const page = htmlDocument(`
      <head>
        <title>Untrusted PDF link</title>
        <meta name="citation_pdf_url" content="http://127.0.0.1/admin.pdf" />
      </head>
      <body></body>
    `);

    const metadata = extractDocumentMetadata(page, "https://publisher.test/article");
    expect(metadata.pdfUrl).toBeUndefined();
    expect(metadata.detectedSources).not.toContain("pdf");
  });

  it.each([
    "http://localhost/article",
    "https://192.168.0.10/article",
    "https://user:password@publisher.test/article",
    "chrome://settings/",
  ])("rejects an unsafe page URL: %s", (pageUrl) => {
    expect(() => extractDocumentMetadata(htmlDocument("<title>Paper</title>"), pageUrl)).toThrow();
  });
});
