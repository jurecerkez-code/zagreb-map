"""The Zagreb history stories: the one place their beats, captions, sources and overlays are written.

Writes scenes/<id>/beats.csv, narration.csv and the overlay CSVs that scripts/scenes/build.mjs turns into
web/scenes/<id>.json, and docs/scenes-sources.md (every caption claim with its source URL) in the project folder.
Usage (from engine/):  uv run python scripts/scenes/zagreb_scenes.py && node scripts/scenes/build.mjs

The engine's second language slot is 'sv'; here it carries Croatian. Each camera is placed from its target by a
bearing (degrees from north, target to camera), a ground distance and a height, so every beat looks down at 25 deg
or more (web/test/scene-player.test.mjs). Landmark years and architects agree with data/landmarks/landmarks.json
(the cards). Writing rule: short plain sentences, no dashes, no superlatives without a source.
"""
from __future__ import annotations

import csv
import math
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[2]
PROJECT = ENGINE.parent
OUT = ENGINE / "scenes"

W = "https://en.wikipedia.org/wiki/"
H = "https://hr.wikipedia.org/wiki/"
S = {  # short source names (shown in the player) -> URL
    "Golden Bull": W + "Golden_Bull_of_1242",
    "Gornji grad": W + "Gornji_grad,_Zagreb",
    "Kaptol": W + "Kaptol,_Zagreb",
    "History of Zagreb": W + "History_of_Zagreb",
    "Lotrščak Tower": W + "Lotr%C5%A1%C4%8Dak_Tower",
    "Kamenita vrata (hr)": H + "Kamenita_vrata",
    "Zagreb (hr)": H + "Zagreb",
    "1880 Zagreb earthquake": W + "1880_Zagreb_earthquake",
    "Potres u Zagrebu 1880. (hr)": H + "Potres_u_Zagrebu_1880.",
    "Zagreb Cathedral": W + "Zagreb_Cathedral",
    "Zagrebačka katedrala (hr)": H + "Zagreba%C4%8Dka_katedrala",
    "St. Mark's Church": W + "St._Mark%27s_Church,_Zagreb",
    "Lenuci Horseshoe": W + "Lenuci_Horseshoe",
    "Zagreb Glavni kolodvor": W + "Zagreb_Glavni_kolodvor",
    "Art Pavilion": W + "Art_Pavilion,_Zagreb",
    "Hrvatski državni arhiv (hr)": H + "Hrvatski_dr%C5%BEavni_arhiv",
    "Croatian National Theatre": W + "Croatian_National_Theatre,_Zagreb",
    "HNK u Zagrebu (hr)": H + "Hrvatsko_narodno_kazali%C5%A1te_u_Zagrebu",
    "Museum of Arts and Crafts": W + "Museum_of_Arts_and_Crafts,_Zagreb",
    "Radović 1992 (IPU)": "https://www.ipu.hr/content/radovi-ipu/RIPU-16-1992_199-215-Radovic.pdf",
    "Grad Zagreb, KULTURA_ZASTITA": "https://services8.arcgis.com/Usi0jGQwMmBUpFjr/arcgis/rest/services/KULTURA_ZASTITA/FeatureServer/0",
    "Meštrović Pavilion": W + "Me%C5%A1trovi%C4%87_Pavilion",
    "Cvjetno naselje (hr)": H + "Cvjetno_naselje",
    "Novi Zagreb (hr)": H + "Novi_Zagreb",
    "Novi Zagreb": W + "Novi_Zagreb",
    "Zagrebački velesajam (hr)": H + "Zagreba%C4%8Dki_velesajam",
    "Most slobode (hr)": H + "Most_slobode_(Zagreb)",
    "Super Andrija (hr)": H + "Super_Andrija",
    "Mamutica": W + "Mamutica",
    "Museum of Contemporary Art": W + "Museum_of_Contemporary_Art,_Zagreb",
    "this map's data": "engine/data/years.parquet (map build v20261021-years2)",
    "landmark card": "data/landmarks/landmarks.json",
}


def cam(lat, lon, bearing, dist, h):
    """Camera at `dist` metres from the target on `bearing` (deg from north), `h` metres above the ground."""
    b = math.radians(bearing)
    return (round(lat + dist * math.cos(b) / 111_320, 6),
            round(lon + dist * math.sin(b) / (111_320 * math.cos(math.radians(lat))), 6), h)


