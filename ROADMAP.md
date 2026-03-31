# Rommseer Version 0.2.0 Roadmap

## Overview

Version 0.2.0 introduces quality-of-life improvements, better visibility into downloads and user actions, notification support, and foundational multi-user features inspired by the *arr stack (Sonarr, Radarr) and Seer apps (Overseerr, Jellyseerr).

### Current Version (0.1.x)
- Basic ROM request workflow: Discover → Request → Approve → Auto-grab → Available
- Prowlarr integration with relevance filtering and sequel detection
- qBittorrent + SABnzbd download client support
- RomM library integration and post-copy scanning
- Background sync loops for download monitoring and auto-retry
- Stall detection with configurable timeout
- Indexer failure tracking and cooldown blocking

### Version 0.2.0 Goals
- **Visibility**: Show all download state, errors, and timers in the UI
- **Notifications**: Discord webhooks, email, in-app notifications
- **Workflow**: Admin notes, request cancellation, activity logs
- **Users**: Self-registration, multi-user quotas, user management
- **Mobile**: Responsive sidebar and request cards
- **Reliability**: Persistent indexer health, scheduled library sync

---

## Phase 1: High Impact, Low Effort (Quick Wins)

No schema changes required. These improve UX immediately.

### 1.1 — Dedicated Downloads Page
- **Status**: Not Started
- **Effort**: Low
- **Impact**: High
- **Description**: The `/api/downloads` endpoint exists but there's no UI for it. Create `/src/app/(app)/downloads/page.tsx` to show a table of all Download records with: game name, torrent/usenet type, indexer, progress bar, status badge, error message, stalledAt countdown.
- **Files Affected**:
  - `src/app/(app)/downloads/page.tsx` (new)
  - `src/components/sidebar.tsx` (add Downloads link)

### 1.2 — Download Error Visibility
- **Status**: Not Started
- **Effort**: Low
- **Impact**: High
- **Description**: The `Download.error` field is populated on failure but never shown. Display error messages on request cards when status is FAILED or DOWNLOADING.
- **Files Affected**:
  - `src/app/(app)/requests/page.tsx`

### 1.3 — Progress Bars on Requests Page
- **Status**: Not Started
- **Effort**: Low
- **Impact**: Medium
- **Description**: Render `Download.progress` as a thin progress bar under the game title when status is DOWNLOADING.
- **Files Affected**:
  - `src/app/(app)/requests/page.tsx`

### 1.4 — Stall Timer Indicator
- **Status**: Not Started
- **Effort**: Low
- **Impact**: Medium
- **Description**: Show "Stalled — retrying in 15 min" using `Download.stalledAt` and `stallDetectMinutes` setting.
- **Files Affected**:
  - `src/app/(app)/requests/page.tsx`

### 1.5 — Block Requests for Already-Available Games
- **Status**: Not Started
- **Effort**: Low
- **Impact**: High
- **Description**: Check `game.isAvailable` in the POST handler for requests. Return 409 if true.
- **Files Affected**:
  - `src/app/api/requests/route.ts`

### 1.6 — User Request Cancellation
- **Status**: Not Started
- **Effort**: Low
- **Impact**: High
- **Description**: Users can cancel (not delete) PENDING requests, setting status to `CANCELLED`. Keep the record for history.
- **Files Affected**:
  - `src/app/api/requests/[id]/route.ts`
  - `src/app/(app)/requests/page.tsx`
  - `prisma/schema.prisma` (document new status value)

---

## Phase 2: High Value, Medium Effort

Requires schema changes but deliver significant value.

### 2.1 — Admin Notes on Requests
- **Status**: Not Started
- **Effort**: Low
- **Impact**: High
- **Schema Change**: Yes — add `adminNote String?` to `Request`
- **Description**: When declining a request, admins need a way to explain why. Add `adminNote` field, surface it in the request detail view and card.
- **Files Affected**:
  - `prisma/schema.prisma` (add field)
  - `src/app/api/requests/[id]/route.ts` (update PATCH handler)
  - `src/app/(app)/requests/page.tsx` (show on card/detail)

