const {addon}=require('./catalog-visibility');
const letters=Object.fromEntries(Array.from('абвгдеёжзийклмнопрстуфхцчшщъыьэюя').map((c,i)=>[c,'a b v g d e e zh z i y k l m n o p r s t u f h ts ch sh sch _ y _ e yu ya'.split(' ')[i].replace('_','')]));
function normalize(s){
  return String(s||'').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}
function sound(s){
  return s.replace(/[а-я]/g,c=>letters[c]||'').replace(/ead/g,'ed').replace(/(?:ption|psh[ei]n|sh[ei]n)/g,'shn').replace(/tion/g,'shn').replace(/ph/g,'f').replace(/ck/g,'k').replace(/(.)\1+/g,'$1');
}
function near(a,b,limit){
  if(Math.abs(a.length-b.length)>limit)return false;
  let prev=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){
    const row=[i];
    for(let j=1;j<=b.length;j++)row.push(Math.min(prev[j]+1,row[j-1]+1,prev[j-1]+Number(a[i-1]!==b[j-1])));
    if(Math.min(...row)>limit)return false;
    prev=row;
  }
  return prev[b.length]<=limit;
}
function rankedTitles(items,query,smartMatch){
  const q=normalize(query).slice(0,160);
  if(!q)return [];
  const queryWords=q.split(' ').map(sound);
  const words=new Map(), families=new Map(), linked=new Map();
  function titleScore(value){
    const title=normalize(value);
    if(!title)return 0;
    if(words.has(title))return words.get(title);
    let score=0;
    if(title===q)score=100;
    else if(title.includes(q))score=85;
    else if(smartMatch(title,q))score=75;
    else{
      const tokens=title.split(' ').map(sound);
      if(queryWords.every(w=>tokens.includes(w)))score=65;
      else if(queryWords.every(w=>tokens.some(t=>w===t||(w.length>=4 && near(w,t,w.length>=7?2:1)))))score=50;
    }
    if(score)score+=1/(1+Math.abs(title.length-q.length));
    words.set(title,score);return score;
  }
  for(const g of items){
    g._score=Math.max(titleScore(g.name),titleScore(g.names?.en),titleScore(g.names?.ru),titleScore([g.name,g.edition].filter(Boolean).join(' ')));
    if(!g._score || addon(g))continue;
    if(g.conceptId)families.set(String(g.conceptId),Math.max(g._score,families.get(String(g.conceptId))||0));
    for(const a of g.addons||g.psStore?.addons||[])linked.set(String(a.id),true);
  }
  for(const g of items.filter(addon)){
    const related=[g.conceptId,...(g.psParentConcepts||[])].some(id=>families.has(String(id))) || [g.id,...Object.values(g.productIds||{})].some(id=>linked.has(String(id)));
    g._score=g._score?g._score-1:related?20:0;
  }
  return items.filter(g=>g._score);
}
module.exports={rankedTitles};
