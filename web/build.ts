// Bundles every entry in src/entries into dist/<name>-<hash>.<ext>.
// JS and TSX entries are self-contained IIFEs. CSS entries are compiled by
// the official Tailwind PostCSS plugin, then emitted by esbuild with the
// same hashed name. Files in src/assets are esbuild entries too, with the
// copy loader: no parse and no bundle, same entryNames pattern. Go serves
// both and resolves the hash from the source name.
//
//   bun run build.ts           production build (minified)
//   bun run build.ts --watch   rebuild on change

import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import * as esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { listStaticAssets, logicalBundleName, staticAssetPlugin } from "./static-assets.ts";

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
