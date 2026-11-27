const currencies={TR:'TRY',UA:'UAH',PL:'PLN',IN:'INR',US:'USD'};
function memberOffer(ctas,currency){
  for(const cta of ctas){
    const p=cta?.price;
    if(!p || (p.currencyCode && p.currencyCode!==currency) || p.isFree)continue;
    const upsell=p.upsellServiceBranding||[];
    const explicitlyTen=/(?:^|\D)10\s*[%％]/.test(p.displayUpsellText||'');
    const branded=/(?:EA_ACCESS|EA[_ ]?PLAY)/i.test([p.membershipType,p.tierLabel,...(p.serviceBranding||[]),...upsell,p.displayUpsellText].join(' '));
    const tenPrice=p.basePriceValue>0 && p.discountedValue>0 && Math.abs(p.basePriceValue*.9-p.discountedValue)<=1;
    if(branded && (tenPrice || explicitlyTen))return {percent:10,until:p.endTime||null};
  }
  return null;
}
function eligible(game,region,overrides){
  const id=game.productIds?.[region] || game.id;
  const manual=overrides?.[id]?.[region] ?? overrides?.[game.id]?.[region];
  if(typeof manual==='boolean')return manual;
  const reg=game.regions?.[region];
  const member=reg && Object.hasOwn(reg,'eaPlayOffer')?reg.eaPlayOffer:require('./ea-seed.json')[region]?.[id];
  return !!member && (!member.until || new Date(/^\d+$/.test(member.until)?Number(member.until):member.until).getTime()>Date.now());
}
function publicPrice(game,region,regular,store,convert,discount,overrides){
  if(discount>0 || !(regular>0) || !eligible(game,region,overrides))return {};
  const price=Math.round(regular*90)/100;
  return {eaStorePrice:price,eaPriceRub:convert(store,region,price)};
}
module.exports={currencies,memberOffer,eligible,publicPrice};
