import type { ResearchViewerOptions } from "@gamebot/core";

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
    document.getElementById('game-score').textContent='Tick '+state.tick+' · Food '+state.foodEaten+(state.alive?(state.running?' · Running':state.food?' · Ready':' · Won'):' · Collision');
  }
  const closeButton=document.createElement('button');closeButton.textContent='Close game';
  closeButton.style.cssText='padding:8px 12px;border:1px solid #536b7d;border-radius:6px;cursor:pointer';
  document.querySelector('header').append(closeButton);
  closeButton.onclick=async()=>{stream.close();closeButton.disabled=true;await fetch('/close',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});document.getElementById('game-score').textContent='Game closed';document.getElementById('connection').textContent='Closed';};
  document.addEventListener('keydown',event=>{
    const action={ArrowUp:'up',ArrowRight:'right',ArrowDown:'down',ArrowLeft:'left'}[event.key];
    if(!action)return;event.preventDefault();
    void fetch('/input',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});
  });`,
};
