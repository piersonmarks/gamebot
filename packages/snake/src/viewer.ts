import { createServer, type ServerResponse } from "node:http";
import type { ResearchViewerOptions } from "@gamebot/core";
import type { SnakeState } from "./game.js";

export const researchViewSnake: ResearchViewerOptions = {
  title: "Snake",
  render: `function renderGame(state) {
    const board=document.getElementById('board'), head=state.body[0];
    board.style.gridTemplateColumns='repeat('+state.width+',minmax(0,1fr))';
    board.style.gridTemplateRows='repeat('+state.height+',minmax(0,1fr))';board.replaceChildren();
    for(let y=0;y<state.height;y++)for(let x=0;x<state.width;x++){
      const cell=document.createElement('div');cell.className='cell tile';
      if(head.x===x&&head.y===y)cell.style.background='#346e61';
      else if(state.body.slice(1).some(p=>p.x===x&&p.y===y))cell.style.background='#75a58b';
      else if(state.food?.x===x&&state.food.y===y)cell.style.background='#bc5735';
      board.append(cell);
    }
    board.setAttribute('aria-label','Snake board: '+state.board);
    document.getElementById('game-score').textContent='Tick '+state.tick+' · Food '+state.foodEaten+(state.alive?'':' · Collision');
  }`,
};

const page = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gamebot Snake</title>
<style>
  body{background:#111827;color:#f9fafb;font:16px system-ui;margin:0;min-height:100vh;display:grid;place-items:center}
  main{text-align:center}h1{font-size:1.4rem}#board{display:grid;gap:3px;margin:1rem auto;width:max-content}
  .cell{width:36px;height:36px;border-radius:5px;background:#374151}.head{background:#a3e635}
  .body{background:#65a30d}.food{background:#fb7185}#game-score{color:#d1d5db}
</style>
<main><h1>Gamebot Snake</h1><p id="game-score">Waiting for game…</p><div id="board" aria-label="Snake board"></div></main>
<script>
  ${researchViewSnake.render}
  new EventSource('/events').onmessage=({data})=>renderGame(JSON.parse(data));
</script></html>`;

export async function startViewer() {
  const clients = new Set<ServerResponse>();
  let latest: SnakeState | undefined;
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page);
    } else if (request.url === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      clients.add(response);
      if (latest) response.write(`data: ${JSON.stringify(latest)}\n\n`);
      request.on("close", () => clients.delete(response));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Viewer did not bind to a local port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    publish(state: SnakeState) {
      latest = state;
      for (const client of clients) client.write(`data: ${JSON.stringify(state)}\n\n`);
    },
    close: () => new Promise<void>(resolve => {
      for (const client of clients) client.end();
      server.close(() => resolve());
    }),
  };
}
