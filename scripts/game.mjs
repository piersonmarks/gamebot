#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installed = join(root, "node_modules", "@gamebot");
const games = new Map();
for (const id of await readdir(installed)) {
  const directory = join(installed, id);
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (manifest.gamebot?.playable && manifest.name === `@gamebot/${id}`) {
    const bin = typeof manifest.bin === "string" ? manifest.bin : Object.values(manifest.bin ?? {})[0];
    if (typeof bin === "string") games.set(id, { directory, bin, defaultArgs: manifest.gamebot.defaultArgs ?? [] });
  }
}

const args = process.argv.slice(2);
const gameArg = args.find(arg => arg.startsWith("--game="));
const gameIndex = args.indexOf("--game");
const id = gameArg?.slice(7) ?? (gameIndex >= 0 ? args[gameIndex + 1] : undefined);
if (!id || args.includes("--help") || args.includes("--list")) {
  console.log(`Usage: npm run game -- --game=<id> [game options]\nAvailable games: ${[...games.keys()].join(", ")}`);
} else {
  const game = games.get(id);
  if (!game) {
    console.error(`Unknown or uninstalled game '${id}'. Available games: ${[...games.keys()].join(", ")}`);
    process.exitCode = 1;
  } else {
    const options = args.filter((arg, index) =>
      !(gameIndex >= 0 && (index === gameIndex || index === gameIndex + 1)) && !arg.startsWith("--game="));
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error("Run this launcher with npm run game -- --game=<id>");
    const run = (command, commandArgs, cwd) => new Promise((resolveRun, reject) => {
      const child = spawn(command, commandArgs, { cwd, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveRun(code ?? (signal === "SIGINT" ? 130 : 1)));
    });
    const buildCode = await run(process.execPath, [npm, "run", "build"], root);
    if (buildCode !== 0) process.exitCode = buildCode;
    else process.exitCode = await run(process.execPath, [resolve(game.directory, game.bin), ...game.defaultArgs, ...options], game.directory);
  }
}