def beat(year, target, bearing, dist, h, en, hr, claims, secs=8, photo=None):
    """claims: [(claim text, [source keys])]; the player shows the union of the keys as 'Source: ...'."""
    keys = []
    for _, ks in claims:
        keys += [k for k in ks if k not in keys]
    return dict(year=year, target=target, cam=cam(*target, bearing, dist, h), en=en, hr=hr, claims=claims,
                sources=keys, secs=secs, photo=photo)


# Landmarks (data/landmarks/landmarks.json coordinates)
CATHEDRAL = (45.8144444, 15.9797222)
ST_MARK = (45.816411, 15.9736107)
LOTRSCAK = (45.8146268, 15.9732508)
STONE_GATE = (45.8158, 15.9753)
GRKAT = (45.8152024, 15.9733127)
STATION = (45.8044358, 15.9787044)
PAVILION = (45.8072222, 15.9786111)
HNK = (45.8095, 15.97)
MUO = (45.8094056, 15.9685575)
ARCHIVE = (45.8061111, 15.9702778)
MESTROVIC = (45.8099517, 15.9871834)
SUPER_ANDRIJA = (45.77164, 15.96812)
MAMUTICA = (45.7711111, 15.9947222)
MSU = (45.7788131, 15.9818579)
# City register ensembles (KULTURA_ZASTITA centroids)
RAILWAY_COLONY = (45.81601, 16.0219)
TRESNJEVKA = (45.80155, 15.94837)
CVJETNO = (45.79259, 15.96605)
FAIR = (45.78017, 15.97264)
BRIDGE = (45.7865, 15.9797)

SCENES = {}

SCENES["two-hills"] = dict(
    title=("Two hills: Gradec and Kaptol", "Dva brda: Gradec i Kaptol"), year=1242,
    markers=[("Gradec", *ST_MARK, "Gradec", "Gradec"), ("Kaptol", *CATHEDRAL, "Kaptol", "Kaptol"),
             ("Lotrščak", *LOTRSCAK, "", ""), ("Kamenita vrata", *STONE_GATE, "", "")],
    route=dict(label=("Medveščak stream, today Tkalčićeva street (approximate)", "Potok Medveščak, danas Tkalčićeva ulica (približno)"),
               coords=[(45.8205, 15.9760), (45.8185, 15.9762), (45.8165, 15.9764), (45.8150, 15.9767), (45.8137, 15.9771)]),
    beats=[
        beat(1242, (45.8152, 15.9762), 200, 1500, 900,
             "Zagreb grew from two towns on two neighbouring hills: Gradec in the west and Kaptol in the east.",
             "Zagreb je nastao od dvaju naselja na dva susjedna brežuljka: Gradeca na zapadu i Kaptola na istoku.",
             [("Gradec and Kaptol together are the medieval nucleus of the city", ["Gornji grad", "History of Zagreb"])]),
        beat(1242, CATHEDRAL, 160, 650, 400,
             "Kaptol was the bishop's town. The Diocese of Zagreb was founded here in 1094.",
             "Kaptol je bio biskupov grad. Zagrebačka biskupija ovdje je osnovana 1094.",
             [("Kaptol settlement confirmed in 1094 when King Ladislaus founded the Zagreb diocese", ["Kaptol"])]),
        beat(1242, ST_MARK, 200, 650, 400,
             "In 1242 King Béla IV made Gradec a free royal city with the Golden Bull.",
             "Kralj Bela IV. proglasio je 1242. Gradec slobodnim kraljevskim gradom Zlatnom bulom.",
             [("Golden Bull issued 16 November 1242 by Béla IV, proclaiming Gradec a free royal city", ["Golden Bull"])],
             photo=("Zlatna bula Bele IV.gif", "The Golden Bull of 1242", "Zlatna bula iz 1242.")),
        beat(1266, LOTRSCAK, 190, 480, 280,
             "The citizens built walls and towers, finished by 1266. Lotrščak tower guarded the southern gate.",
             "Građani su podigli zidine i kule, dovršene do 1266. Kula Lotrščak čuvala je južna gradska vrata.",
             [("fortifications took about twenty years and were completed in 1266", ["Lotrščak Tower"]),
              ("Lotrščak was built to guard the southern gate (Dverce)", ["Lotrščak Tower"]),
              ("card year 1266", ["landmark card"])],
             photo=("Lotrščak Tower, Zagreb.jpg", "Lotrščak tower today", "Kula Lotrščak danas")),
        beat(1667, (45.8168, 15.9764), 185, 750, 450,
             "Between the hills ran the Medveščak stream, where Tkalčićeva street is today. In 1667 the two towns clashed over a bridge across it.",
             "Između brda tekao je potok Medveščak, gdje je danas Tkalčićeva ulica. Godine 1667. dva su se grada sukobila oko mosta preko njega.",
             [("the former Medveščak creek is present-day Tkalčićeva Street", ["History of Zagreb"]),
              ("great conflict in 1667 over the construction of a bridge over the Medveščak", ["History of Zagreb"])], secs=9),
        beat(1760, STONE_GATE, 120, 400, 250,
             "The Stone Gate is the only one of the four town gates still standing. It took its present form in 1760.",
             "Kamenita vrata jedina su sačuvana od četiriju gradskih vrata. Današnji oblik dobila su 1760.",
             [("four main gates; Kamenita vrata the only one preserved", ["Gornji grad", "Kamenita vrata (hr)"]),
              ("present form in 1760 (card year 1760)", ["Kamenita vrata (hr)", "landmark card"])],
             photo=("Kamenita vrata W.jpg", "The Stone Gate from the Upper Town side", "Kamenita vrata s gornjogradske strane")),
        beat(1850, (45.8130, 15.9762), 190, 1700, 1000,
             "In 1850 Gradec, Kaptol and the settlements around them were joined into one city: Zagreb.",
             "Godine 1850. Gradec, Kaptol i okolna naselja spojeni su u jedan grad: Zagreb.",
             [("in 1850 Gradec and Kaptol with surrounding settlements were united into a single settlement", ["History of Zagreb", "Zagreb (hr)"])]),
        beat(2026, (45.8090, 15.9765), 175, 2400, 1350,
             "From the two hills the city spread south across the plain, towards the Sava.",
             "S dvaju brda grad se širio na jug preko ravnice, prema Savi.",
             [("growth between the railway and the Sava; Novi Zagreb south of the Sava", ["History of Zagreb"])]),
    ])

