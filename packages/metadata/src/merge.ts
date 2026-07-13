import { normalizeComparableText } from "@citera/domain";

import type {
  BibliographicMetadata,
  MetadataCandidate,
  MetadataField,
  MetadataSearchQuery,
} from "./types";

const METADATA_FIELDS = [
  "title",
  "abstract",
  "authors",
  "publicationDate",
  "publicationYear",
  "venue",
  "volume",
  "issue",
  "pages",
  "publisher",
  "language",
  "paperType",
  "doi",
  "arxivId",
  "url",
  "pdfUrl",
  "keywords",
] as const satisfies readonly MetadataField[];

const SOURCE_CONFIDENCE: Readonly<Record<MetadataCandidate["matchType"], number>> = {
  user: 1,
  "exact-identifier": 0.99,
  structured: 0.9,
  embedded: 0.75,
  import: 0.8,
  fuzzy: 0.6,
};

export interface MergedMetadataField<Value = BibliographicMetadata[MetadataField]> {
  value: Value;
  source: MetadataCandidate["source"];
  confidence: number;
  retrievedAt: string;
  reference?: string;
}

export interface MergedMetadata {
  metadata: BibliographicMetadata;
  fields: Partial<Record<MetadataField, MergedMetadataField>>;
  metadataState: "complete" | "needs_review";
}

function hasValue(value: unknown): boolean {
  if (value == null || value === "") return false;
  return !Array.isArray(value) || value.length > 0;
}

function confidenceFor(candidate: MetadataCandidate, field: MetadataField): number {
  const stated = candidate.fieldConfidences?.[field] ?? candidate.confidence;
  return Math.max(0, Math.min(1, Math.max(stated, SOURCE_CONFIDENCE[candidate.matchType])));
}

/** Selects every field independently. User values always outrank automated refreshes. */
export function mergeMetadata(candidates: readonly MetadataCandidate[]): MergedMetadata {
  const fields: Partial<Record<MetadataField, MergedMetadataField>> = {};

  for (const candidate of candidates) {
    for (const field of METADATA_FIELDS) {
      const value = candidate.metadata[field];
      if (!hasValue(value)) continue;
      const confidence = confidenceFor(candidate, field);
      const current = fields[field];
      if (
        current != null &&
        (current.source === "user" ||
          current.confidence > confidence ||
          (current.confidence === confidence && current.retrievedAt >= candidate.retrievedAt))
      ) {
        continue;
      }
      fields[field] = {
        value,
        source: candidate.source,
        confidence,
        retrievedAt: candidate.retrievedAt,
        ...(candidate.reference == null ? {} : { reference: candidate.reference }),
      };
    }
  }

  const metadata = Object.fromEntries(
    Object.entries(fields).map(([field, selected]) => [field, selected?.value]),
  ) as BibliographicMetadata;
  const essentialFieldsReliable =
    fields.title != null &&
    fields.title.confidence >= 0.9 &&
    (fields.authors == null || fields.authors.confidence >= 0.9);

  return {
    metadata,
    fields,
    metadataState: essentialFieldsReliable ? "complete" : "needs_review",
  };
}

function bigrams(value: string): string[] {
  const characters = [...normalizeComparableText(value)];
  if (characters.length < 2) return characters;
  return characters
    .slice(0, -1)
    .map((character, index) => character + (characters[index + 1] ?? ""));
}

/** Sørensen-Dice similarity after Unicode/case/whitespace normalization. */
export function stringSimilarity(left: string | undefined, right: string | undefined): number {
  if (left == null || right == null) return 0;
  const normalizedLeft = normalizeComparableText(left);
  const normalizedRight = normalizeComparableText(right);
  if (normalizedLeft === normalizedRight) return normalizedLeft === "" ? 0 : 1;
  const leftPairs = bigrams(normalizedLeft);
  const rightPairs = bigrams(normalizedRight);
  if (leftPairs.length === 0 || rightPairs.length === 0) return 0;

  const remaining = new Map<string, number>();
  for (const pair of rightPairs) remaining.set(pair, (remaining.get(pair) ?? 0) + 1);
  let overlap = 0;
  for (const pair of leftPairs) {
    const count = remaining.get(pair) ?? 0;
    if (count > 0) {
      overlap += 1;
      remaining.set(pair, count - 1);
    }
  }
  return (2 * overlap) / (leftPairs.length + rightPairs.length);
}

function authorSimilarity(
  query: readonly string[] | undefined,
  candidate: BibliographicMetadata,
): number {
  const candidateAuthors = candidate.authors;
  if (
    query == null ||
    query.length === 0 ||
    candidateAuthors == null ||
    candidateAuthors.length === 0
  ) {
    return 0;
  }
  return (
    query.reduce((total, queryAuthor) => {
      const best = Math.max(
        ...candidateAuthors.map((author) => stringSimilarity(queryAuthor, author.displayName)),
      );
      return total + best;
    }, 0) / query.length
  );
}

/** Implements 0.65 title + 0.20 author + 0.10 year + 0.05 venue scoring. */
export function scoreMetadataMatch(
  query: MetadataSearchQuery,
  candidate: BibliographicMetadata,
): number {
  const title = stringSimilarity(query.title, candidate.title);
  const authors = authorSimilarity(query.authors, candidate);
  const year =
    query.publicationYear == null || candidate.publicationYear == null
      ? 0
      : query.publicationYear === candidate.publicationYear
        ? 1
        : Math.abs(query.publicationYear - candidate.publicationYear) === 1
          ? 0.5
          : 0;
  const venue = stringSimilarity(query.venue, candidate.venue);
  return Math.round((0.65 * title + 0.2 * authors + 0.1 * year + 0.05 * venue) * 10_000) / 10_000;
}

export interface RankedMetadataCandidate {
  candidate: MetadataCandidate;
  score: number;
}

export function rankMetadataCandidates(
  query: MetadataSearchQuery,
  candidates: readonly MetadataCandidate[],
): RankedMetadataCandidate[] {
  return candidates
    .map((candidate) => ({ candidate, score: scoreMetadataMatch(query, candidate.metadata) }))
    .sort((left, right) => right.score - left.score);
}

export function shouldAutoAccept(
  ranked: readonly Pick<RankedMetadataCandidate, "score">[],
  minimumScore = 0.92,
  minimumMargin = 0.08,
): boolean {
  const first = ranked[0]?.score ?? 0;
  const second = ranked[1]?.score ?? 0;
  return first >= minimumScore && first - second >= minimumMargin;
}
