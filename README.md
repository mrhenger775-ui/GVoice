# GVoice

Отдельный проект для Discord-подобного приложения.

## Стек
- Frontend: React + Vite + TypeScript
- Backend: Express + Socket.IO + Prisma
- DB (локально): SQLite

## Подготовка
1. Установить Node.js LTS.
2. Скопировать env:
   - `copy backend\.env.example backend\.env`

## Prisma
1. `npm.cmd run prisma:generate --workspace backend`
2. `npm.cmd run db:init --workspace backend`

## Запуск
1. `npm.cmd run dev:backend`
2. Во втором терминале: `npm.cmd run dev:frontend`

## Готовые эндпоинты MVP
- `GET /health`
- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /users/me`
- `GET /workspaces`
- `POST /workspaces`
- `GET /workspaces/:workspaceId/channels`
- `POST /workspaces/:workspaceId/channels`
- `GET /channels/:channelId/messages`
- `POST /channels/:channelId/messages`
