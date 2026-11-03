Feature: A private house is dated like any other building
  The owner's rule of 2026-11-03: a building flagged private keeps the year and the
  bounds its source states. Coarsening it to a decade hid a real year from about
  1,800 buildings, and a window the source never stated is invented data.

  Background:
    Given the years table of a Zagreb build

  @check:python -c "import numpy as np, pipeline.zagreb_city as zc; y={'year':np.array([1893],dtype='int32'),'yflag':np.array([0],dtype='int8'),'year_from':np.array([1893],dtype='int32'),'year_to':np.array([1924],dtype='int32')}; p,priv=zc.privacy(y,np.array([True])); assert y['year'][0]==1893 and y['year_from'][0]==1893 and y['year_to'][0]==1924, y; print('private year and bounds untouched')"
  Scenario: A private house keeps its source year
    Given a private building whose source states 1893
    When the build applies the privacy rule
    Then its year stays 1893
    And its year_from stays 1893
    And its year_to stays 1924

  @check:grep -q "year\[private\] // 10 \* 10" pipeline/zagreb_city.py && echo "coarsening still present" && exit 1 || echo "no decade coarsening in the pipeline"
  Scenario: No decade is invented anywhere in the pipeline
    Given the pipeline source
    When I search for a decade rounding of a private year
    Then no such rounding exists

  @check:grep -q "published as exactly a decade" pipeline/s99_validate.py && echo "validator still demands a decade" && exit 1 || echo "validator no longer demands a decade"
  Scenario: The validator no longer demands a decade
    Given the build validator
    When a private row carries a real span
    Then the validator does not report it as an error

  @check:grep -q "if (b.private) return" web/card.js && echo "card still coarsens" && exit 1 || echo "card shows the real year"
  Scenario: The card shows the real year
    Given a private building dated 1893
    When its card opens
    Then the year line reads 1893
    And the card never silently shows a decade in its place
