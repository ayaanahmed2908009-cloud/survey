# Project Paani Survey

Two password-protected pages:

- `/survey` — students enter the household survey, the family's coordinates and a family photo.
- `/map` — map of every surveyed household (click a dot for its answers and photo), the water well
  labelled, distance from each household to the well, and a CSV download of all data.

## Run

Requires Node 20.12 or newer.

Copy `.env.example` to `.env` and set the two passwords in it, then:

    npm install
    npm start

`.env` is never committed to git. Settings can also be given as environment variables instead.

The browser asks for a password; any username works. Students only get `SURVEY_PASSWORD`, so they
cannot see the map or other families' data.

| Variable          | Meaning                                              |
|-------------------|------------------------------------------------------|
| `SURVEY_PASSWORD` | Password for `/survey`                               |
| `MAP_PASSWORD`    | Password for `/map`                                  |
| `WELL_LAT`        | Latitude of the well (placeholder default 27.514)    |
| `WELL_LNG`        | Longitude of the well (placeholder default 68.7905)  |
| `PORT`            | Port to listen on (default 3000)                     |
| `DATA_DIR`        | Where data is stored (default: Railway volume if attached, else `./data`) |

## Data

- `data/responses.jsonl` — one survey per line.
- `data/photos/` — family photos.

Back up the `data` folder regularly. When hosting, `DATA_DIR` must be on persistent storage.

The site must be served over HTTPS: phones only allow "Use current location" on HTTPS pages,
and Basic Auth passwords are only protected in transit over HTTPS.

## Deploying on Railway

1. New Project, Deploy from GitHub repo, pick this repo (`main` branch).
2. Variables tab: add `SURVEY_PASSWORD` and `MAP_PASSWORD`.
3. Right-click the service, Attach Volume, mount path `/data`. Survey data and photos are saved
   there automatically and survive redeploys.
4. Settings, Networking, Generate Domain. This gives an HTTPS address.
