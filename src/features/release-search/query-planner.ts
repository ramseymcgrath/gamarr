import type {
  PlannedQuery,
  QueryReason
} from "@/features/release-search/models";

export interface QueryPlanInput {
  title: string;
  alternativeNames: string[];
  releaseYear: number | null;
  titleIsAmbiguous: boolean;
  platformAliases: string[];
  categoryIds: string[];
}

function clean(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function planPrimaryQuery(
  input: Pick<
    QueryPlanInput,
    "title" | "releaseYear" | "titleIsAmbiguous" | "categoryIds"
  >
): PlannedQuery {
  return {
    term: clean([
      input.title,
      input.titleIsAmbiguous && input.releaseYear ? input.releaseYear : ""
    ].filter(Boolean).join(" ")),
    categories: [...input.categoryIds],
    reason: "canonical"
  };
}

export function planQueries(input: QueryPlanInput): PlannedQuery[] {
  const titles = [
    { value: input.title, reason: "canonical-platform" as QueryReason },
    ...input.alternativeNames.slice(0, 3).map((value) => ({
      value,
      reason: "alternate-platform" as QueryReason
    }))
  ];
  const aliases = input.platformAliases.length > 0
    ? input.platformAliases
    : [""];
  const seen = new Set<string>();
  const output: PlannedQuery[] = [];

  for (const title of titles) {
    for (const alias of aliases) {
      const term = clean([
        title.value,
        input.titleIsAmbiguous && input.releaseYear ? input.releaseYear : "",
        alias
      ].filter(Boolean).join(" "));
      const key = term.toLowerCase();
      if (!term || seen.has(key)) continue;
      seen.add(key);
      output.push({
        term,
        categories: [...input.categoryIds],
        reason: alias ? title.reason : "canonical"
      });
      if (output.length === 8) return output;
    }
  }
  return output;
}
