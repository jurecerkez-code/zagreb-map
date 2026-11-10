"""fold(): the one text normalisation search uses, in the pipeline (s14_search) and in the browser (web/fold.js).

Lower case; accents off (å ä → a, ö → o, đ → d, é → e, ü → u); "S:ta " before a name becomes "sankta ", and "S:t",
"St." and "St" before a name "sankt"; every run of characters that are neither letters nor digits becomes one space;
a trailing "Stockholm"/"Zagreb" and a postcode after a house number go. The same vectors pin both versions
(web/test/fixtures/fold.json, read by tests/test_textfold.py and web/test/fold.test.mjs).
"""
import re
import unicodedata

SANKTA = re.compile(r"(?<![^\W_])s:ta\s+(?=[^\W\d_])")
SANKT = re.compile(r"(?<![^\W_])(?:s:t\s*|st\.\s*|st\s+)(?=[^\W\d_])")
NOT_ALNUM = re.compile(r"[\W_]+")
CITY_TAIL = re.compile(r"^(.+) (?:stockholm|zagreb)$")
POSTCODE = re.compile(r"( \d+(?: ?[a-z]{1,3})?) (?:\d{3} ?\d{2}|\d{5})$")
DESCRIPTOR = r"(?:ulica|ul|trg|avenija|av|cesta|prilaz|pr|put|obala|prolaz|aleja)"
LEADING_DESCRIPTOR = re.compile(rf"^{DESCRIPTOR} (.+)$")
TRAILING_DESCRIPTOR = re.compile(rf"^(.+) {DESCRIPTOR}$")


def fold(text: str) -> str:
    s = unicodedata.normalize("NFD", str(text).lower().replace("đ", "d"))
    s = "".join(c for c in s if not unicodedata.category(c).startswith("M"))
    s = SANKT.sub("sankt ", SANKTA.sub("sankta ", s))
    s = NOT_ALNUM.sub(" ", s).strip()
    s = CITY_TAIL.sub(r"\1", s)
    return POSTCODE.sub(r"\1", s)


def street_variants(text: str) -> list[str]:
    """Folded lookup aliases, original first; never merged into another street or used to alter its display name."""
    original = fold(text)
    out = [original]
    for match in (LEADING_DESCRIPTOR.fullmatch(original), TRAILING_DESCRIPTOR.fullmatch(original)):
        if match and match.group(1) not in out:
            out.append(match.group(1))
    return out
