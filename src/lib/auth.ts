import NextAuth, { type NextAuthConfig } from "next-auth";
import type { Provider } from "next-auth/providers";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { accounts, sessions, users, verificationTokens } from "./db/schema";

/**
 * Auth.js v5 configuration.
 *
 * Both providers are wired up but each only appears if its credentials are
 * present in the environment, so you can run with Google alone, Microsoft
 * alone, or both — no code changes needed to switch.
 */

export interface ProviderInfo {
  id: string;
  name: string;
}

function buildProviders(): { providers: Provider[]; info: ProviderInfo[] } {
  const providers: Provider[] = [];
  const info: ProviderInfo[] = [];

  if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
    providers.push(
      Google({
        clientId: process.env.AUTH_GOOGLE_ID,
        clientSecret: process.env.AUTH_GOOGLE_SECRET,
        allowDangerousEmailAccountLinking: true,
      }),
    );
    info.push({ id: "google", name: "Google" });
  }

  if (process.env.AUTH_MICROSOFT_ENTRA_ID_ID && process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET) {
    providers.push(
      MicrosoftEntraID({
        clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
        clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
        issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
        allowDangerousEmailAccountLinking: true,
      }),
    );
    info.push({ id: "microsoft-entra-id", name: "Microsoft" });
  }

  // Local-only escape hatch: sign in as a fixed demo user with no OAuth setup,
  // so the app can be tried (and tested) before any provider is configured.
  //
  // Deliberately guarded twice — it requires an explicit opt-in flag AND a
  // non-production build — because it accepts any password. `next build` sets
  // NODE_ENV=production, so a deployed instance can never expose this even if
  // the flag leaks into the environment.
  if (isDevLoginEnabled()) {
    providers.push(
      Credentials({
        id: "dev-login",
        name: "Development",
        credentials: { email: { label: "Email", type: "email" } },
        authorize: async (creds) => {
          const email = String(creds?.email ?? "").trim() || "dev@localhost";
          const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
          if (existing) return existing;

          const [created] = await db
            .insert(users)
            .values({ email, name: email.split("@")[0], emailVerified: new Date() })
            .returning();
          return created;
        },
      }),
    );
    info.push({ id: "dev-login", name: "Development account" });
  }

  return { providers, info };
}

/** True only when dev login is explicitly enabled outside production. */
export function isDevLoginEnabled(): boolean {
  return process.env.AUTH_DEV_LOGIN === "1" && process.env.NODE_ENV !== "production";
}

const { providers, info } = buildProviders();

/** Providers that are actually configured — the login page renders from this. */
export const enabledProviders = info;

export const authConfig: NextAuthConfig = {
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  providers,
  // JWT sessions keep middleware edge-compatible (no DB round trip per request)
  // while the adapter still persists users and linked OAuth accounts.
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 30 },
  pages: { signIn: "/login", error: "/login" },
  trustHost: true,
  callbacks: {
    async signIn({ user, account, profile }) {
      // The adapter writes name and image only when it first creates a user,
      // so an account that already existed — or whose provider profile has
      // since changed — would keep stale details forever. Refresh them on each
      // sign-in, and update `user` too so the new JWT carries the fresh values
      // rather than waiting for the next login.
      if (account && (account.type === "oauth" || account.type === "oidc") && user.id) {
        const claims = (profile ?? {}) as Record<string, unknown>;
        const name = typeof claims.name === "string" ? claims.name : (user.name ?? null);
        const picture = claims.picture ?? claims.image ?? claims.avatar_url;
        const image = typeof picture === "string" ? picture : (user.image ?? null);

        if (name !== user.name || image !== user.image) {
          await db.update(users).set({ name, image }).where(eq(users.id, user.id));
          user.name = name;
          user.image = image;
        }
      }
      return true;
    },
    jwt({ token, user }) {
      if (user?.id) token.uid = user.id;
      return token;
    },
    session({ session, token }) {
      if (session.user && typeof token.uid === "string") {
        session.user.id = token.uid;
      }
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

/** Thrown by {@link requireUserId}; mapped to a 401 by the API error handler. */
export class UnauthorizedError extends Error {
  constructor() {
    super("Not signed in");
    this.name = "UnauthorizedError";
  }
}

/** Resolve the signed-in user's id, or throw. Use in every API route. */
export async function requireUserId(): Promise<string> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new UnauthorizedError();
  return id;
}
