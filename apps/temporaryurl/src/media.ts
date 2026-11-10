const FALLBACK_TYPE = "application/octet-stream";
const EXTENSION = /\.([a-z0-9]{1,10})$/i;
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

const TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  avif: "image/avif",
  c2pa: "application/c2pa",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  json: "application/json",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  txt: "text/plain",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  zip: "application/zip",
};

const EXTENSIONS_BY_TYPE: ReadonlyMap<string, string> = Object.entries(TYPES_BY_EXTENSION).reduce(
  (byType, [extension, type]) => (byType.has(type) ? byType : byType.set(type, extension)),
  new Map<string, string>(),
);

export function declaredType(header: string | undefined): string | null {
  const type = header?.split(";")[0].trim().toLowerCase() ?? "";
  const isUseful = MEDIA_TYPE.test(type) && type !== FALLBACK_TYPE;
  return isUseful ? type : null;
}

export function extensionOf(name: string | null, type: string | null): string | null {
  const named = name?.match(EXTENSION)?.[1].toLowerCase();
  if (named) return named;

  return type === null ? null : (EXTENSIONS_BY_TYPE.get(type) ?? null);
}

export function typeOf(extension: string, type: string | null): string {
  return type ?? TYPES_BY_EXTENSION[extension] ?? FALLBACK_TYPE;
}