SCENES["earthquake-1880"] = dict(
    title=("The 1880 earthquake and the rebuilding", "Potres 1880. i obnova"), year=1880,
    markers=[("Katedrala", *CATHEDRAL, "", ""), ("Crkva sv. Marka", *ST_MARK, "", ""),
             ("Grkokatolička konkatedrala", *GRKAT, "", "")],
    beats=[
        beat(1880, (45.8140, 15.9768), 200, 1800, 1050,
             "On 9 November 1880 an earthquake struck Zagreb. Its epicentre was on Medvednica, the mountain north of the city.",
             "Dana 9. studenoga 1880. Zagreb je pogodio potres. Epicentar mu je bio na Medvednici, planini sjeverno od grada.",
             [("9 November 1880, magnitude 6.3, epicentre in Medvednica", ["1880 Zagreb earthquake", "Potres u Zagrebu 1880. (hr)"])], secs=9),
        beat(1880, CATHEDRAL, 210, 520, 320,
             "Many buildings were damaged. In the cathedral the quake brought down the vaults and damaged the bell tower.",
             "Mnoge su zgrade oštećene. U katedrali je potres srušio svodove i oštetio zvonik.",
             [("destroyed or damaged many buildings", ["1880 Zagreb earthquake"]),
              ("the quake brought down the cathedral's vaults and damaged the bell tower", ["Potres u Zagrebu 1880. (hr)"])],
             secs=9, photo=("Zagreb Cathedral interior 1880.jpg", "Inside the cathedral after the earthquake, 1880 (photo Ivan Standl)",
                            "Unutrašnjost katedrale nakon potresa, 1880. (snimio Ivan Standl)")),
        beat(1882, ST_MARK, 160, 400, 250,
             "St Mark's Church was being renovated when the quake hit. The work ended in 1882, in neo-Gothic style, to designs by Friedrich von Schmidt and Hermann Bollé.",
             "Crkva sv. Marka bila je u obnovi kad je udario potres. Radovi su završeni 1882. u neogotičkom stilu, prema nacrtima Friedricha von Schmidta i Hermanna Bolléa.",
             [("renovation 1878 to 1882, neo-Gothic, designs by F. Schmidt and Hermann Bollé; damaged by the 1880 quake during it", ["St. Mark's Church"]),
              ("card year 1882, Schmidt restoration, works led by Bollé", ["landmark card"])],
             secs=10, photo=("Roof of St, Mark's Church, Zagreb.jpg", "The tiled roof of St Mark's", "Krov crkve sv. Marka")),
        beat(1886, GRKAT, 200, 380, 240,
             "Bollé also built the Greek Catholic church of Saints Cyril and Methodius, on the site of a chapel the quake had damaged.",
             "Bollé je projektirao i grkokatoličku crkvu sv. Ćirila i Metoda, na mjestu kapele oštećene u potresu.",
             [("Greek Catholic co-cathedral stands on the site of an earlier chapel damaged in 1880; designed by Hermann Bollé", ["Zagreb (hr)"]),
              ("card year 1886, architect Hermann Bollé", ["landmark card"])], secs=9),
        beat(1902, CATHEDRAL, 200, 680, 400,
             "The cathedral was rebuilt in neo-Gothic style, led by Hermann Bollé to plans by Friedrich von Schmidt. Its spires rise about 108 metres.",
             "Katedrala je obnovljena u neogotičkom stilu. Radove je vodio Hermann Bollé prema nacrtima Friedricha von Schmidta. Tornjevi su visoki oko 108 metara.",
             [("neo-Gothic renovation led by Hermann Bollé (en: 1880 to 1902; hr: 1880 to 1906), plans by F. Schmidt", ["Zagreb Cathedral", "Zagrebačka katedrala (hr)"]),
              ("twin spires over 108 m", ["Zagreb Cathedral"]),
              ("card year 1902, Hermann Bollé to plans of Friedrich von Schmidt", ["landmark card"])],
             secs=10, photo=("67c potres 1880 katedrala BDM Zagreb.jpg", "The old cathedral after the earthquake, 1880 (photo Hinko Krapek)",
                             "Stara katedrala nakon potresa, 1880. (snimio Hinko Krapek)")),
        beat(1914, (45.8085, 15.9755), 180, 1700, 1000,
             "Between 1880 and 1914 the city grew fast and took its present layout. Many of the dated Lower Town buildings on this map come from these years.",
             "Između 1880. i 1914. grad je brzo rastao i dobio današnji raspored. Mnoge datirane zgrade Donjeg grada na ovoj karti potječu iz tih godina.",
             [("Zagreb developed from 1880 to 1914 after an earthquake, when it adopted its present layout", ["History of Zagreb"]),
              ("of 340 dated buildings within 700 m of 45.808 N 15.975 E, 188 are dated 1880 to 1917", ["this map's data"])], secs=10),
        beat(2026, CATHEDRAL, 235, 720, 430,
             "On 22 March 2020 the strongest earthquake since 1880 hit Zagreb. It damaged one of the cathedral's spires, and the restoration is still going on.",
             "Dana 22. ožujka 2020. Zagreb je pogodio najjači potres nakon 1880. Oštetio je jedan od tornjeva katedrale, a obnova još traje.",
             [("22 March 2020 earthquake, the strongest since 1880", ["History of Zagreb"]),
              ("one spire damaged in 2020; as of 2026 still under reconstruction", ["Zagreb Cathedral"])], secs=10),
    ])

