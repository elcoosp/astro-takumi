import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { FontLoader, ImageSource } from "@takumi-rs/core";
import type { IntegrationOptions, RenderFunction } from "./types.js";

export const CACHE_VERSION = 1;

export interface ManifestEntry {
  pathname: string;
  htmlHash: string;
  key: string;
  ts: number;
}

export interface Manifest {
  version: number;
  globalKey: string;
  entries: Record<string, ManifestEntry>;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function pageCacheKey(globalKey: string, pathname: string, htmlHash: string): string {
  return sha256Hex(`${globalKey}\u0000${pathname}\u0000${htmlHash}`);
}

function hashBytes(data: Uint8Array | ArrayBuffer | string): string {
  if (typeof data === "string") return sha256Hex(data);
  if (data instanceof ArrayBuffer) return sha256Hex(new Uint8Array(data));
  return sha256Hex(data);
}

export function hashFontLoader(f: FontLoader): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- FontLoader is an untagged union from @takumi-rs/core; runtime discrimination is required.
  if (typeof f === "string") return sha256Hex(`str:${f}`);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- FontLoader is an untagged union.
  if (typeof f === "function") {
    // SAFETY: Function type is narrowed by typeof check above.
    return sha256Hex(`fn:${(f as (...args: unknown[]) => string).toString()}`);
  }
  if (f instanceof Uint8Array) return sha256Hex(`bytes:${hashBytes(f)}`);
  if (f instanceof ArrayBuffer) return sha256Hex(`bytes:${hashBytes(f)}`);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- FontLoader is an untagged union.
  if (typeof f === "object" && f !== null) {
    // SAFETY: f is narrowed to object && !== null. We map known font descriptor fields.
    type FontDesc = Record<string, unknown>;
    const obj = f as FontDesc;
    const parts: string[] = [];
    for (const k of Object.keys(obj).sort()) {
      const v = obj[k];
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Runtime check for union members.
      if (v instanceof Uint8Array || v instanceof ArrayBuffer || typeof v === "string") {
        parts.push(`${k}=${hashBytes(v)}`);
      } else if (Array.isArray(v)) {
        parts.push(`${k}=${JSON.stringify(v)}`);
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Runtime check for union members.
      } else if (typeof v === "number" || typeof v === "boolean") {
        parts.push(`${k}=${String(v)}`);
      }
    }
    return sha256Hex(`obj:${parts.join(",")}`);
  }
  return "font:unknown";
}

export interface VersionInfo {
  integration: string;
  core: string;
}

export function readVersions(): VersionInfo {
  const require = createRequire(import.meta.url);
  let integration = "unknown";
  let core = "unknown";
  try {
    // SAFETY: package.json is known to have an optional version string.
    const pkg = require("../package.json") as { version?: string };
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Runtime check for optional field.
    if (typeof pkg.version === "string") integration = pkg.version;
  } catch {
    /* empty */
  }
  try {
    const main = require.resolve("@takumi-rs/core");
    let dir = path.dirname(main);
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, "package.json");
      if (fs.existsSync(candidate)) {
        // SAFETY: core package.json is known to have an optional version string.
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as { version?: string };
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Runtime check for optional field.
        if (typeof parsed.version === "string") {
          core = parsed.version;
          break;
        }
      }
      dir = path.dirname(dir);
    }
  } catch {
    /* empty */
  }
  return { integration, core };
}

export function computeGlobalKey(input: {
  render: RenderFunction;
  options: IntegrationOptions;
  versions: VersionInfo;
}): string {
  const o = input.options;
  const lossy = o.format === "jpeg" || o.format === "webp";
  return sha256Hex(
    JSON.stringify({
      v: CACHE_VERSION,
      integ: input.versions.integration,
      core: input.versions.core,
      render: String(input.render),
      cacheKey: o.cacheKey ?? null,
      width: o.width,
      height: o.height,
      format: o.format,
      quality: lossy ? o.quality : null,
      debug: o.drawDebugBorder,
      domBackend: o.domBackend,
      fontFamilies: o.fontFamilies ?? null,
      fonts: (o.fonts ?? []).map(hashFontLoader),
      images: (o.images ?? []).map((im: ImageSource) => ({
        src: im.src,
        // SAFETY: ImageSource.data is typed as Uint8Array | ArrayBuffer | string in @takumi-rs/core.
        data: hashBytes(im.data as Uint8Array | ArrayBuffer | string),
      })),
    }),
  );
}

export function defaultCacheRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return path.join(dir, "node_modules", ".cache", "astro-takumi");
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), "node_modules", ".cache", "astro-takumi");
}

export class OgCache {
  readonly root: string;
  readonly blobsDir: string;
  readonly fetchDir: string;
  readonly htmlDir: string;
  private readonly manifestPath: string;
  private manifest: Manifest;
  private dirty = false;

