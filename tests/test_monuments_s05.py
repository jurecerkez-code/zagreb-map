import hashlib
import json
from collections import Counter

import pytest

from pipeline import s05_zagreb_monuments as s05


def monument(mid='node/one', **changes):
    m = dict(id=mid, name='A monument', name_en='A monument', kind='statue', x_3765=459370.1, y_3765=5074937.5,
             height_m=7.0, height_source='OSM', material='bronze', creators=[' sculptor '], direction=90.0,
             year=2008, ysrc='osm:start_date', yquote='start_date=2008', yurl='https://www.openstreetmap.org/node/1',
             year_sources=['start_date=2008'], wikidata='Q1', wikipedia={'hr': 'Spomen'},
             osm_tags={'inscription': 'Spomen', 'wikimedia_commons': 'Category:Spomen'},
             depicts={'gender': 'female'}, photo=None)
    m.update(changes)
    return m


def report_for(ms):
    dated = [m for m in ms if isinstance(m.get('year'), int) and not isinstance(m.get('year'), bool) and m['year'] > 0]
    photos = [m for m in ms if m.get('photo')]
    sb = [m for m in ms if m['kind'] in ('statue', 'bust')]
    sb_year = [m for m in dated if m in sb]
    sb_photo = [m for m in photos if m in sb]
    yr_min = (len(sb) * 70 + 99) // 100
    ph_min = (len(sb) * 75 + 99) // 100
    return {
        'issue': 31,
        'before': {'all': {'entries': len(ms), 'year': 0, 'photo': 0}},
        'after': {'all': {'entries': len(ms), 'year': len(dated), 'photo': len(photos)},
                  'statues_and_busts': {'entries': len(sb), 'year': len(sb_year), 'photo': len(sb_photo),
                                        'year_target_met': yr_min <= len(sb_year), 'photo_target_met': ph_min <= len(sb_photo)}},
        'source_rule_totals_verified': {'year_after': len(dated), 'photo_after': len(photos)},
        'targets_for_statues_and_busts': {'denominator': len(sb), 'year_target_min': yr_min, 'year_actual': len(sb_year),
                                          'year_gap': max(0, yr_min - len(sb_year)), 'year_met': yr_min <= len(sb_year),
                                          'photo_target_min': ph_min, 'photo_actual': len(sb_photo),
                                          'photo_gap': max(0, ph_min - len(sb_photo)), 'photo_met': ph_min <= len(sb_photo)},
        'conflicts': [{'name': 'Charlie Chaplin', 'kept_year': 2008, 'resolution': 'OSM value retained'}],
    }


def write_source(root, records, report=None):
    root.mkdir(parents=True)
    (root / 'monuments.json').write_text(json.dumps(records), encoding='utf-8')
    report = report_for(records) if report is None else report
    (root / 'monuments_report.json').write_text(json.dumps(report), encoding='utf-8')
    (root / 'verification.json').write_text(json.dumps({'ok': True, 'errors': []}), encoding='utf-8')
    return report


def test_compact_keeps_year_evidence_subject_and_commons_without_inventing_a_year():
    m = monument()
    out = s05.compact(m, 2.25)
    assert out['year'] == 2008
    assert out['ysrc'] == 'osm:start_date'
    assert out['yquote'] == 'start_date=2008'
    assert out['yurl'] == 'https://www.openstreetmap.org/node/1'
    assert out['depicts'] == {'gender': 'female'}
    assert out['commons'] == 'Category:Spomen'
    assert out['plinth'] == 2.25
    assert out['hsrc'] == 'OSM'

    ambiguous = s05.compact(monument(year='1960s'))
    assert 'year' not in ambiguous
    assert all(k not in ambiguous for k in ('ysrc', 'yquote', 'yurl'))
    digit_string = s05.compact(monument(year='1960'))
    assert digit_string['year'] == 1960
    assert isinstance(s05.compact(monument(year=True)).get('year'), type(None))

    with_photo = monument(photo={'key': 'one.jpg', 'file': 'photos/one.jpg', 'author': 'Author', 'licence': 'CC0',
                                 'licence_url': 'https://creativecommons.org/publicdomain/zero/1.0/',
                                 'source_page': 'https://commons.wikimedia.org/wiki/File:One.jpg', 'w': 1000, 'h': 1280,
                                 'title': 'One', 'rule': 'commons_p18'})
    compacted = s05.compact(with_photo)
    assert compacted['photo']['key'] == 'one.jpg'
    assert compacted['photo']['page'].startswith('https://commons.wikimedia.org/')


def test_source_selection_prefers_complete_work31_and_verifies_it(tmp_path):
    write_source(tmp_path / 'work31', [monument()])
    legacy = tmp_path / 'monuments.json'
    legacy.write_text(json.dumps([monument('node/old', year=None)]), encoding='utf-8')
    before = hashlib.sha256(legacy.read_bytes()).hexdigest()
    source, records, report, verification = s05.read_enrichment(tmp_path)
    assert source == tmp_path / 'work31'
    assert [m['id'] for m in records] == ['node/one']
    assert report['conflicts'][0]['kept_year'] == 2008
    assert verification['ok'] is True
    assert hashlib.sha256(legacy.read_bytes()).hexdigest() == before


