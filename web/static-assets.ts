// Copies files from src/assets into dist/<name>-<hash>.<ext> without
// esbuild. JS, TSX, and CSS entries stay on the esbuild path in build.ts.
//
// The hash matches esbuild's copy-loader [hash] (esbuild 0.28 HashForFileName):
// XXH64 of the raw bytes, written big-endian, then the first 8 characters of
// Go's base32.StdEncoding. Bundled JS and CSS use that same 8-character
// base32 encoding; their input is the linker hash rather than the raw bytes.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const hashBytes = 8;
const hashChars = 8;
const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const prime1 = 0x9e3779b185ebca87n;
const prime2 = 0xc2b2ae3d27d4eb4fn;
const prime3 = 0x165667b19e3779f9n;
const prime4 = 0x85ebca77c2b2ae63n;
const prime5 = 0x27d4eb2f165667c5n;
const mask64 = 0xffffffffffffffffn;

function rotl(x: bigint, n: number): bigint {
  return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & mask64;
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  let x = 0n;
  for (let i = 0; i < 8; i++) x |= BigInt(bytes[offset + i]!) << BigInt(8 * i);
  return x;
}

function round(acc: bigint, input: bigint): bigint {
  acc = (acc + input * prime2) & mask64;
  acc = rotl(acc, 31);
  return (acc * prime1) & mask64;
}

// XXH64 with seed 0, matching esbuild's internal/xxhash Digest.Sum64.
function xxh64(bytes: Uint8Array): bigint {
  const len = bytes.length;
  let hash: bigint;
  let offset = 0;
  if (len >= 32) {
    let v1 = (prime1 + prime2) & mask64;
    let v2 = prime2;
    let v3 = 0n;
    let v4 = (-prime1) & mask64;
    while (offset + 32 <= len) {
      v1 = round(v1, readU64(bytes, offset));
      v2 = round(v2, readU64(bytes, offset + 8));
      v3 = round(v3, readU64(bytes, offset + 16));
      v4 = round(v4, readU64(bytes, offset + 24));
      offset += 32;
    }
    hash = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) & mask64;
    const merge = (acc: bigint, val: bigint): bigint => {
      acc = (acc ^ round(0n, val)) & mask64;
      return (acc * prime1 + prime4) & mask64;
    };
    hash = merge(hash, v1);
    hash = merge(hash, v2);
    hash = merge(hash, v3);
    hash = merge(hash, v4);
  } else {
    hash = prime5;
  }
  hash = (hash + BigInt(len)) & mask64;
  while (offset + 8 <= len) {
    hash = (hash ^ round(0n, readU64(bytes, offset))) & mask64;
    hash = (rotl(hash, 27) * prime1 + prime4) & mask64;
    offset += 8;
  }
  if (offset + 4 <= len) {
    let u = 0n;
    for (let i = 0; i < 4; i++) u |= BigInt(bytes[offset + i]!) << BigInt(8 * i);
    hash = (hash ^ ((u * prime1) & mask64)) & mask64;
    hash = (rotl(hash, 23) * prime2 + prime3) & mask64;
    offset += 4;
  }
  while (offset < len) {
    hash = (hash ^ (BigInt(bytes[offset]!) * prime5)) & mask64;
    hash = (rotl(hash, 11) * prime1) & mask64;
    offset++;
  }
  hash = (hash ^ (hash >> 33n)) & mask64;
  hash = (hash * prime2) & mask64;
  hash = (hash ^ (hash >> 29n)) & mask64;
  hash = (hash * prime3) & mask64;
  hash = (hash ^ (hash >> 32n)) & mask64;
  return hash;
}

// First 8 characters of base32.StdEncoding.EncodeToString(big-endian XXH64).
export function assetContentHash(contents: Uint8Array): string {
  const hash = xxh64(contents);
  const bytes = new Uint8Array(hashBytes);
  for (let i = 0; i < hashBytes; i++) {
    bytes[i] = Number((hash >> BigInt(56 - 8 * i)) & 0xffn);
  }
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += base32Alphabet[(value >> bits) & 31];
      if (out.length === hashChars) return out;
    }
  }
  return out;
}

// "hero.2x.webp" -> name "hero.2x", extension ".webp". A leading dot or a
// missing extension is not a hashed asset name (same rule as splitAsset).
export function splitStaticName(filename: string): { name: string; ext: string } | undefined {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return undefined;
  return { name: filename.slice(0, dot), ext: filename.slice(dot) };
}

