function showPsPreview(prefix,game){
 const host=document.getElementById(({imp:'importResult',all:'allImportResult',pre:'preImportResult'})[prefix]);if(!host||!game)return;
 let box=host.querySelector('[data-ps-preview]');if(!box){box=document.createElement('div');box.dataset.psPreview='1';host.prepend(box)}
 box.replaceChildren();const title=document.createElement('strong');title.textContent='Цены из PS Store';box.append(title);
 for(const [code,r] of Object.entries(game.regions)){const line=document.createElement('p');line.textContent=(code==='US'?'USA':code)+' · '+(r.salePrice==null?'Цена не указана':r.salePrice+' '+r.currency)+(r.discPerc?' · −'+r.discPerc+'%':'')+(r.eaPlayOffer?' · EA Play −10%':'');box.append(line)}
}

function rememberImportFields(id){
  for(const input of document.querySelectorAll('#'+id+' input,#'+id+' select')){
    input.dataset.importValue=input.value;
  }
}
function applyImportFields(prefix,record,game){
  record.psImport=game;
  record.psEdits={};
  for(const [code,part] of Object.entries({TR:'Tr',UA:'Ua',PL:'Pl',IN:'In',US:'Us'})){
    const changes={};
    const fields={salePrice:part+'Price',discPerc:part+'Disc',discountedUntil:part+'Until',ru:'Ru'+code};
    for(const [key,suffix] of Object.entries(fields)){
      const input=document.getElementById(prefix+suffix);
      if(input && input.value!==input.dataset.importValue)changes[key]=record.regions?.[code]?.[key] ?? input.value;
      if(key==='ru'){
        const card=document.getElementById(prefix+suffix+'Card');
        if(card && card.value!==card.dataset.importValue)changes.ru=card.value;
      }
    }
    const sub=document.getElementById(prefix+(prefix==='imp'?'SubTR':'Sub'));
    if(sub && sub.value!==sub.dataset.importValue)changes.sub=sub.value;
    if(prefix==='imp' && game.regions[code]?.discPerc>0){
      const manual=document.getElementById('manualUntil').value;
      const individual=document.getElementById(prefix+part+'Until');
      if(individual && individual.value!==individual.dataset.importValue)changes.discountedUntil=individual.value||null;
      else if(manual)changes.discountedUntil=manual;
    }
    record.psEdits[code]=changes;
  }
}
