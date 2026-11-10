// fold(): the one text normalisation search uses, here and in the pipeline (pipeline/textfold.py, the same rules and
// the same test vectors, web/test/fixtures/fold.json). Lower case; accents off; "S:ta " before a name becomes
// "sankta ", and "S:t", "St." and "St" before a name "sankt"; runs of characters that are neither letters nor digits
// become one space; a trailing "Stockholm"/"Zagreb" and a postcode after a house number go. A name starts with a
// letter or a number that is not a plain digit ("½"), as Python's [^\W\d_] reads it.
const SANKTA = /(?<![\p{L}\p{N}])s:ta\s+(?=[\p{L}\p{Nl}\p{No}])/gu;
const SANKT = /(?<![\p{L}\p{N}])(?:s:t\s*|st\.\s*|st\s+)(?=[\p{L}\p{Nl}\p{No}])/gu;
const NOT_ALNUM = /[^\p{L}\p{N}]+/gu;
const CITY_TAIL = /^(.+) (?:stockholm|zagreb)$/u;
const POSTCODE = /( \d+(?: ?[a-z]{1,3})?) (?:\d{3} ?\d{2}|\d{5})$/u;
const DESCRIPTOR = '(?:ulica|ul|trg|avenija|av|cesta|prilaz|pr|put|obala|prolaz|aleja)';
const LEADING_DESCRIPTOR = new RegExp(`^${DESCRIPTOR} (.+)$`, 'u');
const TRAILING_DESCRIPTOR = new RegExp(`^(.+) ${DESCRIPTOR}$`, 'u');

export function fold(text) {
  let s = String(text ?? '').toLowerCase().replace(/đ/g, 'd').normalize('NFD').replace(/\p{M}/gu, '');
  s = s.replace(SANKTA, 'sankta ').replace(SANKT, 'sankt ').replace(NOT_ALNUM, ' ').trim();
  return s.replace(CITY_TAIL, '$1').replace(POSTCODE, '$1');
}

// Search aliases, not a canonical street merger: distinct official "Ulica..." and "Cesta..." remain separate.
export function streetVariants(text) {
  const original = fold(text), out = [original];
  const add = value => { if (value && !out.includes(value)) out.push(value); };
  const leading = original.match(LEADING_DESCRIPTOR), trailing = original.match(TRAILING_DESCRIPTOR);
  if (leading) add(leading[1]);
  if (trailing) add(trailing[1]);
  return out;
}
