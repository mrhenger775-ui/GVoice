import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const envPaths = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "backend/.env")];
for (const path of envPaths) {
  if (existsSync(path)) {
    dotenv.config({ path, override: false });
  }
}

const prisma = new PrismaClient();

const sqlStatements = [
  "PRAGMA foreign_keys = ON;",
  `CREATE TABLE IF NOT EXISTS "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "numeric_id" INTEGER UNIQUE,
    "email" TEXT NOT NULL UNIQUE,
    "phone" TEXT UNIQUE,
    "phone_verified_at" DATETIME,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "avatar_url" TEXT,
    "last_seen_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS "refresh_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "expires_at" DATETIME NOT NULL,
    "revoked_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "oauth_identities" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "provider_user_id" TEXT NOT NULL,
    "provider_email" TEXT,
    "access_token_encrypted" TEXT,
    "refresh_token_encrypted" TEXT,
    "provider_device_id" TEXT,
    "token_expires_at" DATETIME,
    "scope" TEXT,
    "friends_sync_enabled_at" DATETIME,
    "user_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "phone_verification_codes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "provider_check_id" TEXT,
    "call_phone" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" DATETIME NOT NULL,
    "used_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "email_verification_codes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'register',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" DATETIME NOT NULL,
    "used_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS "workspaces" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL UNIQUE,
    "join_policy" TEXT NOT NULL DEFAULT 'request',
    "kind" TEXT NOT NULL DEFAULT 'space',
    "owner_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "workspace_members" (
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "joined_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("workspace_id","user_id"),
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "workspace_join_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE ("workspace_id","user_id"),
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "workspace_bans" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "banned_by_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE ("workspace_id","user_id"),
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("banned_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "friend_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sender_id" TEXT NOT NULL,
    "receiver_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE ("sender_id","receiver_id"),
    FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("receiver_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "friendships" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_a_id" TEXT NOT NULL,
    "user_b_id" TEXT NOT NULL,
    "workspace_id" TEXT UNIQUE,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE ("user_a_id","user_b_id"),
    FOREIGN KEY ("user_a_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("user_b_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "user_blocks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "blocker_id" TEXT NOT NULL,
    "blocked_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE ("blocker_id","blocked_id"),
    FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "channels" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "channel_members" (
    "channel_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    PRIMARY KEY ("channel_id","user_id"),
    FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "channel_read_states" (
    "channel_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "last_read_at" DATETIME NOT NULL,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("channel_id","user_id"),
    FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channel_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "attachment_url" TEXT,
    "attachment_name" TEXT,
    "attachment_mime" TEXT,
    "attachment_size" INTEGER,
    "edited_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "voice_transcriptions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "message_id" TEXT NOT NULL UNIQUE,
    "requested_by_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "operation_id" TEXT UNIQUE,
    "text" TEXT,
    "error_message" TEXT,
    "duration_seconds" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" DATETIME,
    FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "support_tickets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "category" TEXT NOT NULL DEFAULT 'other',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "staff_unread" BOOLEAN NOT NULL DEFAULT true,
    "requester_unread" BOOLEAN NOT NULL DEFAULT false,
    "assigned_to_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "support_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticket_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "is_internal" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "support_ticket_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticket_id" TEXT NOT NULL,
    "actor_id" TEXT,
    "kind" TEXT NOT NULL,
    "details" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "payment_orders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'tbank',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fulfillment_status" TEXT NOT NULL DEFAULT 'waiting_payment',
    "payment_method" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "steam_login" TEXT NOT NULL,
    "steam_amount_kopecks" INTEGER NOT NULL,
    "service_fee_kopecks" INTEGER NOT NULL,
    "payment_amount_kopecks" INTEGER NOT NULL,
    "provider_operation_id" TEXT UNIQUE,
    "supplier_order_number" INTEGER UNIQUE,
    "supplier_status" TEXT,
    "supplier_status_reason" TEXT,
    "supplier_fail_code" TEXT,
    "fulfillment_claimed_at" DATETIME,
    "paid_at" DATETIME,
    "fulfilled_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "gvoice_subscriptions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL UNIQUE,
    "plan" TEXT NOT NULL DEFAULT 'gvoice_plus',
    "status" TEXT NOT NULL DEFAULT 'active',
    "started_at" DATETIME NOT NULL,
    "current_period_start" DATETIME NOT NULL,
    "current_period_end" DATETIME NOT NULL,
    "canceled_at" DATETIME,
    "auto_renew" BOOLEAN NOT NULL DEFAULT false,
    "recurring_consent_at" DATETIME,
    "rebill_id" TEXT,
    "customer_key" TEXT,
    "next_charge_at" DATETIME,
    "renewal_failure_count" INTEGER NOT NULL DEFAULT 0,
    "last_renewal_attempt_at" DATETIME,
    "last_renewal_error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "subscription_payments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'tbank',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "plan" TEXT NOT NULL DEFAULT 'gvoice_plus',
    "billing_period_days" INTEGER NOT NULL DEFAULT 30,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "payment_method" TEXT NOT NULL DEFAULT 'card',
    "payment_amount_kopecks" INTEGER NOT NULL,
    "recurring_consent_at" DATETIME,
    "legal_version" TEXT,
    "consent_ip" TEXT,
    "consent_user_agent" TEXT,
    "payment_kind" TEXT NOT NULL DEFAULT 'initial',
    "provider_rebill_id" TEXT,
    "provider_operation_id" TEXT UNIQUE,
      "payment_url" TEXT,
      "expires_at" DATETIME,
    "paid_at" DATETIME,
    "applied_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS "game_topup_orders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'tbank',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fulfillment_status" TEXT NOT NULL DEFAULT 'waiting_payment',
    "payment_method" TEXT NOT NULL DEFAULT 'card',
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "brand" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "category_name" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "offer_name" TEXT NOT NULL,
    "region" TEXT,
    "variant" TEXT,
    "customer_fields_json" TEXT NOT NULL,
    "supplier_price_usd_micros" INTEGER NOT NULL,
    "usd_rub_rate_micros" INTEGER NOT NULL,
    "fx_buffer_basis_points" INTEGER NOT NULL,
    "markup_basis_points" INTEGER NOT NULL,
    "payment_amount_kopecks" INTEGER NOT NULL,
    "provider_operation_id" TEXT UNIQUE,
    "supplier_order_number" INTEGER UNIQUE,
    "supplier_status" TEXT,
    "supplier_status_reason" TEXT,
    "supplier_fail_code" TEXT,
    "fulfillment_claimed_at" DATETIME,
    "paid_at" DATETIME,
    "fulfilled_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS "messages_channel_id_created_at_idx" ON "messages" ("channel_id", "created_at");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "voice_transcriptions_message_id_key" ON "voice_transcriptions" ("message_id");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "voice_transcriptions_operation_id_key" ON "voice_transcriptions" ("operation_id");`,
  `CREATE INDEX IF NOT EXISTS "voice_transcriptions_requested_by_id_created_at_idx" ON "voice_transcriptions" ("requested_by_id", "created_at");`,
  `CREATE INDEX IF NOT EXISTS "voice_transcriptions_status_updated_at_idx" ON "voice_transcriptions" ("status", "updated_at");`,
  `CREATE INDEX IF NOT EXISTS "channel_read_states_user_id_idx" ON "channel_read_states" ("user_id");`,
  `CREATE INDEX IF NOT EXISTS "support_tickets_user_id_updated_at_idx" ON "support_tickets" ("user_id", "updated_at");`,
  `CREATE INDEX IF NOT EXISTS "support_tickets_status_updated_at_idx" ON "support_tickets" ("status", "updated_at");`,
  `CREATE INDEX IF NOT EXISTS "support_messages_ticket_id_created_at_idx" ON "support_messages" ("ticket_id", "created_at");`,
  `CREATE INDEX IF NOT EXISTS "support_ticket_events_ticket_id_created_at_idx" ON "support_ticket_events" ("ticket_id", "created_at");`,
  `CREATE INDEX IF NOT EXISTS "support_tickets_priority_updated_at_idx" ON "support_tickets" ("priority", "updated_at");`,
  `CREATE INDEX IF NOT EXISTS "payment_orders_user_id_created_at_idx" ON "payment_orders" ("user_id", "created_at");`,
  `CREATE INDEX IF NOT EXISTS "payment_orders_status_created_at_idx" ON "payment_orders" ("status", "created_at");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "payment_orders_provider_operation_id_key" ON "payment_orders" ("provider_operation_id");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "gvoice_subscriptions_user_id_key" ON "gvoice_subscriptions" ("user_id");`,
  `CREATE INDEX IF NOT EXISTS "gvoice_subscriptions_status_current_period_end_idx" ON "gvoice_subscriptions" ("status", "current_period_end");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "subscription_payments_provider_operation_id_key" ON "subscription_payments" ("provider_operation_id");`,
  `CREATE INDEX IF NOT EXISTS "subscription_payments_user_id_created_at_idx" ON "subscription_payments" ("user_id", "created_at");`,
  `CREATE INDEX IF NOT EXISTS "subscription_payments_status_created_at_idx" ON "subscription_payments" ("status", "created_at");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "game_topup_orders_provider_operation_id_key" ON "game_topup_orders" ("provider_operation_id");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "game_topup_orders_supplier_order_number_key" ON "game_topup_orders" ("supplier_order_number");`,
  `CREATE INDEX IF NOT EXISTS "game_topup_orders_user_id_created_at_idx" ON "game_topup_orders" ("user_id", "created_at");`,
  `CREATE INDEX IF NOT EXISTS "game_topup_orders_status_created_at_idx" ON "game_topup_orders" ("status", "created_at");`,
  `CREATE INDEX IF NOT EXISTS "game_topup_orders_fulfillment_status_updated_at_idx" ON "game_topup_orders" ("fulfillment_status", "updated_at");`,
  `CREATE INDEX IF NOT EXISTS "workspace_join_requests_workspace_id_status_idx"
    ON "workspace_join_requests" ("workspace_id", "status");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "workspace_bans_workspace_id_user_id_key" ON "workspace_bans" ("workspace_id", "user_id");`,
  `CREATE INDEX IF NOT EXISTS "workspace_bans_user_id_idx" ON "workspace_bans" ("user_id");`,
  `CREATE INDEX IF NOT EXISTS "email_verification_codes_email_purpose_used_at_idx"
    ON "email_verification_codes" ("email", "purpose", "used_at");`,
  `CREATE INDEX IF NOT EXISTS "email_verification_codes_expires_at_idx"
    ON "email_verification_codes" ("expires_at");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "users_numeric_id_key" ON "users" ("numeric_id");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "oauth_identities_provider_provider_user_id_key" ON "oauth_identities" ("provider", "provider_user_id");`,
  `CREATE INDEX IF NOT EXISTS "oauth_identities_user_id_idx" ON "oauth_identities" ("user_id");`,
  `CREATE INDEX IF NOT EXISTS "friend_requests_receiver_id_status_idx" ON "friend_requests" ("receiver_id", "status");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "friend_requests_sender_id_receiver_id_key" ON "friend_requests" ("sender_id", "receiver_id");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "friendships_user_a_id_user_b_id_key" ON "friendships" ("user_a_id", "user_b_id");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "friendships_workspace_id_key" ON "friendships" ("workspace_id");`,
  `CREATE INDEX IF NOT EXISTS "friendships_user_a_id_idx" ON "friendships" ("user_a_id");`,
  `CREATE INDEX IF NOT EXISTS "friendships_user_b_id_idx" ON "friendships" ("user_b_id");`,
  `CREATE INDEX IF NOT EXISTS "phone_verification_codes_user_id_phone_created_at_idx" ON "phone_verification_codes" ("user_id", "phone", "created_at");`,
  `CREATE INDEX IF NOT EXISTS "phone_verification_codes_expires_at_idx" ON "phone_verification_codes" ("expires_at");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "user_blocks_blocker_id_blocked_id_key" ON "user_blocks" ("blocker_id", "blocked_id");`,
  `CREATE INDEX IF NOT EXISTS "user_blocks_blocked_id_idx" ON "user_blocks" ("blocked_id");`
];

