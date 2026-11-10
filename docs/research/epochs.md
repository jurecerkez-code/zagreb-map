# Historical orthophoto epochs for Zagreb

Research completed 2026-11-08. This is an evidence-gated spike, not a building-date classifier.

## Decision: `needs-human`

DGU 2011 and 2018 have real, public WMS imagery with an explicit Croatian Open Licence.[1][2] Two actual matching-bbox PNGs were retrieved and decoded.[1] Their image evidence is not a citywide validation set and is insufficient to justify publishing a construction epoch or a precision number.[unverified]

**Stop at the spike. No `EPOCH` class, production year change, or precision claim is made.** The next step requires a reproducible cache of usable imagery over the dated reference buildings, balanced spatial blocks, and measured precision of at least 90% in every proposed published class. A later result that fails that test also stops.[11]

## 1. Availability and licence, independently checked

| Product | Actual public response | Licence and attribution evidence |
|---|---|---|
| **DGU DOF5 2011** | Anonymous WMS 1.3.0, `OrthoImagery`, 1:5000 for the whole Republic of Croatia, whose service description names 10,945 sheets. A licensed 256×256 PNG at `bbox=15.9795,45.8100,15.9805,45.8110` was read and decoded.[1] | Capabilities say: “Na mrežnu uslugu i podatke primjenjuju se uvjeti korištenja navedeni pod otvorenom dozvolom dostupnom na poveznici https://data.gov.hr/otvorena-dozvola.” CSW resource creation: **2011-06-21**; metadata `dateStamp`: **2026-09-09**.[3] NIPP source `0004` was included **2013-05-18**.[5] |
| **DGU DOF5 2018** | Anonymous WMS 1.3.0, `OI.OrthoImagery`, 2018 imagery for the western 50% of Croatia, in RGB and CIR. Zagreb is within the published extent. A matching 256×256 PNG was read and decoded.[2] | Capabilities contain the same explicit Open Licence statement.[2] CSW resource creation: **2018-09-06**; metadata `dateStamp`: **2026-03-31**.[4] NIPP source `0419` was included **2019-05-30**.[6] |

The official DGU asset list separately describes `Ortofoto` as `slobodan` and `Otvorena dozvola RH`.[7] National licensing guidance permits reproduction, redistribution and adaptation with attribution; it does not let the map imply institutional endorsement.[8] Nothing here treats Open Licence as CC BY 4.0 or transfers that licence to unrelated City imagery.

For attribution, keep the product URL, author, extraction date and the metadata dates above, which are deliberately not conflated with survey dates. Preserve the Croatian credit `Sadrži informacije tijela javne vlasti u skladu s Otvorenom dozvolom` and the licence link. Disclose clipping, reprojection, image classification or other alteration when used. These are requirements for later implementation, not authorization to publish now.[7][8]

The legacy `xml.metadata.get` references initially redirected to a portal HTML page. Public CSW was then queried directly for the actual ISO metadata records linked above. That HTML redirect was not treated as proof of last-revision metadata.[3][4]

## 2. Feasibility check actually performed

The same spatial request was made for each DGU epoch:[1][2]

```text
CRS=CRS:84
BBOX=15.9795,45.8100,15.9805,45.8110
WIDTH=256
HEIGHT=256
FORMAT=image/png
TRANSPARENT=TRUE
```

The 2011 request returned `image/png`, 131,946 bytes, SHA-256 `08eb29396d14d20cf99a782fc1bf07964fac4c1dd090ade1960f919e6023daf6`, matching the small previous sample.[1] DGU 2018 returned 135,602 bytes, SHA-256 `54a6b6c48a7a23311acf6d2005f66717e613a289ea1df875da0fc8972f846cac`.[2] Different hashes and image statistics establish two different real images, not one image with two labels. Both decode as RGBA PNGs of 256×256 pixels. The bbox’s approximate local pitch is **0.61 m/pixel east–west and 0.87 m/pixel north–south**, not an asserted universal/native tile resolution or a per-building validation sample.[1][2]

This patch does not establish roof-presence classification quality, enough independent spatial blocks, or complete access to the dated validation table. Opening the cached footprint file failed intermittently, so the headline **4,401** figure was not substituted for a completed held-out result. These two tiles do not justify a bulk download and citywide classifier during the constrained task.[unverified]

### What works

- Both endpoints are anonymous and public; no account or auth-key was requested.[1][2]
- Their explicit licence permits the sample retrieval and simple decoding above.[7][8]
- CSW gives machine-readable creation dates and metadata timestamps for traceability.[3][4]

### What prevents the classifier[11]

- There is no reproducible full-city/cache manifest established by this check.[unverified]
- One small matched patch is not an independent spatial training/test set and cannot demonstrate per-class precision.[unverified]
- Gradient energy and roof-colour variance are observations, not proof of a construction year: a roof can change without rebuilding and a footprint can be added to a standing building.[unverified]

## 3. Other historical products and bounds

