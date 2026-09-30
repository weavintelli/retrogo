// Bundles every entry in src/entries into dist/<name>-<hash>.<ext>.
// JS and TSX entries are self-contained IIFEs. CSS entries are compiled by
// the official Tailwind PostCSS plugin, then emitted by esbuild with the
// same hashed name. Files in src/assets (images, .asc, anything that is not
// an esbuild entry) are copied, not bundled, to that same
// <name>-<hash>.<ext> shape. Go serves both and resolves the hash from the
// source name.
//
//   bun run build.ts           production build (minified)
//   bun run build.ts --watch   rebuild on change

import { watch as watchDir } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import * as esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import {
  assertNoAssetCollision,
  cleanCopiedAssets,
  listStaticAssets,
  logicalBundleName,
  writeStaticAssets,
} from "./static-assets.ts";

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
    build.onEnd((result) => {
      for (const file of Object.keys(result.metafile?.outputs ?? {})) {
        if (file.endsWith(".map")) continue;
        console.log("built", file);
      }
    });
  },
};

async function cleanDist(): Promise<void> {
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
      if (entry.name === ".gitkeep") return;
      if (/\.(js|css|map)$/.test(entry.name)) await rm(join(distDir, entry.name));
    }),
  );
}

const bundleNames = entrypoints.map((entry) => logicalBundleName(basename(entry)));

// One chain so an esbuild rebuild and an asset-directory change cannot copy
// over each other. A failed production build still rejects.
let assetChain: Promise<void> = Promise.resolve();

function enqueueAssets(task: () => Promise<void>): Promise<void> {
  const run = assetChain.then(task);
  assetChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

// Refuse a colliding name before deleting dist, so a bad asset does not
// wipe the bundles already on disk.
async function currentAssetNames(): Promise<string[]> {
  const files = await listStaticAssets(assetDir);
  assertNoAssetCollision(files, bundleNames);
  return files;
}

async function publishAssets(files: readonly string[]): Promise<void> {
  await cleanCopiedAssets(distDir, bundleNames);
  const copied = await writeStaticAssets(assetDir, distDir, files);
  for (const name of copied) console.log("copied", join(distDir, name));
}

const staticAssetPlugin: esbuild.Plugin = {
  name: "static-assets",
  setup(build) {
    build.onStart(async () => {
      await enqueueAssets(async () => {
        const files = await currentAssetNames();
        await cleanDist();
        await publishAssets(files);
      });
    });
  },
};

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

const options: esbuild.BuildOptions = {
  entryPoints: entrypoints,
  outdir: "dist",
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
  plugins: [staticAssetPlugin, tailwindPlugin],
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  // Entry changes rebuild through esbuild, which recopies assets in onStart.
  // Asset-only edits do not invalidate a bundle, so watch that directory too.
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    watchDir(assetDir, () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        void enqueueAssets(async () => {
          const files = await currentAssetNames();
          await publishAssets(files);
        }).catch((err: unknown) => {
          console.error(err);
        });
      }, 50);
    });
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  console.log("watching");
  await new Promise(() => {});
} else {
  await esbuild.build(options);
}