async function ensureColumn(table, column, definition) {
  const columns = await prisma.$queryRawUnsafe(`PRAGMA table_info("${table}")`);
  if (columns.some((item) => item.name === column)) {
    return;
  }
  await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN ${definition}`);
}

try {
  for (const sql of sqlStatements) {
    await prisma.$executeRawUnsafe(sql);
  }
  await ensureColumn("users", "numeric_id", '"numeric_id" INTEGER');
  await ensureColumn("users", "legal_accepted_at", '"legal_accepted_at" DATETIME');
  await ensureColumn("users", "legal_version", '"legal_version" TEXT');
  await ensureColumn("users", "phone", '"phone" TEXT');
  await ensureColumn("users", "phone_verified_at", '"phone_verified_at" DATETIME');
  await ensureColumn("users", "last_seen_at", '"last_seen_at" DATETIME');
  await ensureColumn("oauth_identities", "access_token_encrypted", '"access_token_encrypted" TEXT');
  await ensureColumn("oauth_identities", "refresh_token_encrypted", '"refresh_token_encrypted" TEXT');
  await ensureColumn("oauth_identities", "provider_device_id", '"provider_device_id" TEXT');
  await ensureColumn("oauth_identities", "token_expires_at", '"token_expires_at" DATETIME');
  await ensureColumn("oauth_identities", "scope", '"scope" TEXT');
  await ensureColumn("oauth_identities", "friends_sync_enabled_at", '"friends_sync_enabled_at" DATETIME');
  await ensureColumn("phone_verification_codes", "provider_check_id", '"provider_check_id" TEXT');
  await ensureColumn("phone_verification_codes", "call_phone", '"call_phone" TEXT');
  await ensureColumn("workspaces", "join_policy", '"join_policy" TEXT NOT NULL DEFAULT \'request\'');
  await ensureColumn("workspaces", "kind", '"kind" TEXT NOT NULL DEFAULT \'space\'');
  await ensureColumn("messages", "attachment_url", '"attachment_url" TEXT');
  await ensureColumn("messages", "attachment_name", '"attachment_name" TEXT');
  await ensureColumn("messages", "attachment_mime", '"attachment_mime" TEXT');
  await ensureColumn("messages", "attachment_size", '"attachment_size" INTEGER');
  await ensureColumn("support_tickets", "category", '"category" TEXT NOT NULL DEFAULT \'other\'');
  await ensureColumn("support_tickets", "priority", '"priority" TEXT NOT NULL DEFAULT \'normal\'');
  await ensureColumn("support_tickets", "staff_unread", '"staff_unread" BOOLEAN NOT NULL DEFAULT true');
  await ensureColumn("support_tickets", "requester_unread", '"requester_unread" BOOLEAN NOT NULL DEFAULT false');
  await ensureColumn("support_messages", "is_internal", '"is_internal" BOOLEAN NOT NULL DEFAULT false');
  await ensureColumn("payment_orders", "supplier_order_number", '"supplier_order_number" INTEGER');
  await ensureColumn("payment_orders", "supplier_status", '"supplier_status" TEXT');
  await ensureColumn("payment_orders", "supplier_status_reason", '"supplier_status_reason" TEXT');
  await ensureColumn("payment_orders", "supplier_fail_code", '"supplier_fail_code" TEXT');
  await ensureColumn("payment_orders", "fulfillment_claimed_at", '"fulfillment_claimed_at" DATETIME');
  await ensureColumn("payment_orders", "fulfilled_at", '"fulfilled_at" DATETIME');
  await ensureColumn("gvoice_subscriptions", "auto_renew", '"auto_renew" BOOLEAN NOT NULL DEFAULT false');
  await ensureColumn("gvoice_subscriptions", "recurring_consent_at", '"recurring_consent_at" DATETIME');
  await ensureColumn("gvoice_subscriptions", "rebill_id", '"rebill_id" TEXT');
  await ensureColumn("gvoice_subscriptions", "customer_key", '"customer_key" TEXT');
  await ensureColumn("gvoice_subscriptions", "next_charge_at", '"next_charge_at" DATETIME');
  await ensureColumn("gvoice_subscriptions", "renewal_failure_count", '"renewal_failure_count" INTEGER NOT NULL DEFAULT 0');
  await ensureColumn("gvoice_subscriptions", "last_renewal_attempt_at", '"last_renewal_attempt_at" DATETIME');
  await ensureColumn("gvoice_subscriptions", "last_renewal_error", '"last_renewal_error" TEXT');
  await ensureColumn("subscription_payments", "recurring_consent_at", '"recurring_consent_at" DATETIME');
  await ensureColumn("subscription_payments", "payment_method", '"payment_method" TEXT NOT NULL DEFAULT \'card\'');
  await ensureColumn("subscription_payments", "legal_version", '"legal_version" TEXT');
  await ensureColumn("subscription_payments", "consent_ip", '"consent_ip" TEXT');
  await ensureColumn("subscription_payments", "consent_user_agent", '"consent_user_agent" TEXT');
  await ensureColumn("subscription_payments", "payment_kind", '"payment_kind" TEXT NOT NULL DEFAULT \'initial\'');
  await ensureColumn("subscription_payments", "provider_rebill_id", '"provider_rebill_id" TEXT');
  await ensureColumn("subscription_payments", "payment_url", '"payment_url" TEXT');
  await ensureColumn("subscription_payments", "expires_at", '"expires_at" DATETIME');
  await prisma.$executeRawUnsafe('UPDATE "users" SET "last_seen_at" = "updated_at" WHERE "last_seen_at" IS NULL');
  await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "users_phone_key" ON "users" ("phone")');
  await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "phone_verification_codes_provider_check_id_key" ON "phone_verification_codes" ("provider_check_id")');
  await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "payment_orders_supplier_order_number_key" ON "payment_orders" ("supplier_order_number")');
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "gvoice_subscriptions_auto_renew_next_charge_at_idx" ON "gvoice_subscriptions" ("auto_renew", "next_charge_at")');
  console.log("SQLite schema initialized.");
} finally {
  await prisma.$disconnect();
}
