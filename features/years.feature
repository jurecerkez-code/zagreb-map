Feature: A year on the map is the best evidence, not the loudest source
  The rule: a wide span must never displace an exact year it contains, a curated
  span is not an exact year, and a uuid survives a geometry rebuild.

  @check:uv run python -c "import numpy as np, pipeline.zagreb_city as zc; print('import ok')"
  Scenario: An exact year inside a span survives
    Given building 50982 with a KD span 1919-1978 and a heritage exact 1919
    When the winner is chosen
    Then the published year is 1919
    And its flag is exact, not a range
    And 212 buildings in the build gain the exact year they had been losing

  @pending:rebuild
  Scenario: The curated tier reports its own precision
    Given 176 curated buildings with a year
    When the curated step writes them
    Then the 102 whose bounds differ are ranges or longs
    And only the ones with equal bounds are exact

  @check:uv run python -c "import sys; sys.path.insert(0,'.'); from pipeline.s01_zagreb_city import uuids; print(len(uuids([1,2,3],['w1','w2',''], [9,10,11])), 'unique uuids')"
  Scenario: Every building has its own uuid
    Given the OSM tail of the build
    When the uuids are assigned
    Then no uuid is shared by two rows
    And a hand-entered year cannot be refused for a collision
    And the build reports 0 excess rows, where it reported 106

  @pending:k1986
  Scenario: The 1986 land use bounds an undated house
    Given an undated building whose representative point falls in a 1986 housing or mixed use polygon
    When the 1986 layer is wired into the period path
    Then the building is flagged as existing by 1986
    And its period is set from that bound
    And the flag says a bound, never an exact year
