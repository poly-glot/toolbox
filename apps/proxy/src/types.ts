export type RawHeaders     = NodeJS.Dict<string | string[]>;
export type DisplayHeaders = Record<string, string>;

export interface BodySnippetText {
  kind: "text";
  bytes: number;
  truncated: boolean;
  data: string;
}

export interface BodySnippetBinary {
  kind: "binary";
  bytes: number;
  contentType: string | null;
  preview: string;
}

export interface BodySnippetEmpty {
  kind: "empty";
}

export type BodySnippet = BodySnippetText | BodySnippetBinary | BodySnippetEmpty;

export interface TailEntry {
  id: string;
  startedAt: string;
  durationMs: number;
  method: string;
  target: string;
  request: {
    headers: Record<string, string>;
    body: BodySnippet;
  };
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: BodySnippet;
  };
  error?: string;
}