SCENES["green-horseshoe"] = dict(
    title=("Lenuci's Green Horseshoe", "Lenucijeva zelena potkova"), year=1889,
    markers=[("Zrinjevac", 45.8110, 15.9778, "", ""), ("Glavni kolodvor", *STATION, "", ""),
             ("Umjetnički paviljon", *PAVILION, "", ""), ("Botanički vrt", 45.8047, 15.9726, "", ""),
             ("Marulićev trg", *ARCHIVE, "", ""), ("HNK", *HNK, "", ""), ("Muzej za umjetnost i obrt", *MUO, "", "")],
    route=dict(label=("The Green Horseshoe", "Zelena potkova"),
               coords=[(45.8125, 15.9780), (45.8110, 15.9778), (45.8095, 15.9784), (45.8072, 15.9786), (45.8052, 15.9788),
                       (45.8049, 15.9760), (45.8047, 15.9726), (45.8052, 15.9703), (45.8061, 15.9703), (45.8074, 15.9701),
                       (45.8095, 15.9700), (45.8108, 15.9705)]),
    beats=[
        beat(1882, (45.8078, 15.9745), 180, 1400, 900,
             "In 1882 the urbanist Milan Lenuci drew a U of park squares for the Lower Town. People call it the Green Horseshoe.",
             "Urbanist Milan Lenuci osmislio je 1882. niz trgova s perivojima u obliku slova U za Donji grad. Zovu ga Zelena potkova.",
             [("conceived in 1882 by urbanist Milan Lenuci; U-shaped system of squares with parks; also Green Horseshoe", ["Lenuci Horseshoe"])], secs=9),
        beat(1888, (45.8110, 15.9778), 150, 480, 290,
             "It has seven squares on three straight lines. Going clockwise, it starts at Zrinjevac.",
             "Ima sedam trgova na tri ravne crte. U smjeru kazaljke na satu počinje Zrinjevcem.",
             [("seven squares aligned on three straight lines; starting from the northeast and going clockwise, Zrinjevac", ["Lenuci Horseshoe"])]),
        beat(1892, STATION, 5, 520, 310,
             "The main railway station closes King Tomislav Square in the south. Ferenc Pfaff designed it, and it opened on 18 August 1892.",
             "Glavni kolodvor zatvara Trg kralja Tomislava s juga. Projektirao ga je Ferenc Pfaff, a otvoren je 18. kolovoza 1892.",
             [("built by Ferenc Pfaff, opened 18 August 1892", ["Zagreb Glavni kolodvor"]), ("card year 1892, Ferenc Pfaff", ["landmark card"])],
             secs=9, photo=("Zagreb Glavni kolodvor 1d - front.jpg", "The main station today", "Glavni kolodvor danas")),
        beat(1898, PAVILION, 200, 400, 240,
             "The Art Pavilion has an iron frame made for the 1896 Millennium Exhibition in Budapest. It was shipped to Zagreb and opened here in 1898.",
             "Umjetnički paviljon ima željeznu konstrukciju izrađenu za milenijsku izložbu u Budimpešti 1896. Prenesen je u Zagreb i otvoren 1898.",
             [("prefabricated iron skeleton for the 1896 Budapest Millennium Exhibition, shipped to Zagreb", ["Art Pavilion"]),
              ("established 1898 (card year 1898)", ["Art Pavilion", "landmark card"])],
             secs=10, photo=("Umjetnički paviljon Zagreb.jpg", "The Art Pavilion on King Tomislav Square", "Umjetnički paviljon na Trgu kralja Tomislava")),
        beat(1898, (45.8047, 15.9726), 175, 650, 400,
             "In 1889 the new Botanical Garden joined the two ends of the U.",
             "Godine 1889. novi Botanički vrt spojio je dva kraja slova U.",
             [("in 1889 the horseshoe was finished, its two ends connected by the newly built Botanical Garden", ["Lenuci Horseshoe"])]),
        beat(1913, ARCHIVE, 200, 440, 270,
             "On Marulić Square a building for the University Library and the Land Archive was finished in 1913. The State Archives are still in it.",
             "Na Marulićevu trgu 1913. dovršena je zgrada za Sveučilišnu knjižnicu i Zemaljski arhiv. U njoj je i danas Hrvatski državni arhiv.",
             [("1913: building purpose-built for the University Library and the Land Archive completed; the Archive is still there", ["Hrvatski državni arhiv (hr)"]),
              ("card year 1913", ["landmark card"])], secs=9),
        beat(1913, HNK, 200, 460, 280,
             "On Republic of Croatia Square stands the National Theatre by Fellner and Helmer. It opened in 1895, when Emperor Franz Joseph visited.",
             "Na Trgu Republike Hrvatske stoji Hrvatsko narodno kazalište, djelo Fellnera i Helmera. Otvoreno je 1895., za careva posjeta Zagrebu.",
             [("designs by Fellner & Helmer; opened 1895, Franz Joseph I present during his 1895 visit", ["Croatian National Theatre", "HNK u Zagrebu (hr)"]),
              ("card year 1895", ["landmark card"])],
             secs=9, photo=("Croatian National Theater, Zagreb 01.jpg", "The Croatian National Theatre", "Hrvatsko narodno kazalište")),
        beat(1913, MUO, 250, 400, 250,
             "Beside it is Hermann Bollé's building for the Museum of Arts and Crafts and its school, finished in 1888.",
             "Pokraj njega je zgrada Muzeja za umjetnost i obrt i njegove škole, djelo Hermanna Bolléa iz 1888.",
             [("building constructed in 1888 by Hermann Bollé, merging museum and school", ["Museum of Arts and Crafts"]),
              ("card year 1888, Hermann Bollé", ["landmark card"])]),
        beat(2026, (45.8075, 15.9745), 195, 1600, 1000,
             "Today the horseshoe is still a chain of squares with parks, lined with museums and institutions.",
             "Potkova je i danas niz trgova s perivojima, uz koje su muzeji i ustanove.",
             [("U-shaped system of squares with parks; home to many institutions and several museums", ["Lenuci Horseshoe"])]),
    ])