DOF68 covers pre-1968 photography in NIPP. Its registry exposes TFW/TIFF; the guessed anonymous endpoint `/services/inspire/orthophoto_1968/wms?service=WMS&request=GetCapabilities` returned **HTTP 404**. No validated public WMS/reuse-and-download path was established, so no DOF68 imagery was processed.[9] This is an unresolved access and validation gate, not an independently verified prohibition on every historical use. Terms described as “fee” in an earlier note were not independently established and are not relied on here.[9]

NIPP source `0066` describes the City’s older orthophoto series. Its access statement does not independently establish the required licence for derived classification, so that service was not silently inherited into the DGU sample.[10] Museum aerial photographs can support individually sourced captions, not a validated reproducible bulk training set in this check.[unverified] Post-earthquake DOF1 was not evaluated after the selected two-epoch gate failed; no inference follows from that omission.[unverified]

## 4. Required validation before any production proposal[11]

1. Assemble and cache both licensed epochs for every dated reference footprint, recording request, response digest, geometry projection, native resolution, source modification metadata and coverage.[11]
2. Compute gradient energy and roof-colour variance inside each footprint and in a **3 m external buffer**. Keep real masks and null observations; do not substitute smooth synthetic patches or estimated substitute images.[11]
3. Hold out spatial blocks for training and threshold tests. Preserve enough **balanced** blocks to measure each proposed class, rather than applying ZBSM bounds and treating bounded observations as training targets.
4. Measure **precision separately for each proposed published class**, with image counts, false positives and abstentions. Require **≥90% precision in every published class** before human data review.
5. Only after passing, propose an `EPOCH` class with its method and attribution. No production migration or `current.json` change belongs to this spike.[11]

The current run is not validated and publishes no classes.[11] A subsequent feasibility failure again ends here.[11]

## Sources

[1] https://geoportal.dgu.hr/services/inspire/orthophoto_2011/wms?service=WMS&request=GetCapabilities — DGU DOF5 2011 WMS capabilities
    > "Na mrežnu uslugu i podatke primjenjuju se uvjeti korištenja navedeni pod otvorenom dozvolom dostupnom na poveznici https://data.gov.hr/otvorena-dozvola."
[2] https://geoportal.dgu.hr/services/inspire/orthophoto_2018/wms?service=WMS&request=GetCapabilities — DGU DOF5 2018 WMS capabilities
    > "Na mrežnu uslugu i podatke primjenjuju se uvjeti korištenja navedeni pod otvorenom dozvolom dostupnom na poveznici https://data.gov.hr/otvorena-dozvola."
[3] https://geoportal.nipp.hr/geonetwork/srv/eng/csw?service=CSW&request=GetRecordById&version=2.0.2&elementSetName=full&id=cf462f57-d94c-415c-9770-e6e0e00bc7ba&outputSchema=http://www.isotc211.org/2005/gmd — DGU 2011 CSW metadata
    > "Uvjeti korištenja podataka za ponovnu uporabu u skladu su s otvorenom dozvolom dostupnom na poveznici: https://data.gov.hr/otvorena-dozvola"
[4] https://geoportal.nipp.hr/geonetwork/srv/eng/csw?service=CSW&request=GetRecordById&version=2.0.2&elementSetName=full&id=fee8deac-82e4-44f6-966a-3546bd14c3be&outputSchema=http://www.isotc211.org/2005/gmd — DGU 2018 CSW metadata
    > "Uvjeti korištenja podataka za ponovnu uporabu u skladu su s otvorenom dozvolom dostupnom na poveznici: https://data.gov.hr/otvorena-dozvola."
[5] https://registri.nipp.hr/izvori/4 — NIPP source 0004: DGU 2011 WMS
    > "Digitalni ortofoto 2011. – WMS za anonimne korisnike | Registri NIPP-a"
[6] https://registri.nipp.hr/izvori/431 — NIPP source 0419: DGU 2018 WMS
    > "Digitalni ortofoto 2018. – WMS za anonimne korisnike | Registri NIPP-a"
[7] https://dgu.gov.hr/UserDocsImages/dokumenti/Pristup%20informacijama/Otvoreni%20podaci/Asset%20lista%20-%20DGU.xlsx — DGU asset list
    > "Otvorena dozvola RH"
[8] https://www.dziv.hr/hr/pristup-informacijama/otvoreni-podaci — Croatian Open Licence: reproduction, redistribution and adaptation
    > "Otvorena dozvola omogućava korisnicima slobodnu uporabu informacija, u komercijalnu ili nekomercijalnu svrhu koja uključuje umnožavanje (reproduciranje), distribuiranje, stavljanje na raspolaganje trećima te izmjene, prilagođavanje i drugo"
[9] https://registri.nipp.hr/izvori/453 — NIPP source 0456: DOF68
    > "DOF68 izrađen na osnovi aerofotogrametrijskih snimaka nastalih u razdoblju 1950-1968."
[10] https://registri.nipp.hr/izvori/66 — NIPP source 0066: City historical orthophoto series
    > "Nema uvjeta za pristup i korištenje"
[11] https://github.com/jurecerkez-code/zagreb-map/issues/35 — #35 validation and stop conditions
    > "publish only classes with ≥ 90% precision"
