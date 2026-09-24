#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installed = join(root, "node_modules", "@gamebot");
const games = new Map();
for (const id of await readdir(installed)) {
  const directory = join(installed, id);
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (manifest.gamebot?.playable && manifest.name === `@gamebot/${id}`) {
    const bin = typeof manifest.bin === "string" ? manifest.bin : Object.values(manifest.bin ?? {})[0];
    if (typeof bin === "string") games.set(id, { directory, manifest, bin, researchBin: manifest.gamebot.researchBin, defaultArgs: manifest.gamebot.defaultArgs ?? [] });
  }
}

const args = process.argv.slice(2);
const autoplay = args.includes("--autoplay");
const gameArg = args.find(arg => arg.startsWith("--game="));
const gameIndex = args.indexOf("--game");
const id = gameArg?.slice(7) ?? (gameIndex >= 0 ? args[gameIndex + 1] : undefined);
if (!id || args.includes("--help") || args.includes("--list")) {
  console.log(`Usage: npm run ${autoplay ? "autoplay" : "game"} -- --game=<id> [options]\nAvailable games: ${[...games.keys()].join(", ")}`);
} else {
  const game = games.get(id);
  if (!game) {
    console.error(`Unknown or uninstalled game '${id}'. Available games: ${[...games.keys()].join(", ")}`);
    process.exitCode = 1;
  } else {
    if (autoplay && typeof game.researchBin !== "string") {
      console.error(`Game '${id}' does not provide an auto-research runner.`);
      process.exitCode = 1;
      process.exit();
    }
    const options = args.filter((arg, index) =>
      !(gameIndex >= 0 && (index === gameIndex || index === gameIndex + 1)) && !arg.startsWith("--game=") && arg !== "--autoplay");
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error("Run this launcher with npm run game -- --game=<id>");
    const run = (command, commandArgs, cwd) => new Promise((resolveRun, reject) => {
      const child = spawn(command, commandArgs, { cwd, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveRun(code ?? (signal === "SIGINT" ? 130 : 1)));
    });
    const workspaceRoot = await realpath(join(root, "packages"));
    const built = new Set();
    const buildWorkspace = async (directory, manifest) => {
      const path = relative(workspaceRoot, await realpath(directory));
      if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path) || built.has(manifest.name)) return 0;
      built.add(manifest.name);
      const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.devDependencies };
      for (const name of Object.keys(dependencies).filter(name => name.startsWith("@gamebot/") && name !== "@gamebot/core")) {
        const dependency = join(installed, name.slice("@gamebot/".length));
        const dependencyManifest = JSON.parse(await readFile(join(dependency, "package.json"), "utf8"));
        const code = await buildWorkspace(dependency, dependencyManifest);
        if (code !== 0) return code;
      }
      return manifest.scripts?.build ? run(process.execPath, [npm, "run", "build", "-w", manifest.name], root) : 0;
    };
    const coreCode = await run(process.execPath, [npm, "run", "build:core"], root);
    const buildCode = coreCode || await buildWorkspace(game.directory, game.manifest);
    if (buildCode !== 0) process.exitCode = buildCode;
    else {
      const dataDirectory = join(root, ".gamebot");
      const legacyDirectory = join(game.directory, ".gamebot");
      const imported = join(dataDirectory, `.imported-${id}`);
      // Preserve old package-local saves, without replacing root saves or changing cold-start shared state.
      if (!options.includes("--cold-start") && !options.some(arg => arg === "--resume" || arg.startsWith("--resume=")) && !existsSync(imported) && existsSync(legacyDirectory)) {
        await cp(legacyDirectory, dataDirectory, { recursive: true, force: false, errorOnExist: false });
        await writeFile(imported, `${await realpath(legacyDirectory)}\n`);
        console.log(`Imported missing saves from ${legacyDirectory}; originals are retained.`);
      }
      console.log(`GameBot data: ${dataDirectory}`);
      process.exitCode = await run(process.execPath, [resolve(game.directory, autoplay ? game.researchBin : game.bin), ...(autoplay ? [] : game.defaultArgs), ...options], root);
    }
  }
}
