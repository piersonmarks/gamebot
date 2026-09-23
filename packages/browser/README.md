# @gamebot/browser

Generic Gamebot bridge for separately hosted HTML5 games. The host supplies a [Playwright](https://playwright.dev/docs/intro) `Page` opened in a visible browser; Gamebot reads a game-specific observation and sends keyboard or mouse actions to that same page. The game, its URL, and its rules are not bundled here. Screenshot capture is off by default.

```ts
import { chromium } from "playwright";
import { BrowserGameBridge } from "@gamebot/browser";

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
await page.goto("https://your-game.example");
const bridge = new BrowserGameBridge(page, { textSelector: "#game-status" });
const observation = await bridge.observe();
// Supply game-specific candidate directions and a verifier to SessionRuntime.
// The visible page is both the game and the spectator window.
await browser.close();
```

For DOM games, set `textSelector` to a useful status region and use selector-based click candidates. If a game exposes trustworthy structured state, pass `extractState: () => page.evaluate(...)` from its game-specific runner. For canvas games without readable state, set `captureScreenshot: true` to receive PNGs and use bounded key or coordinate-click candidates. At least one observation source is required. A key action can use `holdMs` up to 2000 for real-time games. The bridge checks that a fresh observation is still on the original origin and that candidate input is structurally valid; game-specific legality and success remain the bridge runner's responsibility.

For games whose pixels are more useful than their DOM, `aiSdkVisionExtractor` from `@gamebot/core` accepts a PNG, a game-specific prompt and schema, and an AI SDK model. A runner can pass `extractState: () => extract(await page.screenshot({ type: "png" }))` without changing this browser bridge. [`@gamebot/2048`](../2048) uses that path with `--observe=vision`; its default mode reads the site's structured state.

The core AI SDK reflex can receive multimodal messages. When `captureScreenshot: true` is configured, a canvas game's `render` callback can supply the observed screenshot as an image part alongside the offered candidate IDs:

```ts
render(context, candidates) {
  return [{ role: "user", content: [
    { type: "text", text: JSON.stringify(candidates.map(({ id, description }) => ({ id, description }))) },
    { type: "file", mediaType: "image/png", data: context.observation.state.screenshot! },
  ] }];
}
```

Use a model that accepts image input. A game-specific runner still decides when to step, which actions to offer, how to verify progress, and whether to use DOM state, screenshots, or both. Playwright and the browser executable belong to the host application, not `@gamebot/core` or this package.
