let detailRequest=0;
function detailArtwork(url,width){
  return url ? '<img loading="lazy" decoding="async" alt="" src="'+escapeHtml(optimizedPsImageUrl(url,width))+'">' : '';
}
function productRail(title,items,currentId){
  if(!items.length)return '';
  return '<section class="detailSection productPanel"><h2>'+title+'</h2><div class="productRail">'+items.map(item=>{
    const selected=item.id===currentId;
    const name=currentId?(productCaption(item).edition||item.name):item.name;
    return '<a class="detailProduct" '+(selected?'aria-current="page" ':'')+'href="'+escapeHtml(gameLink(item.id))+'">'+detailArtwork(item.cover,480)+'<div><strong>'+escapeHtml(name||'')+'</strong><b>'+(item.finalPriceRub || (state.region==='US' && item.storePrice>0)?gamePriceText(item):'Нет в продаже')+'</b>'+eaPriceHtml(item)+'</div></a>';
  }).join('')+'</div></section>';
}
async function renderGamePage(){
  const request=++detailRequest,host=document.getElementById('gamePage');
  host.hidden=false;
  const back='<a class="detailBack" href="'+escapeHtml(__storefrontBasePath+'?tab=home&region='+state.region)+'">Главная</a>';
  host.innerHTML=back+'<p role="status">Загрузка игры…</p>';
  const url=new URL(location.href);url.searchParams.set('region',state.region);history.replaceState(null,'',url);
  try{
    const response=await fetch('/api/game-page/'+encodeURIComponent(gamePageId)+'?region='+encodeURIComponent(state.region));
    if(!response.ok)throw Error(response.status===404?'Игра не найдена':'Не удалось загрузить игру');
    const g=await response.json();if(request!==detailRequest)return;
    document.title=g.name+' — PlayStore 95';
    const esc=v=>escapeHtml(String(v??''));
    const languages=g.languages||[];
    const status=g.ru==='voice'||languages.some(l=>l.voice===true)?'voice':
      g.ru==='text'||languages.some(l=>l.text===true)?'text':
      g.ru==='none'||(languages.length && languages.every(l=>l.voice===false && l.text===false))?'none':'unknown';
    const language={voice:'Русская озвучка',text:'Русский текст',none:'Русский отсутствует',unknown:'Не указано'}[status];
    const discount=g.discPerc>0 && (g.finalPriceRub>0 || (state.region==="US" && g.storePrice>0));
    const until=discount && g.discountedUntil?'<p class="until">Скидка действует до '+esc(formatDateDMY(String(g.discountedUntil).slice(0,10)))+'</p>':'';
    const badge=discount?'<span class="discount">−'+esc(g.discPerc)+'%</span>':'';
    const access=g.subscriptions?.length?'<p class="detailAccess">Входит в подписку <strong>'+g.subscriptions.map(esc).join(' · ')+'</strong></p>':'';
    const rating=Number(g.rating)>0?Number(g.rating).toFixed(2):'—';
    const genre=Array.isArray(g.genres)?g.genres.join(', '):g.genres;
    const facts=[['Платформа',g.platform],['Жанр',genre],['Язык',language],['Дата релиза',g.releaseDate?formatDateDMY(g.releaseDate):''],['Игроков на одном экране',g.players],['Издание',productCaption(g).edition]];
    const editions=g.isAddon?g.editions:[g,...g.editions];
    host.innerHTML=back+'<article><header class="detailHero"><div class="detailCover">'+detailArtwork(g.cover,720)+'</div><div class="detailTitle"><h1>'+esc(productCaption(g).name)+(g.isAddon?'<span class="detailAddonBadge">Аддон</span>':'')+'</h1><div class="detailRating"><b>'+rating+'</b>Рейтинг в PS Store</div></div>'+
      '<div class="detailSummary">'+(g.description?'<p class="detailDescription" id="detailText">'+esc(g.description)+'</p><button type="button" class="detailExpand" aria-controls="detailText" aria-expanded="false">Показать всё описание</button>':'')+'<div class="detailPlatform">Платформа:<strong>'+esc(g.platform||'—')+'</strong></div></div>'+
      '<div class="detailPurchase">'+until+'<strong>'+(g.finalPriceRub || (state.region==='US' && g.storePrice>0)?gamePriceText(g):'Нет в продаже')+'</strong>'+badge+eaPriceHtml(g)+access+'<div>'+(g.finalPriceRub?'<button id="detailBuy" class="buyBtn" type="button">Добавить в корзину</button>':'')+'<button id="detailWish" class="detailWish" type="button"></button></div></div></header>'+
      productRail('Издания',editions,g.id)+
      '<section class="detailSection mediaSection" id="gmMediaSection"><div class="mediaHeading"><h2>Скриншоты</h2><div><button type="button" aria-label="Прокрутить назад">‹</button><button type="button" aria-label="Прокрутить вперёд">›</button></div></div><div class="gmv2MediaRail" id="gmMediaRail"></div></section>'+
      (g.isAddon?'':'<section class="detailSection infoPanel"><h2>Информация</h2><dl>'+facts.filter(([,v])=>v).map(([k,v])=>'<div><dt>'+esc(k)+':</dt><dd>'+esc(v)+'</dd></div>').join('')+'</dl></section>')+
      (g.isAddon?'':productRail('Аддоны',g.addons,null))+'</article>';
    const expand=host.querySelector('.detailExpand');
    if(expand){
      const desc=host.querySelector('.detailDescription');
      expand.hidden=desc.scrollHeight<=desc.clientHeight+1;
      expand.onclick=()=>{const open=desc.classList.toggle('expanded');expand.setAttribute('aria-expanded',String(open));expand.textContent=open?'Свернуть описание':'Показать всё описание'};
    }
    host.querySelectorAll('.mediaHeading button').forEach((button,i)=>button.onclick=()=>{
      const rail=document.getElementById('gmMediaRail');rail.scrollBy({left:(i?1:-1)*(rail.firstElementChild?.offsetWidth+16||rail.clientWidth),behavior:'smooth'});
    });
    const buy=document.getElementById('detailBuy'),wish=document.getElementById('detailWish');
    function buttons(){
      if(buy){buy.dataset.cartGame=g.id;buy.dataset.cartLabel='Добавить в корзину';buy.dataset.cartLabelIn='В корзине';setBuyBtnState(buy,isInCart(g.id,state.region))}
      const liked=isInWishlist(g.id,state.region);wish.textContent=liked?'♥':'♡';wish.setAttribute('aria-label',liked?'Убрать из желаемого':'Добавить в желаемое');wish.setAttribute('aria-pressed',String(liked));
    }
    if(buy)buy.onclick=()=>{if(isInCart(g.id,state.region))removeFromCart(g.id);else addToCart(g);buttons()};
    wish.onclick=()=>{toggleWishlist(g);buttons()};buttons();gmRenderMedia(g);
  }catch(e){
    if(request!==detailRequest)return;
    host.innerHTML=back+'<h1>'+escapeHtml(e.message)+'</h1><button class="detailWish" type="button">Повторить</button>';
    host.querySelector('button').onclick=renderGamePage;
  }
}