SCENES["interwar-estates"] = dict(
    title=("Between the wars: new estates", "Između dvaju ratova: nova naselja"), year=1923,
    markers=[("Željeznička kolonija", *RAILWAY_COLONY, "", ""), ("Prva hrvatska štedionica, Trešnjevka", *TRESNJEVKA, "", ""),
             ("Meštrovićev paviljon", *MESTROVIC, "", ""), ("Cvjetno naselje", *CVJETNO, "", "")],
    beats=[
        beat(1918, (45.8080, 15.9850), 210, 2600, 1500,
             "In the 1920s Zagreb's population grew by 70 percent. New housing estates went up at the edge of the city.",
             "U 1920-ima broj stanovnika Zagreba porastao je za 70 posto. Na rubu grada nicala su nova stambena naselja.",
             [("1920s population increase of 70 percent", ["History of Zagreb"]),
              ("workers' estates built in Zagreb between the two wars", ["Radović 1992 (IPU)"])], secs=9),
        beat(1923, RAILWAY_COLONY, 200, 720, 430,
             "In Maksimir, the Railway Colony: rows of houses with gardens for railway staff, beside the line where most of them worked.",
             "U Maksimiru, Željeznička kolonija: kuće u nizu s vrtovima za željezničare, uz prugu na kojoj je većina njih radila.",
             [("garden settlement for railway workers, row houses, bounded in the south by the railway, workplace of most residents", ["Radović 1992 (IPU)"])], secs=9),
        beat(1927, RAILWAY_COLONY, 140, 460, 290,
             "It was planned in 1923 and built by 1927. The City's heritage register dates it 1923, so on this map it stands from that year.",
             "Planirana je 1923., a izgrađena do 1927. Gradski registar zaštite datira je u 1923., pa na ovoj karti stoji od te godine.",
             [("planned by the 1923 regulation plan, built 1927", ["Radović 1992 (IPU)"]),
              ("KULTURA_ZASTITA Z-1530 Željeznička kolonija, datacija 1923.", ["Grad Zagreb, KULTURA_ZASTITA"])], secs=10),
        beat(1935, TRESNJEVKA, 200, 620, 370,
             "In Trešnjevka, the estate of the Prva hrvatska štedionica savings bank was built in 1934 and 1935.",
             "Na Trešnjevci je 1934. i 1935. izgrađeno naselje Prve hrvatske štedionice.",
             [("KULTURA_ZASTITA Z-1542, part of the estate 'Prva hrvatska štedionica' in Trešnjevka, datacija 1934.-35.", ["Grad Zagreb, KULTURA_ZASTITA"])]),
        beat(1938, MESTROVIC, 200, 420, 260,
             "Ivan Meštrović designed this round exhibition hall, built in 1938 on today's Square of the Victims of Fascism.",
             "Ivan Meštrović projektirao je ovu okruglu izložbenu dvoranu, sagrađenu 1938. na današnjem Trgu žrtava fašizma.",
             [("designed by Ivan Meštrović, built 1938, one of the first round exhibition halls in the region, on the Square of the Victims of Fascism", ["Meštrović Pavilion"]),
              ("card year 1938, Ivan Meštrović", ["landmark card"])],
             photo=("Meštrović Pavilion 20180428 5522.jpg", "The Meštrović Pavilion", "Meštrovićev paviljon")),
        beat(1938, MESTROVIC, 110, 420, 260,
             "It was later a mosque and then the Museum of the Revolution. Since 1990 it has been the artists' house again.",
             "Kasnije je bio džamija, a zatim Muzej revolucije. Od 1990. ponovno je dom likovnih umjetnika.",
             [("converted into a mosque under the NDH, then Museum of the Revolution; given back to the artists' association in 1990", ["Meštrović Pavilion"])]),
        beat(1940, CVJETNO, 200, 680, 410,
             "In 1939 the architect Vlado Antolić planned Cvjetno naselje, the first planned estate by the Sava. Its houses date from 1939 and 1940.",
             "Arhitekt Vlado Antolić osmislio je 1939. Cvjetno naselje, prvo plansko naselje uz Savu. Kuće su iz 1939. i 1940.",
             [("1939 Vlado Antolić planned Cvjetno naselje, the first planned settlement by the Sava", ["Cvjetno naselje (hr)"]),
              ("KULTURA_ZASTITA Z-1543 Cvjetno naselje, datacija 1939.-40.", ["Grad Zagreb, KULTURA_ZASTITA"])],
             secs=10, photo=("Cvjetno naselje, Zagreb.JPG", "Cvjetno naselje in 2014, with later towers behind", "Cvjetno naselje 2014., iza njega kasniji neboderi")),
        beat(1941, (45.8000, 15.9700), 190, 3000, 1700,
             "After the First World War the city reached towards the Sava, and the first embankment was built along the river.",
             "Nakon Prvoga svjetskog rata grad se približio Savi, a uz rijeku je izgrađen prvi nasip.",
             [("after WWI Zagreb approached the Sava, and the first embankment along the Sava was built", ["Cvjetno naselje (hr)"])]),
    ])

