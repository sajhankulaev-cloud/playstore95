// Split store titles for display only. Full product names remain available to search and orders.
function productCaption(game) {
  const name = String(game.name || '').trim();
  const edition = String(game.edition || '').trim();
  if (!name || !edition || game.isAddon || game.psProductType === 'addon' || /^add-on$/i.test(edition)) {
    return {name, edition};
  }
  const clean = text => text.replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const same = (a,b) => clean(a) === clean(b);
  const base = name.replace(/\s*(?:\(?(?:for\s+)?PS[45][™®]?(?:\s*(?:&|\/|and)\s*PS[45][™®]?)?\)?)$/i, '').trim() || name;
  const trimEnd = text => text.replace(/[\s:–—-]+$/, '');
  const split = index => ({name:trimEnd(base.slice(0,index)), edition:base.slice(index).trim()});

  // A named suffix after a separator can be an edition, bundle or a subtitle.
  // Preserve subtitles unless the source identifies the suffix as the variant.
  // Some feeds send a short game name and a longer, title-prefixed edition field.
  if (edition.toLowerCase().startsWith(base.toLowerCase())) {
    const tail = edition.slice(base.length);
    if (/^(?:\s+|[:–—-]\s*)/.test(tail)) {
      const short = tail.replace(/^[\s:–—-]+/, '');
      if (short) return {name:base,edition:short};
    }
  }
  const separators = [...base.matchAll(/\s+[-–—]\s+|:\s+/g)];
  for (const match of separators.reverse()) {
    const index = match.index + match[0].length;
    const suffix = base.slice(index);
    if (same(base.slice(0,match.index),edition) || same(suffix,edition) ||
        /\b(?:edition|bundle|upgrade|collection|open beta)\b/i.test(suffix)) {
      return split(index);
    }
  }

  // Product labels such as “Super Citizen Edition” do not always have a separator.
  const named = /\s+((?:(?:digital|super|special|ultimate|premium|standard|deluxe|gold|complete|definitive|legendary|collector['’]s|anniversary|platinum|super citizen|game of the year)\s+)+edition|cross[- ]gen bundle)(?:\s*\[[^\]]+\])?$/i.exec(base);
  if (named) return split(named.index+1);
  if (base.length>edition.length && base.toLowerCase().endsWith(' '+edition.toLowerCase())) {
    return split(base.length-edition.length);
  }
  if (same(base,edition) || same(name,edition)) return {name,edition:''};
  return {name,edition};
}
