export type AuthUser = {
  id: string;
  numericId?: number | null;
  email: string;
  username: string;
  avatarUrl?: string | null;
  createdAt: string;
};
