Feature: the streets
  The street layer is OSM ways drawn as ribbons: a carriageway, a kerb band and a pavement either side. It is the
  ground a tram ride happens on, so it has to be visible, correctly coloured, and wound so three.js does not cull it.

  Background:
    Given the city is built from OpenStreetMap ways
    And the data version in web/data/current.json

  @check: uv run python scripts/checks/streets.py
  Scenario: the street ribbon is wound so its face looks up
    Given a ribbon of two vertices per point
    Then its triangles are counter clockwise seen from above
    And no street material relies on DoubleSide to be seen

  @manual
  Scenario: a ride runs on a street, not on grass
    Given a live tram
    When I press Vozim se
    Then the tram stands on asphalt with the rails set into it
    And there is a kerb and a pavement on both sides
    And the buildings either side show windows
    # Proof: C:/Users/jurec/AppData/Local/hermes/cache/scratch/ride_fixed.png, taken 4.11.2026 on the local build.
    # To redo it: ride the tram nearest 500,500 and photograph the frame.

  @check: uv run python scripts/checks/streets.py
  Scenario: the colours are the measured ones
    Given the reference imagery of Donji grad and Ilica
    Then the asphalt is #4f5450
    And the kerb side pavement is #8d908e