  constructor(root: string, globalKey: string) {
    this.root = root;
    this.blobsDir = path.join(root, "blobs");
    this.fetchDir = path.join(root, "fetch");
    this.htmlDir = path.join(root, "html");
    this.manifestPath = path.join(root, "manifest.json");
    this.manifest = { version: CACHE_VERSION, globalKey, entries: {} };
  }

  static async load(root: string): Promise<Manifest | undefined> {
    try {
      const raw = await fsp.readFile(path.join(root, "manifest.json"), "utf8");
      const parsed: unknown = JSON.parse(raw);
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Runtime check for JSON parse result.
      if (typeof parsed !== "object" || parsed === null) return undefined;
      // SAFETY: parsed is an object, we validate version and globalKey below.
      const m = parsed as Manifest;
      if (m.version !== CACHE_VERSION || typeof m.globalKey !== "string") return undefined;
      return m;
    } catch {
      return undefined;
    }
  }

  async init(): Promise<void> {
    const existing = await OgCache.load(this.root);
    if (existing !== undefined && existing.globalKey === this.manifest.globalKey) {
      this.manifest = existing;
    } else {
      await fsp.rm(this.blobsDir, { recursive: true, force: true });
      await fsp.rm(this.fetchDir, { recursive: true, force: true });
      await fsp.rm(this.htmlDir, { recursive: true, force: true });
      this.manifest = { version: CACHE_VERSION, globalKey: this.manifest.globalKey, entries: {} };
      await this.flush();
    }
    await fsp.mkdir(this.blobsDir, { recursive: true });
    await fsp.mkdir(this.fetchDir, { recursive: true });
    await fsp.mkdir(this.htmlDir, { recursive: true });
  }

  getEntry(pathname: string): ManifestEntry | undefined {
    return this.manifest.entries[pathname];
  }

  blobPath(key: string): string {
    return path.join(this.blobsDir, `${key}.bin`);
  }

  async hasBlob(key: string): Promise<boolean> {
    try {
      await fsp.access(this.blobPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async putBlob(key: string, bytes: Uint8Array): Promise<void> {
    const finalPath = this.blobPath(key);
    const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmpPath, bytes);
      await fsp.rename(tmpPath, finalPath);
    } catch (e) {
      try {
        await fsp.unlink(tmpPath);
      } catch {
        // best-effort cleanup
      }
      throw e;
    }
  }

  record(entry: ManifestEntry): void {
    this.manifest.entries[entry.pathname] = entry;
    this.dirty = true;
  }

  async snapshotHtml(htmlHash: string, html: Uint8Array): Promise<void> {
    const file = path.join(this.htmlDir, `${htmlHash}.gz`);
    if (fs.existsSync(file)) return;
    const tmpPath = `${file}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmpPath, gzipSync(html, { level: 6 }));
      await fsp.rename(tmpPath, file);
    } catch (e) {
      try {
        await fsp.unlink(tmpPath);
      } catch {
        // best-effort cleanup
      }
      throw e;
    }
  }

  async readHtmlSnapshot(htmlHash: string): Promise<Buffer | undefined> {
    try {
      return gunzipSync(await fsp.readFile(path.join(this.htmlDir, `${htmlHash}.gz`)));
    } catch {
      return undefined;
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await fsp.mkdir(this.root, { recursive: true });
    await fsp.writeFile(this.manifestPath, JSON.stringify(this.manifest));
    this.dirty = false;
  }
}

export class DiskFetchCache extends Map<string, Promise<ArrayBuffer>> {
  constructor(private readonly fetchDir: string) {
    super();
  }

  private fileFor(url: string): string {
    return path.join(this.fetchDir, `${sha256Hex(url)}.bin`);
  }

  override get(url: string): Promise<ArrayBuffer> | undefined {
    const inMemory = super.get(url);
    if (inMemory !== undefined) return inMemory;
    if (!isFetchable(url)) return undefined;
    const file = this.fileFor(url);
    if (!fs.existsSync(file)) return undefined;
    const promise = fsp.readFile(file).then((buf) => toArrayBuffer(buf));
    super.set(url, promise);
    return promise;
  }

  override set(url: string, value: Promise<ArrayBuffer>): this {
    if (isFetchable(url)) {
      const file = this.fileFor(url);
      const wrapped = value.then(async (buf) => {
        try {
          await fsp.mkdir(path.dirname(file), { recursive: true });
          const tmpPath = `${file}.${randomUUID()}.tmp`;
          await fsp.writeFile(tmpPath, Buffer.from(buf));
          await fsp.rename(tmpPath, file);
        } catch {
          // best-effort persistence; memory cache still valid
        }
        return buf;
      });
      return super.set(url, wrapped);
    }
    return super.set(url, value);
  }
}

function isFetchable(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  // SAFETY: Node Buffer always wraps an ArrayBuffer with matching byteOffset/length.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
