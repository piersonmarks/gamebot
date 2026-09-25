import { createServer, type ServerResponse } from "node:http";
import type { Direction, SnakeState } from "./rules.js";

export interface SnakePresentation {
  phase?: string;
  strategy?: string;
  tactic?: string;
  action?: string;
}

/** The game's own window; observers can annotate it but cannot supply its board. */
export async function startSnakeViewer(options: {
  observe(): Promise<{ state: SnakeState; revision: string }>;
  input(action: Direction): Promise<void>;
  close(): Promise<void>;
}) {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Snake</title>
<style>
:root{font-family:system-ui,sans-serif;color:#253a4b;background:#eff3f5}*{box-sizing:border-box}body{margin:0}main{max-width:1040px;margin:auto;padding:32px}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}h1{font:600 42px Georgia,serif;margin:0}
button{padding:8px 12px;border:1px solid #536b7d;border-radius:6px;cursor:pointer;background:white;color:inherit}
.layout{display:grid;grid-template-columns:minmax(0,540px) minmax(0,1fr);gap:40px}#board{display:grid;aspect-ratio:1;gap:10px;padding:10px;border-radius:12px;background:#b9c5ce}
.cell{min-width:0;border-radius:6px;background:#d6dfe5}#score{font:600 15px ui-monospace,monospace;margin:16px 0}aside{min-width:0}h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#536b7d;margin:24px 0 8px}h2:first-child{margin-top:0}
#phase{font-weight:650;font-size:20px}#strategy,#tactic{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55;max-height:190px;overflow:auto}#action{font:13px/1.8 ui-monospace,monospace;overflow-wrap:anywhere}footer{color:#536b7d;font-size:13px;margin-top:28px}
@media(max-width:720px){main{padding:20px}.layout{grid-template-columns:1fr;gap:24px}h1{font-size:34px}}
</style></head><body><main><header><h1>Snake</h1><button id="close">Close game</button></header>
<div class="layout"><section aria-label="Live game"><div id="board" role="img" aria-label="Waiting for Snake"></div><p id="score">Connecting…</p></section>
<aside><h2>Controller</h2><p id="phase">Play with the arrow keys</p><h2>Strategy</h2><p id="strategy"></p><h2>Current tactic</h2><p id="tactic"></p><h2>Last move</h2><p id="action"></p></aside></div>
<footer>Snake advances on its own clock after the first direction input. Arrow keys control the game.</footer></main>
<script>
const stream=new EventSource('/events');
const set=(id,value)=>{if(value!==undefined)document.getElementById(id).textContent=value};
stream.onmessage=({data})=>{const view=JSON.parse(data),state=view.state;if(state){
 const board=document.getElementById('board'),head=state.body[0];board.style.gridTemplateColumns='repeat('+state.width+',minmax(0,1fr))';board.style.gridTemplateRows='repeat('+state.height+',minmax(0,1fr))';board.replaceChildren();
 for(let y=0;y<state.height;y++)for(let x=0;x<state.width;x++){const cell=document.createElement('div');cell.className='cell';if(head.x===x&&head.y===y)cell.style.background='#346e61';else if(state.body.slice(1).some(p=>p.x===x&&p.y===y))cell.style.background='#75a58b';else if(state.food?.x===x&&state.food.y===y)cell.style.background='#bc5735';board.append(cell)}
 board.setAttribute('aria-label','Snake board: '+state.board);set('score','Tick '+state.tick+' · Food '+state.foodEaten+(state.alive?(state.running?' · Running':state.food?' · Ready':' · Won'):' · Collision'))}
 for(const key of ['phase','strategy','tactic','action'])set(key,view.presentation[key])};
document.addEventListener('keydown',event=>{const action={ArrowUp:'up',ArrowRight:'right',ArrowDown:'down',ArrowLeft:'left'}[event.key];if(!action)return;event.preventDefault();void fetch('/input',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})})});
document.getElementById('close').onclick=async()=>{stream.close();await fetch('/close',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});set('score','Game closed');set('phase','Closed')};
</script></body></html>`;
  const clients = new Set<ServerResponse>();
  let state: SnakeState | undefined;
  let presentation: SnakePresentation = { phase: "Play with the arrow keys" };
  const broadcast = () => { const data = `data: ${JSON.stringify({ state, presentation })}\n\n`; for (const client of clients) client.write(data); };
  const server = createServer((request, response) => {
    if (request.url === "/" && request.method === "GET") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page); return; }
    if (request.url === "/events" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      clients.add(response); response.write(`data: ${JSON.stringify({ state, presentation })}\n\n`);
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
      if (request.url === "/input") {
        let body = "";
        for await (const chunk of request) { body += chunk; if (body.length > 1024) throw new Error("Input is too large"); }
        await options.input(JSON.parse(body).action);
        response.writeHead(200).end(); return;
      }
      response.writeHead(404).end();
    })().catch(error => { if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: String(error) })); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Snake viewer did not bind a local port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    publish(next: SnakeState) { state = next; broadcast(); },
    present(next: SnakePresentation) { presentation = { ...presentation, ...next }; broadcast(); },
    close: () => new Promise<void>(resolve => { for (const client of clients) client.end(); server.close(() => resolve()); }),
  };
}
