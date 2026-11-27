function englishEdition(game){
  const label=String(game.edition || '').trim();
  const english=s=>typeof s==='string' && /[a-z]/i.test(s) && !/[^\p{Script=Latin}\p{M}\p{N}\p{P}\p{S}\s]/u.test(s);
  if(english(game.editionEn))return game.editionEn;
  if(english(label))return label;
  if(!label || /^(стандартн|стандарт\.|станд\.|обычное издание|базовая игра|базовое издание|полная версия игры|полная игра)/i.test(label))return 'Standard Edition';
  const plain=label.replace(/^издание\s+/i,'').trim();
  if(english(plain))return /edition|bundle|pack|collection|upgrade/i.test(plain)?plain:plain+' Edition';
  const translations=[
    [/^(цифр.*(?:делюкс|расш|deluxe))/i,'Digital Deluxe Edition'],
    [/^(?:делюкс|расширенное издание|издание «?делюкс»?|deluxe-издание)$/i,'Deluxe Edition'],
    [/^полное издание$/i,'Complete Edition'],[/^золотое издание$/i,'Gold Edition'],
    [/^максимальное издание$/i,'Ultimate Edition'],[/^премиум$/i,'Premium Edition'],
    [/^сезонный пропуск$/i,'Season Pass']
  ];
  for(const [pattern,name] of translations)if(pattern.test(label))return name;
  return [game.names?.en,game.name].find(english) || (game.psProductType==='addon'?'Add-on':'Edition');
}
module.exports={englishEdition};