SCENES["across-the-sava"] = dict(
    title=("Across the Sava: Novi Zagreb", "Preko Save: Novi Zagreb"), year=1956,
    markers=[("Zagrebački velesajam", *FAIR, "", ""), ("Super Andrija", *SUPER_ANDRIJA, "", ""),
             ("Mamutica", *MAMUTICA, "", ""), ("Muzej suvremene umjetnosti", *MSU, "", "")],
    route=dict(label=("Most slobode, 1959", "Most slobode, 1959."),
               coords=[(45.7935, 15.9796), (45.7895, 15.9796), (45.7865, 15.9797), (45.7835, 15.9798), (45.7800, 15.9799)]),
    beats=[
        beat(1950, (45.7850, 15.9760), 350, 2600, 1500,
             "Novi Zagreb is the part of the city south of the Sava. Building there began in the 1950s, under mayor Većeslav Holjevac.",
             "Novi Zagreb dio je grada južno od Save. Gradnja je ondje počela 1950-ih, za gradonačelnika Većeslava Holjevca.",
             [("Novi Zagreb is the part of Zagreb south of the Sava", ["Novi Zagreb"]),
              ("building of new estates south of the Sava began in the 1950s under mayor Holjevac", ["Novi Zagreb (hr)"])], secs=9),
        beat(1959, BRIDGE, 275, 650, 380,
             "The Bridge of Freedom, by Krunoslav Tonković, opened on 2 September 1959. It carries the avenue that now bears Holjevac's name.",
             "Most slobode, djelo Krunoslava Tonkovića, otvoren je 2. rujna 1959. Njime prolazi avenija koja danas nosi Holjevčevo ime.",
             [("opened to traffic 2 September 1959; designer Krunoslav Tonković; Avenija Većeslava Holjevca runs over it", ["Most slobode (hr)"])],
             secs=9, photo=("Most Slobode.jpg", "The Bridge of Freedom from the northern embankment", "Most slobode sa sjevernog nasipa")),
        beat(1964, FAIR, 340, 900, 520,
             "Holjevac moved the Zagreb Fair to the meadows across the river. The City's register dates the fair grounds 1955 to 1964.",
             "Holjevac je Zagrebački velesajam preselio na livade preko Save. Gradski registar datira velesajam od 1955. do 1964.",
             [("1955 mayor Holjevac decided to move the fair to the meadows across the Sava", ["Zagrebački velesajam (hr)"]),
              ("KULTURA_ZASTITA Z-2951, Zagrebački velesajam, datacija 1955.-64.", ["Grad Zagreb, KULTURA_ZASTITA"])],
             secs=9, photo=("Zagreb Fair 01.jpg", "A concrete shell sculpture in the fair grounds", "Betonska ljuska, skulptura na prostoru Velesajma")),
        beat(1973, SUPER_ANDRIJA, 330, 520, 310,
             "In Siget, Super Andrija by Miroslav Cantinelli was built in 1973. It has 14 floors and 488 flats.",
             "U Sigetu je 1973. izgrađen Super Andrija, djelo Miroslava Cantinellija. Ima 14 katova i 488 stanova.",
             [("in Siget, Novi Zagreb; built early 1973; architect Miroslav Cantinelli; 14 floors, 488 flats", ["Super Andrija (hr)"]),
              ("card year 1973", ["landmark card"])]),
        beat(1974, MAMUTICA, 300, 680, 400,
             "Mamutica in Travno followed in 1974. It is about 240 metres long and 60 metres high, and about 5,000 people live in it.",
             "Mamutica u Travnom slijedila je 1974. Duga je oko 240 metara, visoka 60 metara, a u njoj živi oko 5000 ljudi.",
             [("built 1974 in Travno; about 240 m long, 60 m high; home to about 5,000 people", ["Mamutica"]), ("card year 1974", ["landmark card"])],
             secs=9, photo=("Mamutica Zagreb 20110620 2877.jpg", "Mamutica seen from the west", "Mamutica sa zapada")),
        beat(2009, MSU, 330, 470, 280,
             "The Museum of Contemporary Art moved here, into a new building by Igor Franić. It opened on 11 December 2009.",
             "Muzej suvremene umjetnosti preselio je ovamo, u novu zgradu Igora Franića. Otvorena je 11. prosinca 2009.",
             [("new building by Igor Franić at Dubrovnik and Holjevac avenues; opened 11 December 2009", ["Museum of Contemporary Art"]),
              ("card year 2009, Igor Franić", ["landmark card"])],
             photo=("Msu-museum-contemporary-art-zagreb.jpg", "The Museum of Contemporary Art", "Muzej suvremene umjetnosti")),
        beat(2026, (45.7800, 15.9750), 350, 3000, 1700,
             "Most buildings south of the Sava have no year on this map yet, so they appear only when the timeline reaches today.",
             "Većina zgrada južno od Save na ovoj karti još nema godinu, pa se pojavljuju tek kad vremenska crta dođe do danas.",
             [("within 1.5 km of 45.775 N 15.955 E, 219 of 6,477 buildings are dated; within 1.5 km of 45.775 N 15.99 E, 251 of 1,974", ["this map's data"])], secs=9),
    ])


