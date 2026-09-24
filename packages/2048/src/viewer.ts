import type { ResearchViewerOptions } from "@gamebot/core";

/** Display the exact simulation state used for research, with no separate game or model calls. */
export const researchView2048: ResearchViewerOptions = {
  title: "2048",
  render: `function renderGame(state) {
    const board=document.getElementById('board');
    board.style.gridTemplateColumns='repeat(4,minmax(0,1fr))';board.style.gridTemplateRows='repeat(4,minmax(0,1fr))';board.replaceChildren();
    const colors={2:'#e9e3d9',4:'#e6d9be',8:'#edbc83',16:'#e79e70',32:'#d97b59',64:'#bc5735',128:'#debc56',256:'#d5ad36',512:'#c39a28',1024:'#ae861a',2048:'#94710e'};
    for(const row of state.board)for(const value of row){
      const tile=document.createElement('div');tile.className='tile';tile.textContent=value||'';
      if(value){tile.style.background=colors[value]||'#253a4b';tile.style.color=value>=32?'#fff':'#253a4b';}
      if(value>=1024)tile.style.fontSize='clamp(18px,4vw,36px)';board.append(tile);
    }
    board.setAttribute('aria-label','2048 board: '+state.board.map(row=>row.join(', ')).join('; '));
    document.getElementById('game-score').textContent='Score '+state.score+' · Largest tile '+Math.max(...state.board.flat())+(state.over?' · Game over':state.won?' · Won':'');
  }`,
};