### 2.2 — Decline Reason Presets
- **Status**: Not Started
- **Effort**: Low
- **Impact**: Medium
- **Schema Change**: No (requires 2.1)
- **Description**: When admin clicks Decline, show a popover with presets ("Already in library", "No sources available", "Wrong platform", "Duplicate") + free-text field. Populates `adminNote`.
- **Files Affected**:
  - `src/app/(app)/requests/page.tsx`

### 2.3 — Discord Webhook Notifications
- **Status**: Not Started
- **Effort**: Medium
- **Impact**: High
- **Schema Change**: Yes — add `discordWebhookUrl` and notification toggles to `Settings`
- **Description**: Post embeds to a Discord webhook on: request created, approved, declined, download started, completed. Triggers from request PATCH handler, sync.ts, postcopy.ts.
- **Files Affected**:
  - `prisma/schema.prisma` (add webhook URL + toggles)
  - `src/lib/notifications.ts` (new, `notifyDiscord()` function)
  - `src/app/api/requests/[id]/route.ts` (trigger on PATCH)
  - `src/lib/sync.ts` (trigger on download complete)
  - `src/lib/postcopy.ts` (trigger on AVAILABLE)
  - `src/app/(app)/settings/page.tsx` (add webhook URL input)
  - `src/app/api/settings/route.ts` (update PUT handler)

### 2.4 — Activity Log Model & Per-Request Timeline
- **Status**: Not Started
- **Effort**: Medium
- **Impact**: High
- **Schema Change**: Yes — new `Activity` model with type enum
- **Description**: Track all events: request created, approved, declined, download started/failed/completed, retried, available. Show timeline in request detail view. New Activity page for admins.
- **Files Affected**:
  - `prisma/schema.prisma` (new model: `Activity { id, type, userId?, requestId?, downloadId?, message, metadata, createdAt }`)
  - `src/lib/sync.ts` (write activity on status changes)
  - `src/app/api/requests/[id]/route.ts` (write activity on PATCH)
  - `src/app/(app)/requests/[id]/timeline.tsx` (new component)
  - `src/app/(app)/activity/page.tsx` (new admin page)
  - Dashboard "Recent Requests" card → "Recent Activity" with event types

### 2.5 — Scheduled RomM Library Sync
- **Status**: Not Started
- **Effort**: Medium
- **Impact**: High
- **Schema Change**: No
- **Description**: Add a third background loop to sync.ts (e.g., every 6 hours) that calls RomM `/roms` API, matches IGDBIds against `Game.igdbId`, and updates `Game.isAvailable` and `Game.rommId`. Prevents users from re-requesting games already in the library.
- **Files Affected**:
  - `src/lib/sync.ts` (add new interval loop)
  - `src/lib/romm.ts` (add `getRoms()` method if missing)

### 2.6 — Mobile Sidebar & Responsive Layout
- **Status**: Not Started
- **Effort**: Medium
- **Impact**: High
- **Schema Change**: No
- **Description**: Sidebar is fixed `w-64` with no responsive logic. Add hamburger menu on small screens, hide sidebar on mobile, or use bottom nav. Update request cards to use overflow menus on small screens.
- **Files Affected**:
  - `src/components/sidebar.tsx` (add hamburger + responsive breakpoints)
  - `src/app/(app)/layout.tsx` (update layout grid)
  - `src/app/(app)/requests/page.tsx` (mobile action overflow menu)
  - `src/app/(app)/settings/page.tsx` (responsive tab bar)

---

## Phase 3: Structural / Larger Projects

Requires schema changes and significant development effort.

