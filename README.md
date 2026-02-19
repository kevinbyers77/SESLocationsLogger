# SES Locations

Mobile-first PWA with two entry points on the same GitHub Pages site:

- Viewer (public, read-only): `/index.html`
- Logger (shared with trusted users): `/logger.html`

## Modes

### Viewer (`/index.html`)
- Map + List only
- GET only
- No logging UI
- No settings UI
- No token in page

### Logger (`/logger.html`)
- Map + List + `+ Log`
- GET + POST
- Write token embedded in logger page config
- No settings UI
- Offline queue with `Sync` and pending count

## Backend contract

Base endpoint:

`https://script.google.com/macros/s/AKfycbxSOQig4m5igbKtpX9ueXMMLB_GPGqUu1q1yv3BqKS8xZ5oV8fsgZMY6nQVDHIcckSK/exec`

### GET

`GET {backendUrl}`

Expected response:

```json
{
  "items": [
    {
      "id": "abc123",
      "createdAt": "2026-02-19T05:55:00.000Z",
      "category": "Drain",
      "name": "Blocked culvert",
      "description": "Leaves and debris buildup",
      "lat": -28.8125,
      "lng": 153.277,
      "accuracy": 8,
      "createdBy": "field-team"
    }
  ]
}
```

### POST

`POST {backendUrl}?token=API_TOKEN`

Request body is a JSON item:

```json
{
  "id": "client-id",
  "createdAt": "2026-02-19T05:56:00.000Z",
  "category": "Drain",
  "name": "Blocked culvert",
  "description": "Leaves and debris buildup",
  "lat": -28.8125,
  "lng": 153.277,
  "accuracy": 8,
  "createdBy": ""
}
```

Expected response:

```json
{
  "ok": true,
  "item": {
    "id": "server-id-1"
  }
}
```

Notes:
- Logger queues failed POSTs in IndexedDB when offline.
- `Sync` retries queued items.

## Local run

```bash
python3 -m http.server 8080
```

Open:
- Viewer: `http://localhost:8080/index.html`
- Logger: `http://localhost:8080/logger.html`

## GitHub Pages deploy

1. Push this folder to your GitHub repository.
2. In GitHub: `Settings` -> `Pages`.
3. Under **Build and deployment**:
   - Source: `Deploy from a branch`
   - Branch: `main` (or your branch), folder: `/ (root)`.
4. Save and wait for Pages to publish.
5. Use:
   - `https://<your-user>.github.io/<repo>/index.html`
   - `https://<your-user>.github.io/<repo>/logger.html`
