# GVoice Server Deploy (Nginx + PM2)

## 1) Upload files to server

Upload project to:

- `/var/www/GVoice`

Minimum required files/folders:

- `/var/www/GVoice/backend`
- `/var/www/GVoice/frontend`
- `/var/www/GVoice/shared`
- `/var/www/GVoice/infra/nginx/gvoice.online.conf`
- `/var/www/GVoice/infra/nginx/livekit.gvoice.online.conf`
- `/var/www/GVoice/package.json`
- `/var/www/GVoice/package-lock.json`

Do not upload:

- `node_modules`
- `.git`
- `desktop-dist`

## 2) Install and build

```bash
cd /var/www/GVoice
npm ci
cp backend/.env.example backend/.env
nano backend/.env
npm run prisma:generate --workspace backend
npm run db:init --workspace backend
npm run build
```

## 3) Frontend production env

Create file `/var/www/GVoice/frontend/.env.production`:

```env
VITE_API_URL=https://gvoice.online/api
```

Then rebuild frontend:

```bash
cd /var/www/GVoice
npm run build --workspace frontend
```

## 4) Run backend with PM2

```bash
cd /var/www/GVoice
pm2 start backend/dist/main.js --name gvoice-backend
pm2 save
pm2 startup
```

## 5) Install nginx config

```bash
sudo cp /var/www/GVoice/infra/nginx/gvoice.online.conf /etc/nginx/sites-available/gvoice.online.conf
sudo cp /var/www/GVoice/infra/nginx/livekit.gvoice.online.conf /etc/nginx/sites-available/livekit.gvoice.online.conf
sudo ln -sf /etc/nginx/sites-available/gvoice.online.conf /etc/nginx/sites-enabled/gvoice.online.conf
sudo ln -sf /etc/nginx/sites-available/livekit.gvoice.online.conf /etc/nginx/sites-enabled/livekit.gvoice.online.conf
sudo nginx -t
sudo systemctl reload nginx
```

## 6) SSL certificates

If certs are missing, issue them:

```bash
sudo certbot --nginx -d gvoice.online -d www.gvoice.online
sudo certbot --nginx -d livekit.gvoice.online
```

## 7) Required backend env values

In `/var/www/GVoice/backend/.env` set at least:

```env
FRONTEND_ORIGIN="https://gvoice.online"
REFRESH_COOKIE_SECURE="true"
REFRESH_COOKIE_SAMESITE="none"
REFRESH_COOKIE_DOMAIN=".gvoice.online"
PORT="4000"
JWT_ACCESS_SECRET="replace-with-strong-secret"
JWT_REFRESH_SECRET="replace-with-strong-secret"
```

If LiveKit enabled:

```env
LIVEKIT_URL="wss://livekit.gvoice.online"
LIVEKIT_API_KEY="YOUR_KEY"
LIVEKIT_API_SECRET="YOUR_SECRET"
```
