export interface CorpusCase {
  name: string;
  /** ADF: the parsed document. HTML: the markup. */
  input: unknown;
  options?: { baseUrl?: string };
  markdown: string;
  /** Distinct warning codes, sorted. */
  warnings: string[];
}
