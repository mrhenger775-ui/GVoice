# LiveKit Self-Hosted (Russia) for GVoice

This setup runs LiveKit SFU on your own server so screen sharing is stable for your users.

## 1. Files

Use:

- `infra/livekit/docker-compose.livekit.yml`
- `infra/livekit/livekit.yaml`
- `infra/livekit/turnserver.conf`

## 2. Edit config before start

Update `infra/livekit/livekit.yaml`:

1. Replace:
   - `LK_REPLACE_API_KEY`
   - `LK_REPLACE_API_SECRET`
2. Set domain:
   - `turn.domain: livekit.gvoice.online` (or your real subdomain)

Update `infra/livekit/turnserver.conf`:

1. `external-ip` to your server public IP.
2. `user=turnuser:turnpass` to your real TURN credentials.

## 3. DNS and ports

Create DNS record:

- `livekit.gvoice.online` -> your server IP

Open firewall:

- TCP: `7880`, `7881`
- UDP: `50000-50100`
- TURN: `3478` (UDP/TCP), `5349` (TCP)

## 4. Start SFU stack

From project root:

```bash
cd /var/www/GVoice/infra/livekit
docker compose -f docker-compose.livekit.yml up -d
docker compose -f docker-compose.livekit.yml ps
```

## 5. Point GVoice backend to self-hosted LiveKit

In `/var/www/GVoice/backend/.env` set:

```env
LIVEKIT_URL="wss://livekit.gvoice.online"
LIVEKIT_API_KEY="YOUR_KEY"
LIVEKIT_API_SECRET="YOUR_SECRET"
```

Then rebuild/restart backend:

```bash
cd /var/www/GVoice
npm run build --workspace backend
pm2 restart all
```

## 6. Optional: TURN for legacy P2P voice path

If you keep old P2P voice path in parallel, set in `/var/www/GVoice/backend/.env`:

```env
VOICE_TURN_URLS="turn:livekit.gvoice.online:3478?transport=udp,turn:livekit.gvoice.online:3478?transport=tcp"
VOICE_TURN_USERNAME="turnuser"
VOICE_TURN_PASSWORD="turnpass"
```

And restart backend again.

## 7. Validate

1. Two users join same voice channel.
2. Both should show `LiveKit: connected`.
3. Each user starts screen share one by one.
4. Both must see each other share.
