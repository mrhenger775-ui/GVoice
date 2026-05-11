import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const EMOJI_AVATARS = ["😀", "😎", "🤖", "🦊", "🐼", "🐱", "🐶", "🦁", "🐸", "🐵", "🐙", "🦄", "🐧", "🐯", "🐨", "🐺"];
const EMOJI_AVATAR_BACKGROUNDS = ["#1d4ed8", "#7c3aed", "#be185d", "#0f766e", "#b45309", "#374151", "#0e7490", "#4338ca"];

function createRandomEmojiAvatarDataUrl() {
  const emoji = EMOJI_AVATARS[Math.floor(Math.random() * EMOJI_AVATARS.length)] ?? "🙂";
  const background = EMOJI_AVATAR_BACKGROUNDS[Math.floor(Math.random() * EMOJI_AVATAR_BACKGROUNDS.length)] ?? "#1d4ed8";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="64" fill="${background}"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-size="128">${emoji}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

async function main() {
  const users = await prisma.user.findMany({
    where: {
      OR: [{ avatarUrl: null }, { avatarUrl: "" }]
    },
    select: { id: true, username: true }
  });

  if (users.length === 0) {
    console.log("No users without avatar. Nothing to update.");
    return;
  }

  for (const user of users) {
    await prisma.user.update({
      where: { id: user.id },
      data: { avatarUrl: createRandomEmojiAvatarDataUrl() }
    });
    console.log(`Updated avatar for ${user.username} (${user.id})`);
  }

  console.log(`Done. Updated ${users.length} user(s).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