### 3.1 — User Management Page
- **Status**: Not Started
- **Effort**: Medium
- **Impact**: High
- **Schema Change**: No
- **Description**: Admin-only `/users` page showing all users with: email, role, request count, registration date, last activity. Buttons to: change role, reset password, delete account, set quota (when 3.4 is done).
- **Files Affected**:
  - `src/app/(app)/users/page.tsx` (new)
  - `src/components/sidebar.tsx` (add Users link)
  - `src/app/api/users/route.ts` (new, LIST + DELETE)
  - `src/app/api/users/[id]/route.ts` (new, PATCH for role/quota)

### 3.2 — Self-Registration with Admin Approval
- **Status**: Not Started
- **Effort**: Medium
- **Impact**: High
- **Schema Change**: Yes — add `registrationEnabled` to `Settings`, `isApproved` and `approvedAt` to `User`
- **Description**: Add `/register` page when `registrationEnabled` is true. New users created with `isApproved: false`. Auth provider rejects unapproved users. Admin sees "Pending Users" in Settings. Accept/reject buttons in User Management page (3.1).
- **Files Affected**:
  - `prisma/schema.prisma` (add fields)
  - `src/app/register/page.tsx` (new)
  - `src/lib/auth.ts` (update authorize callback to check isApproved)
  - `src/app/(app)/users/page.tsx` (show pending tab + approve/reject buttons)
  - `src/app/api/users/[id]/route.ts` (add approve endpoint)
  - `src/app/(app)/settings/page.tsx` (toggle registration enabled)

### 3.3 — Invite Links
- **Status**: Not Started
- **Effort**: Medium
- **Impact**: Medium
- **Schema Change**: Yes — new `Invite` model
- **Description**: Admins generate single-use invite tokens. Users visit `/register?token=xxx`, sign up, auto-approved. Alternatives to open registration.
- **Files Affected**:
  - `prisma/schema.prisma` (new model: `Invite { token, email?, usedAt, createdBy, expiresAt }`)
  - `src/app/register/page.tsx` (validate token, auto-approve)
  - `src/app/api/invites/route.ts` (new, POST to generate, GET to list)
  - `src/app/(app)/users/page.tsx` (show active invites, generate new)

### 3.4 — User Request Quotas
- **Status**: Not Started
- **Effort**: Medium
- **Impact**: Medium
- **Schema Change**: Yes — add `requestQuota` and `requestQuotaDays` to `User`
- **Description**: Prevent queue flooding. `requestQuota: 0` = unlimited. POST handler for requests counts recent requests and rejects if over quota.
- **Files Affected**:
  - `prisma/schema.prisma` (add fields)
  - `src/app/api/requests/route.ts` (add quota check)
  - `src/app/(app)/users/page.tsx` (set quota per user)

### 3.5 — Request Detail Drawer
- **Status**: Not Started
- **Effort**: Medium
- **Impact**: High
- **Schema Change**: No
- **Description**: Side drawer (Overseerr-style) replacing inline card actions. Shows: full game metadata, all download attempts with errors, user comment, admin note, action buttons, activity timeline.
- **Files Affected**:
  - `src/app/(app)/requests/[id]/drawer.tsx` (new component)
  - `src/app/(app)/requests/page.tsx` (integrate drawer, click to open)

### 3.6 — Indexer Failure Persistence
- **Status**: Not Started
- **Effort**: Low
- **Impact**: Medium
- **Schema Change**: Yes — new `IndexerHealth` model
- **Description**: `indexerFailures` Map resets on every container restart. Create `IndexerHealth` model: `{ indexer String @id, failureCount Int, lastFailure DateTime, blockedUntil DateTime? }`. Read/write this instead of in-memory Map.
- **Files Affected**:
  - `prisma/schema.prisma` (new model)
  - `src/lib/autograb.ts` (replace Map with Prisma queries)

