import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { BCRYPT_ROUNDS } from "@/lib/auth";
import { applyRateLimit } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  // Rate limit registration: 5 attempts per minute per IP
  const rateLimited = applyRateLimit(req, "register", 5, 60_000);
  if (rateLimited) return rateLimited;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { name, email, password, inviteToken } = body;

  // Check if registration is enabled or invite token provided
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  const registrationEnabled = settings?.registrationEnabled ?? false;

  if (!registrationEnabled && !inviteToken) {
    return NextResponse.json(
      { error: "Registration is not enabled" },
      { status: 403 }
    );
  }

  // Validate inputs
  if (!name || typeof name !== "string" || name.trim().length < 1 || name.trim().length > 100) {
    return NextResponse.json(
      { error: "Name must be between 1 and 100 characters" },
      { status: 400 }
    );
  }

  if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json(
      { error: "A valid email is required" },
      { status: 400 }
    );
  }

  if (!password || typeof password !== "string" || password.length < 12) {
    return NextResponse.json(
      { error: "Password must be at least 12 characters" },
      { status: 400 }
    );
  }

  // Check if email already exists
  const existingUser = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (existingUser) {
    return NextResponse.json(
      { error: "An account with this email already exists" },
      { status: 409 }
    );
  }

  // Validate invite token if provided
  let invite = null;
  if (inviteToken) {
    invite = await prisma.invite.findUnique({
      where: { token: inviteToken },
    });

    if (!invite) {
      return NextResponse.json(
        { error: "Invalid invite token" },
        { status: 400 }
      );
    }

    if (invite.usedAt) {
      return NextResponse.json(
        { error: "This invite has already been used" },
        { status: 400 }
      );
    }

    if (invite.expiresAt < new Date()) {
      return NextResponse.json(
        { error: "This invite has expired" },
        { status: 400 }
      );
    }

    if (invite.email && invite.email.toLowerCase() !== email.toLowerCase()) {
      return NextResponse.json(
        { error: "This invite is restricted to a different email address" },
        { status: 400 }
      );
    }
  }

  // Hash password with consistent cost factor
  const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

  // Create user
  const user = await prisma.user.create({
    data: {
      name: name.trim(),
      email: email.toLowerCase(),
      hashedPassword,
      isApproved: invite ? true : false,
      approvedAt: invite ? new Date() : null,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
    },
  });

  // Mark invite as used
  if (invite) {
    await prisma.invite.update({
      where: { token: invite.token },
      data: {
        usedAt: new Date(),
        usedBy: user.id,
      },
    });
  }

  return NextResponse.json(user, { status: 201 });
}
