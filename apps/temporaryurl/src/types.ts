export interface StoredEntry {
  sha512: string;
  type: string;
  ext: string;
  size: number;
}

export interface Store {
  shortOf(sha512: string): Promise<string | null>;
  entry(short: string): Promise<StoredEntry | null>;
  body(short: string): Promise<Buffer | null>;
  claim(short: string, entry: StoredEntry, body: Buffer, ttlSeconds: number): Promise<boolean>;
  refresh(short: string, sha512: string, ttlSeconds: number): Promise<void>;
  ping(): Promise<boolean>;
}

export interface Published {
  short: string;
  entry: StoredEntry;
}