def write_csv(path: Path, header: list[str], rows: list[list]):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def main():
    md = ["# Sources for the Zagreb stories", "",
          "Generated by engine/scripts/scenes/zagreb_scenes.py. Every caption claim with the source that states it.",
          "'landmark card' = data/landmarks/landmarks.json (the map's own cards); captions agree with its years and architects.",
          "'this map's data' = counts from engine/data/years.parquet (build v20261021-years2).",
          "Where sources disagree, the caption avoids the disputed detail (noted below).", ""]
    for sid, sc in SCENES.items():
        rows = []
        for i, b in enumerate(sc["beats"], 1):
            (clat, clon, h), (tlat, tlon) = b["cam"], b["target"]
            p = b["photo"] or ("", "", "")
            rows.append([i, clat, clon, h, tlat, tlon, b["year"], b["en"], b["hr"], "; ".join(b["sources"]), *p])
            for t in (b["en"], b["hr"]):
                assert "\u2013" not in t and "\u2014" not in t, f"{sid} beat {i}: dash in caption"
        write_csv(OUT / sid / "beats.csv", ["beat", "camera_lat", "camera_lon", "camera_height_m", "target_lat", "target_lon",
                                            "timeline_year", "caption_en", "caption_sv", "sources", "photo_file",
                                            "photo_caption_en", "photo_caption_sv"], rows)
        write_csv(OUT / sid / "narration.csv", ["beat", "target_seconds"], [[i, b["secs"]] for i, b in enumerate(sc["beats"], 1)])
        write_csv(OUT / sid / "markers.csv", ["name", "lat", "lon", "label_en", "label_sv"], [list(m) for m in sc["markers"]])
        if "route" in sc:
            write_csv(OUT / sid / "route.csv", ["lat", "lon"], [list(c) for c in sc["route"]["coords"]])
        n_claims = sum(len(b["claims"]) for b in sc["beats"])
        md += [f"## {sid}: {sc['title'][0]} / {sc['title'][1]}", "", f"{len(sc['beats'])} beats, {n_claims} claims.", ""]
        for i, b in enumerate(sc["beats"], 1):
            md.append(f"**Beat {i} ({b['year']})**: {b['en']}")
            md.append(f"*HR*: {b['hr']}")
            for claim, ks in b["claims"]:
                md.append(f"- {claim}: " + "; ".join(f"[{k}]({S[k]})" if S[k].startswith("http") else f"{k} ({S[k]})" for k in ks))
            if b["photo"]:
                md.append(f"- photo: [File:{b['photo'][0]}](https://commons.wikimedia.org/wiki/File:{b['photo'][0].replace(' ', '_')})")
            md.append("")
    md += ["## Disagreements left out of the captions", "",
           "- 1880 earthquake deaths: en Wikipedia says one, hr Wikipedia says two. No caption mentions deaths.",
           "- Cathedral rebuild end: en Wikipedia 1902, hr Wikipedia 1906; the card shows 1902. The caption gives no end year.",
           "- Croatian National Theatre opening day: en Wikipedia 14 November 1895, hr Wikipedia 14 October 1895. The caption says 1895 only.",
           "- Zagreb Fair move: en Zagreb Fair 1956, en Novi Zagreb 1953, hr Velesajam decision 1955 and first fair there 1956. The caption gives no move year; the register dating (1955 to 1964) drives the map.",
           "- Željeznička kolonija: the City register dates it 1923 (the plan); Radović 1992 says built by 1927. The caption says both.", ""]
    (PROJECT / "docs").mkdir(exist_ok=True)
    (PROJECT / "docs" / "scenes-sources.md").write_text("\n".join(md), encoding="utf-8")
    for sid, sc in SCENES.items():
        print(sid, len(sc["beats"]), "beats,", sum(len(b["claims"]) for b in sc["beats"]), "claims")


if __name__ == "__main__":
    main()
