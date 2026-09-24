import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import type { LearningEvent } from "./models.js";

export interface ResearchViewerOptions {
  title: string;
  /** Trusted bridge code defining renderGame(state), which draws into #board and #game-score. */
  render: string;
}

type ViewerDetail = {
  event?: ViewerDetail; state?: unknown; after?: unknown; finalState?: unknown;
  strategy?: string; instruction?: string; policy?: { strategy: string };
  role?: string; set?: string; seed?: number; policyId?: string; step?: number; steps?: number;
  reason?: string; progress?: number; nextReviewIn?: number; retained?: boolean; action?: unknown; error?: string; stopReason?: string; round?: number; accepted?: boolean; message?: string;
};

/** Open the existing default browser; never install or download a browser. */
export function openGameWindow(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const child = spawn(command, process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url],
    { stdio: "ignore", detached: true });
  const unavailable = () => console.log(`Open ${url} in your browser to watch.`);
  child.once("error", unavailable);
  child.once("exit", code => { if (code) unavailable(); });
  child.unref();
}

export async function startResearchViewer(options: ResearchViewerOptions) {
  const title = options.title.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>GameBot · ${title}</title>
<style>
:root{color-scheme:light;font-family:system-ui,sans-serif;color:#253a4b;background:#eff3f5}
*{box-sizing:border-box}body{margin:0}main{max-width:1080px;margin:auto;padding:32px}
header{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:24px}
h1{font:600 42px Georgia,serif;margin:0}header p{margin:0;color:#346e61}
.layout{display:grid;grid-template-columns:minmax(0,540px) minmax(0,1fr);gap:40px}
#board{display:grid;aspect-ratio:1;gap:10px;padding:10px;border-radius:12px;background:#b9c5ce}
.tile{display:grid;place-items:center;min-width:0;border-radius:6px;font-weight:750;font-size:clamp(22px,5vw,48px);background:#d6dfe5}
#game-score{font:600 15px ui-monospace,monospace;margin:16px 0}
aside{min-width:0}h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#536b7d;margin:24px 0 8px}
h2:first-child{margin-top:0}#phase{font-weight:650;font-size:20px;margin:0}
#strategy,#tactic{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55;margin:0;max-height:190px;overflow:auto}
#meta,#action{font:13px/1.8 ui-monospace,monospace;overflow-wrap:anywhere}
#history{padding-left:20px;font-size:13px;line-height:1.8}footer{color:#536b7d;font-size:13px;margin-top:28px}
@media(max-width:720px){main{padding:20px}.layout{grid-template-columns:1fr;gap:24px}h1{font-size:34px}header{align-items:center}}
</style></head><body><main>
<header><h1>${title}</h1><p id="connection">Connecting…</p></header>
<div class="layout"><section aria-label="Live game"><div id="board" role="img" aria-label="Waiting for the first board"></div><p id="game-score">Preparing the game…</p></section>
<aside><h2>GameBot</h2><p id="phase" role="status">Starting research</p><p id="meta"></p>
<h2>Strategy</h2><p id="strategy">Waiting for the strategist…</p>
<h2>Current tactic</h2><p id="tactic">Waiting for the tactician…</p>
<h2>Last move</h2><p id="action">No moves yet</p>
<h2>Recent attempts</h2><ol id="history"></ol></aside></div>
<footer>Live learning · Reviews keep the current world open. Ctrl+C in the terminal stops the run.</footer>
</main><script>
${options.render}
const stream=new EventSource('/events');
stream.onopen=()=>{document.getElementById('connection').textContent='Live';};
stream.onerror=()=>{document.getElementById('connection').textContent='Disconnected';};
stream.onmessage=({data})=>{
 const view=JSON.parse(data), set=(id,text)=>{document.getElementById(id).textContent=text;};
 if(view.state)renderGame(view.state);
 set('phase',view.phase);set('meta',view.meta||'');set('strategy',view.strategy||'Waiting for the strategist…');
 set('tactic',view.tactic||'Waiting for the tactician…');set('action',view.action||'No moves yet');
 const history=document.getElementById('history');history.replaceChildren();
 for(const result of view.history){const row=document.createElement('li');row.textContent=result;history.append(row);}
};
</script></body></html>`;
  const clients = new Set<ServerResponse>();
  const view = { phase: "Starting research", meta: "", strategy: "", tactic: "", action: "",
    state: undefined as unknown, history: [] as string[] };
  let episodes = 0;
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
    } else if (request.url === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      clients.add(response);
      response.write(`data: ${JSON.stringify(view)}\n\n`);
      request.on("close", () => clients.delete(response));
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Research viewer did not bind a local port");
  const broadcast = () => {
    const message = `data: ${JSON.stringify(view)}\n\n`;
    for (const client of clients) client.write(message);
  };
  return {
    url: `http://127.0.0.1:${address.port}/`,
    report(event: LearningEvent) {
      const envelope = event.detail as ViewerDetail;
      const detail = envelope.event ?? envelope;
      switch (event.type) {
        case "research.setup": view.state = detail.state; view.phase = "Planning the first attempt"; break;
        case "episode.started":
          episodes++;
          view.state = detail.state; view.action = "No moves yet"; view.strategy = detail.strategy ?? ""; view.tactic = "";
          view.phase = "Playing";
          view.meta = envelope.set === undefined ? `Game ${episodes} · Continual learning` : `Attempt ${episodes} · ${envelope.set === "test" ? "Final evaluation" : envelope.set === "validation" ? "Validation" : "Training"} · seed ${envelope.seed}`;
          break;
        case "episode.step": view.state = detail.after; view.phase = "Playing"; view.action = `Move ${detail.step}: ${JSON.stringify(detail.action)}`; break;
        case "model.started": view.phase = `${detail.role === "reflex" ? "Choosing a move" : detail.role === "strategist" ? "Strategist is planning" : "Tactician is planning"}…`; break;
        case "player.initialized": view.strategy = detail.policy?.strategy ?? ""; break;
        case "strategy.updated": view.strategy = detail.strategy ?? ""; break;
        case "tactic.updated": view.tactic = detail.instruction ?? ""; break;
        case "episode.completed":
          view.state = detail.finalState; view.phase = detail.error ? `Attempt failed: ${detail.error}` : `Attempt finished: ${detail.stopReason}`;
          view.history = [`Attempt ${episodes}: ${detail.stopReason} · ${detail.steps} moves`, ...view.history].slice(0, 6);
          break;
        case "learning.window":
          view.state = detail.after; view.phase = `Reviewing: ${detail.reason}`;
          view.history = [`${detail.reason}: ${detail.steps} moves · progress ${detail.progress}`, ...view.history].slice(0, 6); break;
        case "learning.proposal": view.phase = "Checking a proposed revision"; break;
        case "learning.policy-activated": view.phase = "Trying a revised player in this world"; break;
        case "learning.trial-reviewed": view.phase = detail.retained ? "Retaining the live trial" : "Restoring the previous player"; break;
        case "learning.reviewed": view.phase = "Playing"; view.meta = `Next learning review in up to ${detail.nextReviewIn} decisions`; break;
        case "learning.saved": view.phase = "Learning saved"; break;
        case "research.proposal": view.phase = `Testing revision ${detail.round}`; break;
        case "research.revision": view.phase = detail.accepted ? "Improved policy accepted" : "Keeping the previous policy"; break;
        case "research.completed": view.phase = "Research complete"; break;
        case "research.error": view.phase = `Research stopped: ${detail.message}`; break;
        default: return;
      }
      broadcast();
    },
    close: () => new Promise<void>(resolve => {
      for (const client of clients) client.end();
      server.close(() => resolve());
    }),
  };
}
