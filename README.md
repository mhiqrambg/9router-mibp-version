# 9Router MIBP Version

A local AI routing gateway with provider fallback and token-saving features. This is a fork of [decolua/9router](https://github.com/decolua/9router).

## Installation

### Option 1: Docker

Pull the image:

```bash
docker pull mhiqrambhrng/9router-mibp-version:latest
```

Run the container:

```bash
mkdir -p 9router-data
docker run -d \
  --name 9router \
  -p 127.0.0.1:20128:20128 \
  -v 9router-data:/app/data \
  -e DATA_DIR=/app/data \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -e NODE_ENV=production \
  -e JWT_SECRET=<generate-with-openssl-rand-hex-32> \
  -e INITIAL_PASSWORD=<your-dashboard-password> \
  -e API_KEY_SECRET=<generate-with-openssl-rand-hex-32> \
  -e MACHINE_ID_SALT=<generate-with-openssl-rand-hex-32> \
  mhiqrambhrng/9router-mibp-version:latest
```

Or using Docker Compose (a `docker-compose.yml` is included in this repo):

```bash
cp .env.example .env   # fill in JWT_SECRET, INITIAL_PASSWORD, API_KEY_SECRET, MACHINE_ID_SALT
docker compose up -d
```

Dashboard opens at `http://localhost:20128/dashboard`. The container port is
published to loopback only (`127.0.0.1`); set `HOST_BIND=0.0.0.0` in `.env` only
behind an authenticating reverse proxy — the dashboard is a full admin surface.

### Option 2: Manual (from source)

Requirements: Node.js 22 or newer.

```bash
git clone https://github.com/mhiqrambg/9router-mibp-version.git
cd 9router-mibp-version

cp .env.example .env
# Edit .env: set JWT_SECRET, INITIAL_PASSWORD, API_KEY_SECRET, MACHINE_ID_SALT

npm install

# Development server
npm run dev

# Or production build
npm run build
npm run start
```

Dashboard opens at `http://localhost:20127/dashboard` — `npm run start` and
`npm run dev` bind loopback only; set `HOSTNAME=0.0.0.0` to serve other
machines.

## More Information

- Upstream project: [https://github.com/decolua/9router](https://github.com/decolua/9router)
- Upstream docs: [DOCKER.md](DOCKER.md) • [ARCHITECTURE.md](docs/ARCHITECTURE.md)