def test_report_validation_checks_real_totals_rules_and_unmet_targets(tmp_path):
    records = [monument(), monument('node/two', kind='bust', year=None),
               monument('node/three', kind='sculpture', year=1900, ysrc='wikipedia_hr')]
    report = write_source(tmp_path / 'work31', records)
    source, _, report, verification = s05.read_enrichment(tmp_path)
    assert source.name == 'work31'
    assert report['after']['all']['year'] == 2
    assert report['targets_for_statues_and_busts']['year_gap'] == 1
    assert report['targets_for_statues_and_busts']['photo_gap'] == 2
    assert report['targets_for_statues_and_busts']['year_met'] is False
    assert verification['ok'] is True
    s05.validate_enrichment(records, report, verification)
    bad = json.loads(json.dumps(report))
    bad['after']['all']['year'] += 1
    with pytest.raises(ValueError, match='report.*year|year.*report'):
        s05.validate_enrichment(records, bad, verification)
    bad_rules = json.loads(json.dumps(report))
    bad_rules['source_rule_totals_verified']['year_after'] = 999
    with pytest.raises(ValueError, match='source rule'):
        s05.validate_enrichment(records, bad_rules, verification)


def test_explicit_output_copies_photos_and_report_without_switching_current(tmp_path, monkeypatch):
    source = tmp_path / 'work31'
    report = write_source(source, [monument(photo={'key': 'one.jpg', 'file': 'photos/one.jpg', 'author': 'Author', 'licence': 'CC0',
                                         'licence_url': 'https://creativecommons.org/publicdomain/zero/1.0/',
                                         'source_page': 'https://commons.wikimedia.org/wiki/File:One.jpg',
                                         'w': 1000, 'h': 1280, 'title': 'One', 'rule': 'commons_p18'})])
    (source / 'photos').mkdir()
    (source / 'photos' / 'one.jpg').write_bytes(b'verified fixture image bytes')
    photos = tmp_path / 'published-photos'
    monkeypatch.setattr(s05, 'PHOTOS', photos)
    monkeypatch.setattr(s05, 'plinths', lambda records: {})
    pointer = tmp_path / 'web' / 'data' / 'current.json'
    pointer.parent.mkdir(parents=True)
    pointer.write_text('{"version":"stay-here"}', encoding='utf-8')
    original = pointer.read_bytes()
    out = tmp_path / 'scratch-output'
    s05.main(['--source', str(source), '--out', str(out)])
    rows = json.loads((out / 'monuments.json').read_text(encoding='utf-8'))
    assert rows[0]['photo']['key'] == 'one.jpg'
    assert rows[0]['year'] == 2008
    assert json.loads((out / 'monuments_report.json').read_text(encoding='utf-8')) == report
    assert json.loads((out / 'monuments_report.json').read_text(encoding='utf-8'))['targets_for_statues_and_busts']['year_actual'] == 1
    assert (photos / 'one.jpg').read_bytes() == b'verified fixture image bytes'
    assert pointer.read_bytes() == original
    assert not (out / 'web' / 'data' / 'current.json').exists()
    with pytest.raises(SystemExit):
        s05.main(['--source', str(source), '--out', str(out), '--version', 'v20261108-test'])


def test_audit_writer_preserves_conflicts_and_unmet_coverage_without_a_build(tmp_path):
    records = [monument()]
    report = write_source(tmp_path / 'work31', records)
    original_bytes = (tmp_path / 'work31' / 'monuments.json').read_bytes()
    destination = tmp_path / 'report' / 'monuments_report.json'
    s05.write_audit_report(report, destination)
    assert json.loads(destination.read_text(encoding='utf-8')) == report
    assert report['conflicts'][0]['kept_year'] == 2008
    assert (tmp_path / 'work31' / 'monuments.json').read_bytes() == original_bytes
    assert not (tmp_path / 'web' / 'data').exists()


def test_real_work31_report_is_not_relabelled_as_complete():
    if not (s05.SRC / 'work31' / 'verification.json').exists():
        pytest.skip('issue 31 enrichment handoff is not included in the repository checkout')
    _, records, report, verification = s05.read_enrichment()
    assert len(records) == 421 and len({m['id'] for m in records}) == 421
    assert report['after']['all']['year'] == 156
    assert report['after']['all']['photo'] == 148
    assert report['after']['statues_and_busts']['year'] == 80
    assert report['after']['statues_and_busts']['photo'] == 86
    assert report['targets_for_statues_and_busts']['year_gap'] == 69
    assert report['targets_for_statues_and_busts']['photo_gap'] == 73
    assert report['targets_for_statues_and_busts']['year_met'] is False
    assert report['targets_for_statues_and_busts']['photo_met'] is False
    assert report['conflicts']['item_id'] == 'node/3043782033'
    assert report['conflicts']['existing_year'] == 2008
    assert '1983' in report['conflicts']['new_photo_description']
    assert next(m for m in records if m['id'] == 'node/3043782033')['year'] == 2008
    assert sum(m.get('photo') is not None for m in records) == 148
    assert Counter(m.get('photo_rule') for m in records if m.get('photo'))['commons_geosearch'] == 8
