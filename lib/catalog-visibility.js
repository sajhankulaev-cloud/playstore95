const addon = game => game.psProductType === 'addon' || /^(?:add[- ]?on|dlc|дополнение)$/i.test(game.edition || '');
const gameOnly = game => !addon(game);
function standard(game) {
  if (addon(game)) return false;
  const edition = String(game.edition || '').trim();
  const title = game.names?.en || game.name || '';
  const special = /\b(deluxe|ultimate|premium|gold|complete|definitive|collector.s|special|legendary|anniversary)\s+(?:digital\s+)?edition\b|\b(?:deluxe|ultimate|premium)\s*$|расширенное издание/i;
  if (special.test(title) || special.test(edition)) return false;
  return !edition || /\bstandard(?: edition)?$|стандартн(?:ое издание|ая версия)$/i.test(edition) ||
    [title,game.name,game.names?.ru].some(name => name && name.toLowerCase()===edition.toLowerCase());
}
module.exports={addon,gameOnly,standard};
