// Bundles every entry in src/entries into dist/<name>-<hash>.<ext>.
// JS and TSX entries are self-contained IIFEs. CSS entries are compiled by
// the official Tailwind PostCSS plugin, then emitted by esbuild with the
// same hashed name. Files in src/assets are esbuild entries too, with the
// copy loader: no parse and no bundle, same entryNames pattern. Go serves
// both and resolves the hash from the source name.
//
//   bun run build.ts           production build (minified)
//   bun run build.ts --watch   rebuild on change

import { readdir, readFile, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import * as esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

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

// Unknown extensions have no default loader. Returning the bytes with
// loader "copy" is what makes esbuild emit <name>-<hash>.<ext>.
export function staticAssetPlugin(options: {
  distDir: string;
  assetPaths: readonly string[];
  bundleNames: readonly string[];
}): esbuild.Plugin {
  const wanted = new Set(options.assetPaths.map((file) => resolve(file)));
  const names = options.assetPaths.map((file) => basename(file));
  return {
    name: "static-assets",
    setup(build) {
      build.onStart(async () => {
        assertNoAssetCollision(names, options.bundleNames);
        await cleanOutput(options.distDir);
      });
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

async function run(): Promise<void> {
  const watch = process.argv.includes("--watch");
  const entryDir = "src/entries";
  const assetDir = "src/assets";
  const distDir = "dist";

  const entrypoints = (await readdir(entryDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(ts|tsx|css)$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => join(entryDir, name));

  if (entrypoints.length === 0) {
    console.error(`no entries found in ${entryDir}`);
    process.exit(1);
  }

  const assetNames = await listStaticAssets(assetDir);
  const assetPaths = assetNames.map((name) => join(assetDir, name));
  const bundleNames = entrypoints.map((entry) => logicalBundleName(basename(entry)));

  const tailwind = postcss([
    tailwindcss({ optimize: watch ? false : { minify: true } }),
  ]);

  const tailwindPlugin: esbuild.Plugin = {
    name: "tailwind",
    setup(build) {
      build.onLoad({ filter: /\.css$/ }, async (args) => {
        const source = await readFile(args.path, "utf8");
        const result = await tailwind.process(source, { from: args.path });
        const watchFiles = [args.path];
        for (const message of result.messages) {
          if (message.type === "dependency" && message.file) watchFiles.push(message.file);
        }
        return { contents: result.css, loader: "css", watchFiles };
      });
    },
  };

  const options: esbuild.BuildOptions = {
    entryPoints: [...entrypoints, ...assetPaths],
    outdir: distDir,
    entryNames: "[name]-[hash]",
    bundle: true,
    format: "iife",
    target: "es2020",
    platform: "browser",
    jsx: "automatic",
    jsxImportSource: "preact",
    minify: !watch,
    sourcemap: watch ? "inline" : false,
    metafile: true,
    plugins: [staticAssetPlugin({ distDir, assetPaths, bundleNames }), tailwindPlugin],
    logLevel: "info",
  };

  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("watching");
    await new Promise(() => {});
  } else {
    await esbuild.build(options);
  }
}

if (import.meta.main) {
  await run();
}
