Feature: Trams are real vehicles on real rails
  Source: ZET GTFS static and realtime, Croatian Open Licence. Rails: OpenStreetMap
  railway=tram. A tram is a TMK 2200, 32 m by 2.3 m by 3.4 m, 140 of them in Zagreb.

  @check:env -u PLAYWRIGHT_BROWSERS_PATH node scripts/trams_check.mjs
  Scenario: Every scheduled tram sits on its own shape
    Given the build for today
    When I place every running trip at 08:00, 12:00, 15:30 and 22:00
    Then every position is a finite point inside the city
    And the distance from the shape is 0 metres for every trip
    And the number running is between 99 and 168

  @check:curl -s https://zet.hr/gtfs-rt-protobuf -o /tmp/rt.pb -w "%{http_code} %{size_download}\n"
  Scenario: The live feed answers
    Given the realtime endpoint
    When I fetch it without credentials
    Then it returns 200
    And the payload is larger than 50 KB

  @check:env -u PLAYWRIGHT_BROWSERS_PATH node scripts/trams_probe.mjs
  Scenario: Hovering a visible tram names it
    Given the map open at street level over a tram
    And the tram is not behind a building
    When the pointer rests on it
    Then the tooltip shows the line number
    And it shows the direction, which is the trip headsign
    And it shows the next stop
    And it says whether the position is live or the timetable

  @manual
  Scenario: A tram behind a building shows nothing
    Given a tram that a building hides
    When the pointer rests on its hidden pixels
    Then no tooltip appears
