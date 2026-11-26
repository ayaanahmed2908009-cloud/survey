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

## Copying surveys to Google Sheets

Every survey is also copied as a row into the Google Sheet "Project Paani Survey Data", and the
family photo is saved in the Drive folder "Project Paani Photos" (the row links to it). If Google
is unreachable, the copy is retried after the next survey and every 10 minutes. The map page shows
how many surveys are still waiting to be copied. The website's own data stays the main copy.

One-time setup:

1. Open the sheet, then Extensions, Apps Script.
2. Replace everything in `Code.gs` with `apps-script/Code.gs` from this repo, and set `SECRET` to a
   long random text. Save.
3. Deploy, New deployment, type Web app. Execute as: Me. Who has access: Anyone. Deploy, and allow
   the permissions Google asks for. Copy the Web app URL (ends in `/exec`).
4. On Railway, add variables `SHEETS_WEBHOOK_URL` (that URL) and `SHEETS_SECRET` (the same text as
   in step 2).

If you change `Code.gs` later, use Deploy, Manage deployments, edit, New version, so the URL stays
the same.
