// Asset entries for esbuild's copy loader. JS, TSX, and CSS stay on the
// normal bundle path. A file in src/assets is not parsed: onLoad returns
// its bytes with loader "copy", and entryNames "[name]-[hash]" names the
// output. Unknown extensions have no default loader, so the bytes have to
// be returned from the plugin or esbuild rejects the entry.

import { readdir, readFile, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Plugin } from "esbuild";

export function splitStaticName(filename: string): { name: string; ext: string } | undefined {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return undefined;
  return { name: filename.slice(0, dot), ext: filename.slice(dot) };
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

export function assertNoAssetCollision(assetNames: readonly string[], bundleNames: readonly string[]): void {
  const collisions = collidingAssetNames(assetNames, bundleNames);
  if (collisions.length === 0) return;
  throw new Error(
    `static asset ${collisions.map((name) => JSON.stringify(name)).join(", ")} uses the same name as an esbuild bundle`,
  );
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

// Top-level files esbuild will copy. Nested directories are skipped because
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

// Deletes previous outputs so a changed asset does not leave the old hash
// behind. Dotfiles such as .gitkeep stay.
export async function cleanOutput(distDir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(distDir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || entry.name.startsWith(".")) return;
      await rm(join(distDir, entry.name));
    }),
  );
}

export function staticAssetPlugin(options: {
  distDir: string;
  assetPaths: readonly string[];
  bundleNames: readonly string[];
}): Plugin {
  const wanted = new Set(options.assetPaths.map((file) => resolve(file)));
  const names = options.assetPaths.map((file) => basename(file));
  return {
    name: "static-assets",
    setup(build) {
      build.onStart(async () => {
        assertNoAssetCollision(names, options.bundleNames);
        await cleanOutput(options.distDir);
      });
      // Unknown extensions have no default loader. Returning the bytes with
      // loader "copy" is what makes esbuild emit <name>-<hash>.<ext>.
      build.onLoad({ filter: /.*/ }, async (args) => {
        if (!wanted.has(args.path)) return undefined;
        return {
          contents: await readFile(args.path),
          loader: "copy",
          watchFiles: [args.path],
        };
      });
      build.onEnd((result) => {
        for (const [file, output] of Object.entries(result.metafile?.outputs ?? {})) {
          if (file.endsWith(".map")) continue;
          const entry = output.entryPoint ? resolve(output.entryPoint) : "";
          console.log(wanted.has(entry) ? "copied" : "built", file);
        }
      });
    },
  };
}
