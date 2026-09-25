import { createServer, type ServerResponse } from "node:http";
import type { Direction, PacmanState } from "./rules.js";

export interface PacmanPresentation {
  phase?: string;
  strategy?: string;
  tactic?: string;
  action?: string;
}

/** The game owns the page and its state; a controller may only add text annotations. */
export async function startPacmanViewer(options: {
  observe(): Promise<{ state: PacmanState; revision: string }>;
  input(action: Direction): Promise<void>;
  newGame(seed: number): Promise<string>;
  close(): Promise<void>;
}, allowReset = true) {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pac-Man Maze</title>
<style>
:root{font-family:system-ui,sans-serif;color:#edf0ff;background:#101328}*{box-sizing:border-box}body{margin:0}main{max-width:1050px;margin:auto;padding:24px}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}h1{font:600 40px Georgia,serif;color:#ffd654;margin:0}.buttons{display:flex;gap:8px}
button{padding:8px 12px;border:1px solid #6076c1;border-radius:6px;cursor:pointer;background:#1c2750;color:#fff}
.layout{display:grid;grid-template-columns:minmax(0,640px) minmax(0,1fr);gap:32px}#board{display:grid;aspect-ratio:1;gap:2px;padding:8px;border-radius:12px;background:#050718}
.cell{display:grid;place-items:center;min-width:0;min-height:0;border-radius:3px;background:#080c24}.wall{background:#304dc7}.pellet::after{content:'';width:16%;aspect-ratio:1;border-radius:50%;background:#fff0ba}.power::after{content:'';width:42%;aspect-ratio:1;border-radius:50%;background:#ffe081}.player::after{content:'';width:76%;aspect-ratio:1;border-radius:50%;background:#ffd635}.ghost::after{content:'';width:70%;height:70%;border-radius:50% 50% 25% 25%;background:#fa627a}.frightened::after{background:#68b4ff}
#score{font:600 14px ui-monospace,monospace;margin:12px 0}aside{min-width:0}h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#9bb0e9;margin:24px 0 8px}h2:first-child{margin-top:0}
#phase{font-weight:650;font-size:20px}#strategy,#tactic{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55;max-height:190px;overflow:auto}#action{font:13px/1.8 ui-monospace,monospace;overflow-wrap:anywhere}footer{color:#aab8e3;font-size:13px;margin-top:20px}
@media(max-width:740px){.layout{grid-template-columns:1fr;gap:16px}main{padding:14px}h1{font-size:30px}}
</style></head><body><main><header><h1>Pac-Man Maze</h1><div class="buttons"><button id="new">New game</button><button id="close">Close game</button></div></header>
<div class="layout"><section aria-label="Live game"><div id="board" role="img" aria-label="Waiting for Pac-Man"></div><p id="score">Connecting…</p></section>
<aside><h2>Controller</h2><p id="phase">Play with the arrow keys</p><h2>Strategy</h2><p id="strategy"></p><h2>Current tactic</h2><p id="tactic"></p><h2>Last move</h2><p id="action"></p></aside></div>
<footer>Arrow keys turn. Collect every pellet to win; power pellets let you eat ghosts briefly. The game clock continues while a controller thinks.</footer></main>
<script>
const stream=new EventSource('/events');
const set=(id,value)=>{if(value!==undefined)document.getElementById(id).textContent=value};
stream.onmessage=({data})=>{const view=JSON.parse(data),state=view.state;if(state){
 const board=document.getElementById('board'),rows=state.board.split('\\n');board.style.gridTemplateColumns='repeat('+state.width+',minmax(0,1fr))';board.style.gridTemplateRows='repeat('+state.height+',minmax(0,1fr))';board.replaceChildren();
 const classes={'#':'wall','.':'pellet','o':'power','P':'player','G':'ghost'};
 for(const row of rows)for(const symbol of row){const cell=document.createElement('div');cell.className='cell '+(classes[symbol]||'')+(symbol==='G'&&state.powerTicks?' frightened':'');board.append(cell)}
 board.setAttribute('aria-label',state.board);
 set('score','Score '+state.score+' · Lives '+state.lives+' · Pellets '+state.pelletsRemaining+' · Tick '+state.tick+(state.won?' · Won':state.over?' · Game over':state.powerTicks?' · Powered '+state.powerTicks:state.running?' · Running':' · Ready'))}
 document.getElementById('new').hidden=!view.allowReset;
 for(const key of ['phase','strategy','tactic','action'])set(key,view.presentation[key])};
document.addEventListener('keydown',event=>{const action={ArrowUp:'up',ArrowRight:'right',ArrowDown:'down',ArrowLeft:'left'}[event.key];if(!action)return;event.preventDefault();void fetch('/input',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})})});
document.getElementById('new').onclick=async()=>{await fetch('/new-game',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({seed:Math.floor(Math.random()*0x7fffffff)})})};
document.getElementById('close').onclick=async()=>{stream.close();await fetch('/close',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});set('score','Game closed');set('phase','Closed')};
</script></body></html>`;
  const clients = new Set<ServerResponse>();
  let state: PacmanState | undefined;
  let presentation: PacmanPresentation = { phase: "Play with the arrow keys" };
  let resetAllowed = allowReset;
  const broadcast = () => { const data = `data: ${JSON.stringify({ state, presentation, allowReset: resetAllowed })}\n\n`; for (const client of clients) client.write(data); };
  const server = createServer((request, response) => {
    if (request.url === "/" && request.method === "GET") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page); return; }
    if (request.url === "/events" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      clients.add(response); response.write(`data: ${JSON.stringify({ state, presentation, allowReset: resetAllowed })}\n\n`);
      request.on("close", () => clients.delete(response)); return;
    }
    void (async () => {
      if (request.url === "/state" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(await options.observe())); return;
      }
      if (request.method !== "POST" || request.headers["content-type"] !== "application/json" ||
          request.headers.origin && request.headers.origin !== `http://127.0.0.1:${(server.address() as {port:number}).port}`) {
        response.writeHead(403).end(); return;
      }
      if (request.url === "/close") { response.writeHead(200).end(); await options.close(); return; }
      if (request.url === "/input" || request.url === "/new-game") {
        if (request.url === "/new-game" && !resetAllowed) { response.writeHead(409).end("Controller owns this run"); return; }
        let body = "";
        for await (const chunk of request) { body += chunk; if (body.length > 1024) throw new Error("Input is too large"); }
        const data = JSON.parse(body);
        if (request.url === "/input") await options.input(data.action);
        else await options.newGame(data.seed);
        response.writeHead(200).end(); return;
      }
      response.writeHead(404).end();
    })().catch(error => { if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: String(error) })); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Pac-Man viewer did not bind a local port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    publish(next: PacmanState) { state = next; broadcast(); },
    present(next: PacmanPresentation) { presentation = { ...presentation, ...next }; broadcast(); },
    allowReset() { resetAllowed = true; broadcast(); },
    close: () => new Promise<void>(resolve => { for (const client of clients) client.end(); server.close(() => resolve()); }),
  };
}
