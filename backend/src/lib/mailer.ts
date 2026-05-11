import nodemailer from "nodemailer";
import { env } from "../config/env.js";

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  return value.toLowerCase() === "true";
}

function getSmtpHostForTls(host: string): string {
  // When SMTP host is set as IP, TLS cert validation fails for *.beget.com.
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  return isIp ? "smtp.beget.com" : host;
}

export async function sendRegistrationCodeEmail(params: {
  to: string;
  username: string;
  code: string;
  ttlMinutes: number;
}): Promise<void> {
  const { to, username, code, ttlMinutes } = params;

  if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_FROM) {
    throw new Error("SMTP is not configured");
  }

  const secure = parseBool(env.SMTP_SECURE, env.SMTP_PORT === 465);

  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure,
    auth: env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
    requireTLS: secure,
    tls: {
      servername: getSmtpHostForTls(env.SMTP_HOST),
      minVersion: "TLSv1.2"
    }
  });

  await transporter.verify();

  await transporter.sendMail({
    from: env.SMTP_FROM,
    to,
    subject: "Код подтверждения регистрации GVoice",
    text: `Здравствуйте, ${username}!\n\nВаш код подтверждения: ${code}\nКод действует ${ttlMinutes} минут.\n\nЕсли это были не вы, просто игнорируйте это письмо.`,
    html: `<p>Здравствуйте, <b>${username}</b>!</p>
<p>Ваш код подтверждения: <b style="font-size:20px;letter-spacing:2px;">${code}</b></p>
<p>Код действует <b>${ttlMinutes} минут</b>.</p>
<p>Если это были не вы, просто игнорируйте это письмо.</p>`
  });
}
