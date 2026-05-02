export class CaptureBuffer {
  private readonly chunks: Buffer[] = [];
  private readonly cap: number;
  private stored = 0;
  private total = 0;

  constructor(cap: number) { this.cap = cap; }

  observe(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.stored >= this.cap) return;
    const remaining = this.cap - this.stored;
    const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
    this.chunks.push(slice);
    this.stored += slice.length;
  }

  bytes(): Buffer { return Buffer.concat(this.chunks); }

  get totalBytes(): number { return this.total; }
}
