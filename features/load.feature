Feature: The map loads fast enough to use on a phone
  Measured on the dev server against the live version. These are budgets, not hopes:
  a scenario fails when the number goes above the line.

  @check:node scripts/load_probe.mjs
  Scenario: First load stays under the byte budget
    When the page loads with a cold cache
    Then the total transferred bytes are under 20 MB
    And city_height.bin.gz is under 5.5 MB
    And attrs.bin.gz is not requested before the map is revealed

  @check:manual:throttle
  Scenario: A slow connection still shows the city
    Given a 1.6 Mbit/s link with 150 ms latency
    When the page loads
    Then the loader percentage is above zero by 20 seconds
    And the city is visible before 60 seconds

  @check:manual:hover
  Scenario: A parked pointer costs nothing
    Given the map open and the pointer resting on it
    When three seconds pass without a movement
    Then no long task over 50 ms runs
    And the frame count is at least 45
