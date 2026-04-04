import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { getRateLimiter } from "@/lib/rate-limit";

export const BCRYPT_ROUNDS = 12;

export const authOptions: NextAuthOptions = {
  session: {
    strategy: "jwt",
    maxAge: 8 * 60 * 60, // 8 hours
  },
  pages: {
    signIn: "/login",
  },
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        // Rate limit login attempts: 10 per minute per email
        const loginLimiter = getRateLimiter("login", 10, 60_000);
        if (!loginLimiter.check(credentials.email.toLowerCase())) {
          return null; // Rate limited — return null (same as invalid credentials)
        }

        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
        });

        if (!user) {
          return null;
        }

        const isPasswordValid = await bcrypt.compare(
          credentials.password,
          user.hashedPassword
        );

        if (!isPasswordValid) {
          return null;
        }

        // Block login for users pending admin approval
        if (!user.isApproved) {
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as unknown as { role: string }).role;
      }

      // Re-verify role from DB on each token refresh to prevent stale-role escalation
      if (!user && token.id) {
        try {
          const dbUser = await prisma.user.findUnique({
            where: { id: token.id as string },
            select: { role: true, isApproved: true },
          });
          if (!dbUser || !dbUser.isApproved) {
            // Invalidate session — user deleted or unapproved
            token.id = "";
            token.role = "";
            return token;
          }
          token.role = dbUser.role;
        } catch {
          // DB error — keep existing token data rather than locking user out
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user && token.id) {
        (session.user as { id: string }).id = token.id as string;
        (session.user as { role: string }).role = token.role as string;
      }
      return session;
    },
  },
};