### 3.7 — Email (SMTP) Notifications
- **Status**: Not Started
- **Effort**: High
- **Impact**: Medium
- **Schema Change**: Yes — add SMTP fields to `Settings`
- **Description**: Send emails on request status changes. Requires SMTP config (host, port, user, pass, from). Use `nodemailer`. HTML email templates.
- **Files Affected**:
  - `prisma/schema.prisma` (add SMTP fields)
  - `src/lib/notifications.ts` (add `notifyEmail()`)
  - `src/app/(app)/settings/page.tsx` (SMTP config inputs)
  - `src/app/api/settings/route.ts` (validate SMTP)

### 3.8 — In-App Notification Bell
- **Status**: Not Started
- **Effort**: High
- **Impact**: Medium
- **Schema Change**: Yes — new `Notification` model
- **Description**: Unread badge in sidebar. Click bell to open inbox showing per-user notifications (type, message, link). Mark as read.
- **Files Affected**:
  - `prisma/schema.prisma` (new model: `Notification { id, userId, type, message, read, createdAt }`)
  - `src/lib/notifications.ts` (add `createNotification()`)
  - `src/components/sidebar.tsx` (add bell + unread count)
  - `src/app/(app)/notifications/page.tsx` (new)
  - `src/app/api/notifications/route.ts` (new, GET list + mark read)

### 3.9 — Bulk Admin Actions
- **Status**: Not Started
- **Effort**: Medium
- **Impact**: Medium
- **Schema Change**: No
- **Description**: Checkboxes on requests list. Approve/decline multiple PENDING requests at once. Call PATCH handlers in parallel.
- **Files Affected**:
  - `src/app/(app)/requests/page.tsx` (add checkbox state, bulk action buttons)

### 3.10 — Auto-Grab Dry-Run Mode
- **Status**: Not Started
- **Effort**: Low
- **Impact**: Low
- **Schema Change**: Yes — add `prowlarrDryRun` to `Settings`
- **Description**: When enabled, auto-grab runs full search + selection but logs results without downloading. Great for debugging search templates and indexer selection.
- **Files Affected**:
  - `prisma/schema.prisma` (add field)
  - `src/lib/autograb.ts` (check flag, skip download if true)
  - `src/app/(app)/settings/page.tsx` (add toggle)

---

## Implementation Priority

### Quick Wins (1–2 weeks)
1. Phase 1.2 — Download error visibility
2. Phase 1.1 — Dedicated Downloads page
3. Phase 1.3 — Progress bars
4. Phase 1.4 — Stall timer indicator
5. Phase 1.5 — Block requests for available games
6. Phase 2.1 — Admin notes on requests
7. Phase 2.2 — Decline reason presets

### High Value (3–4 weeks)
8. Phase 2.3 — Discord webhook notifications
9. Phase 2.5 — Scheduled RomM library sync
10. Phase 3.1 — User Management page
11. Phase 2.4 — Activity log + timeline

### Strategic (4+ weeks)
12. Phase 3.2 — Self-registration with approval
13. Phase 3.5 — Request detail drawer
14. Phase 2.6 — Mobile responsiveness
15. Phase 3.4 — User request quotas

---

## Success Metrics

By the end of Version 0.2.0:
- ✓ Admins have full visibility of all downloads and errors
- ✓ Users receive notifications when their requests change status
- ✓ Users can cancel their own requests
- ✓ Admins can annotate why they declined a request
- ✓ Full activity/audit log exists
- ✓ Application is usable on mobile
- ✓ Self-service registration is available (optional)
- ✓ Library sync is automated and reliable

---

## Notes

- **Database**: All schema changes require `npx prisma generate` after `schema.prisma` edits. The Docker build uses `prisma db push` at startup, so migrations are automatic.
- **Notifications module**: Build 2.3 (Discord) with a clean abstraction from the start so 3.7 (Email) and 3.8 (In-app) can be added as separate channels.
- **Background sync**: Expanding `src/lib/sync.ts` with more loops (library sync, notification processing) is fine — keep it organized with separate IIFE functions for each loop.
- **Mobile-first**: After 2.6 lands, all new UI components should be mobile-responsive from the start.

---

**Version 0.2.0 Target Release**: Q2 2026
