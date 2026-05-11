# GVoice MVP Architecture

## 1) Scope (MVP)
- Auth: register/login/refresh/logout.
- Workspaces (Discord-like servers).
- Text channels.
- Realtime text messages via Socket.IO.
- Roles: owner/admin/member.

## 2) High-level components
- `frontend` (React + Vite): UI for auth, workspace list, channel list, chat stream.
- `backend` (Express + Socket.IO): REST API + realtime gateway.
- `postgres` (planned): persistent data storage.
- `shared`: DTO and event types used by frontend/backend.

## 3) Module boundaries (backend)
- `auth`: account lifecycle, JWT pair (access + refresh).
- `workspace`: workspace CRUD and membership checks.
- `channel`: channel CRUD and access control.
- `message`: create/read messages and pagination.
- `realtime`: socket auth, room join, message broadcast.

## 4) Security baseline
- Password hashing: Argon2id.
- Access token: 15 min TTL.
- Refresh token: 30 days, rotation on refresh.
- Workspace/channel actions allowed only for members.

## 5) Delivery order
1. DB + Prisma models.
2. Auth REST.
3. Workspace/channel REST.
4. Message REST + Socket.IO.
5. Roles/permissions hardening.
