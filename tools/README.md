# Bilder aus der Seite erzeugen

`render.mjs` holt die englische Fassung von `jevtic.dev`, kürzt sie und erzeugt daraus die Bilder in `assets/`. Die Action in `.github/workflows/update.yml` führt das täglich aus und rendert nur, wenn sich die Seite geändert hat. Unter **Actions > Update profile images > Run workflow** geht es sofort, mit `force` auch ohne Änderung.

`LEAVE_OUT` in `render.mjs` nennt Einträge, die auf der Seite stehen, hier aber nicht. `cdp.mjs` stammt aus `scripts/checks/` der Seite.
