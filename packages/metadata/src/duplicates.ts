import { normalizeArxivId, normalizeDoi, normalizeUrl } from "@citera/domain";

import { scoreMetadataMatch } from "./merge";
import type { BibliographicMetadata } from "./types";

export interface DuplicatePaper extends BibliographicMetadata {
  id: string;
  sha256?: string;
}

export type DuplicateReason = "doi" | "arxiv" | "sha256" | "fuzzy" | "url";

export interface DuplicateCandidate {
  paper: DuplicatePaper;
  score: number;
  strength: "exact" | "strong" | "possible";
  reasons: DuplicateReason[];
}

const PRIORITY: Readonly<Record<DuplicateReason, number>> = {
  doi: 1,
  arxiv: 2,
  sha256: 3,
  fuzzy: 4,
  url: 5,
};

/** Returns candidates only; fuzzy matches must always be confirmed by the user. */
export function findDuplicateCandidates(
  incoming: DuplicatePaper,
  existingPapers: readonly DuplicatePaper[],
  fuzzyThreshold = 0.8,
): DuplicateCandidate[] {
  const incomingDoi = normalizeDoi(incoming.doi);
  const incomingArxiv = normalizeArxivId(incoming.arxivId);
  const incomingUrl = normalizeUrl(incoming.url);
  const matches: Array<DuplicateCandidate & { priority: number }> = [];

  for (const existing of existingPapers) {
    if (existing.id === incoming.id) continue;
    const reasons: DuplicateReason[] = [];
    if (incomingDoi != null && incomingDoi === normalizeDoi(existing.doi)) reasons.push("doi");
    if (incomingArxiv != null && incomingArxiv === normalizeArxivId(existing.arxivId)) {
      reasons.push("arxiv");
    }
    if (
      incoming.sha256 != null &&
      existing.sha256 != null &&
      incoming.sha256.toLowerCase() === existing.sha256.toLowerCase()
    ) {
      reasons.push("sha256");
    }

    const fuzzyScore = scoreMetadataMatch(
      {
        title: incoming.title ?? "",
        ...(incoming.authors == null
          ? {}
          : { authors: incoming.authors.map((author) => author.displayName) }),
        ...(incoming.publicationYear == null ? {} : { publicationYear: incoming.publicationYear }),
        ...(incoming.venue == null ? {} : { venue: incoming.venue }),
      },
      existing,
    );
    if (fuzzyScore >= fuzzyThreshold) reasons.push("fuzzy");
    if (incomingUrl != null && incomingUrl === normalizeUrl(existing.url)) reasons.push("url");
    if (reasons.length === 0) continue;

    const exact =
      reasons.includes("doi") || reasons.includes("arxiv") || reasons.includes("sha256");
    const score = reasons.includes("doi")
      ? 1
      : reasons.includes("arxiv")
        ? 0.999
        : reasons.includes("sha256")
          ? 0.998
          : reasons.includes("url")
            ? Math.max(0.96, fuzzyScore)
            : fuzzyScore;
    matches.push({
      paper: existing,
      reasons,
      score,
      strength: exact ? "exact" : score >= 0.92 ? "strong" : "possible",
      priority: Math.min(...reasons.map((reason) => PRIORITY[reason])),
    });
  }

  return matches
    .sort((left, right) => left.priority - right.priority || right.score - left.score)
    .map((match) => ({
      paper: match.paper,
      reasons: match.reasons,
      score: match.score,
      strength: match.strength,
    }));
}

export const detectDuplicates = findDuplicateCandidates;