export function hashedAssetFilename(filename: string, contents: Uint8Array): string {
  const parts = splitStaticName(filename);
  if (!parts) {
    throw new Error(`static asset ${filename} needs an extension`);
  }
  return `${parts.name}-${assetContentHash(contents)}${parts.ext}`;
}

// An entry "home.tsx" is emitted as "home.js". "main.css" stays "main.css".
// A copied file with that same source name would be a second hashed match.
export function logicalBundleName(entryFilename: string): string {
  const parts = splitStaticName(entryFilename);
  if (!parts) return entryFilename;
  return parts.ext === ".css" ? `${parts.name}.css` : `${parts.name}.js`;
}

export function collidingAssetNames(
  assetNames: readonly string[],
  bundleNames: readonly string[],
): string[] {
  const bundles = new Set(bundleNames);
  return assetNames.filter((name) => bundles.has(name));
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

const bundleHash = /^[A-Z2-7]{8}$/;

// True for esbuild's "<entry>-<hash>.<ext>" and its ".map". Copied files
// use the same shape, so the entry's logical output name ("home.js") is
// what keeps the bundle from being deleted on an asset-only rebuild.
export function isBundleOutput(filename: string, bundleNames: readonly string[]): boolean {
  for (const bundle of bundleNames) {
    const parts = splitStaticName(bundle);
    if (!parts) continue;
    const prefix = `${parts.name}-`;
    if (!filename.startsWith(prefix)) continue;
    const suffixes = [parts.ext, `${parts.ext}.map`];
    for (const suffix of suffixes) {
      if (!filename.endsWith(suffix) || filename.length <= prefix.length + suffix.length) continue;
      const hash = filename.slice(prefix.length, filename.length - suffix.length);
      if (bundleHash.test(hash)) return true;
    }
  }
  return false;
}

// Removes previous copies, including a copied .js/.css that is not a bundle
// and a file whose source asset was deleted. Dotfiles and the current
// esbuild outputs stay.
export async function cleanCopiedAssets(
  distDir: string,
  bundleNames: readonly string[] = [],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(distDir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) return;
      if (entry.name.startsWith(".")) return;
      if (isBundleOutput(entry.name, bundleNames)) return;
      await rm(join(distDir, entry.name));
    }),
  );
}

// Top-level files that will be copied. Nested directories are skipped:
// /static/ does not serve nested paths. Dotfiles are skipped. A missing
// directory copies nothing.
export async function listStaticAssets(sourceDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  return entries
    .filter((entry) => {
      if (entry.name.startsWith(".")) return false;
      if (!entry.isFile()) {
        if (entry.isDirectory()) {
          console.warn(
            `skipping ${join(sourceDir, entry.name)}/: static assets are copied from the top of the directory`,
          );
        }
        return false;
      }
      if (!splitStaticName(entry.name)) {
        console.warn(`skipping ${join(sourceDir, entry.name)}: static assets need an extension`);
        return false;
      }
      return true;
    })
    .map((entry) => entry.name)
    .sort();
}

// bundleNames are logical outputs ("home.js"). A copied file with that
// source name would be a second hashed match for {{asset}}.
export function assertNoAssetCollision(assetNames: readonly string[], bundleNames: readonly string[]): void {
  const collisions = collidingAssetNames(assetNames, bundleNames);
  if (collisions.length === 0) return;
  throw new Error(
    `static asset ${collisions.map((name) => JSON.stringify(name)).join(", ")} uses the same name as an esbuild bundle`,
  );
}

export async function writeStaticAssets(
  sourceDir: string,
  distDir: string,
  files: readonly string[],
): Promise<string[]> {
  await mkdir(distDir, { recursive: true });
  const written: string[] = [];
  for (const filename of files) {
    const contents = await readFile(join(sourceDir, filename));
    const outName = hashedAssetFilename(filename, contents);
    await writeFile(join(distDir, outName), contents);
    written.push(outName);
  }
  return written;
}

// Copies each listed file to dist/<name>-<hash>.<ext>. Does not delete
// previous outputs; call cleanCopiedAssets first when the set can shrink.
export async function copyStaticAssets(
  sourceDir: string,
  distDir: string,
  bundleNames: readonly string[] = [],
): Promise<string[]> {
  const files = await listStaticAssets(sourceDir);
  assertNoAssetCollision(files, bundleNames);
  return writeStaticAssets(sourceDir, distDir, files);
}
