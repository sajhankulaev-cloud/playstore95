const names={
  eaplay:'EA Play',psplus_extra:'PlayStation Plus Extra',psplus_deluxe:'PlayStation Plus Deluxe',
  psplus_premium:'PlayStation Plus Premium',psplus_essential:'PlayStation Plus Essential',psplus:'PlayStation Plus'
};
function subscriptionOffers(data,locale){
  const refs=data.p.webctas || data.p.mobilectas;
  const offers=Object.entries(data.records).filter(([k])=>k.startsWith('GameCTA:') && k.includes(':'+data.p.id+'-')).map(([,v])=>v);
  for(const ref of refs||[])if(ref)offers.push(data.records[ref.__ref] || ref);
  const plans=new Set();
  for(const c of offers){
    const p=c.price;
    if(!p || !(p.isFree===true || p.discountedValue===0) || !p.isTiedToSubscription)continue;
    const flags=[c.type,p.membershipType,...(p.serviceBranding||[]),p.displayUpsellText,p.upsellText].join(' ');
    if(/TRIAL|пробн|wersj[aę] próbn/i.test(flags))continue;
    if(/EA_ACCESS|EA[_ ]?PLAY/i.test(flags))plans.add('eaplay');
    else if(/PS_PLUS|PlayStation Plus/i.test(flags)){
      if(/PREMIUM|премиум/i.test(flags))plans.add('psplus_premium');
      else if(/DELUXE|делюкс/i.test(flags))plans.add('psplus_deluxe');
      else if(p.tierLabel==='TIER_30')plans.add(['en-us','pl-pl'].includes(locale)?'psplus_premium':'psplus_deluxe');
      else if(p.tierLabel==='TIER_20'||/GAME_CATALOG|EXTRA|экстра/i.test(flags))plans.add('psplus_extra');
      else if(p.tierLabel==='TIER_10'||/ESSENTIAL/i.test(flags))plans.add('psplus_essential');
      else plans.add('psplus');
    }
  }
  if(!offers.some(c=>c.price))return {};
  const codes=[...plans];return {subscriptions:codes,sub:codes[0]||''};
}
function labels(region){
  const codes=region?.subscriptions||[];
  const selected=region && Object.hasOwn(region,'sub') && (region.sub||'')!==(codes[0]||'')?[region.sub]:codes;
  return [...new Set(selected.map(code=>names[code]).filter(Boolean))];
}
module.exports={subscriptionOffers,labels};
