# Realtime Events (Socket.IO)

## Client -> Server
- `workspace:join` `{ workspaceId: string }`
- `channel:join` `{ channelId: string }`
- `chat:send` `{ channelId: string, body: string, clientMsgId?: string }`
- `typing:start` `{ channelId: string }`
- `typing:stop` `{ channelId: string }`

## Server -> Client
- `chat:message` `{ id, channelId, authorId, body, createdAt }`
- `chat:ack` `{ clientMsgId, messageId }`
- `typing:update` `{ channelId, userId, isTyping }`
- `presence:update` `{ userId, status }`
- `error` `{ code, message }`
