"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Shield,
  ShieldCheck,
  UserCheck,
  Trash2,
  Users as UsersIcon,
  UserPlus,
  X,
  Loader2,
} from "lucide-react";
import { formatDate } from "@/lib/utils";

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  isApproved: boolean;
  requestQuota: number;
  requestQuotaDays: number;
  createdAt: string;
}

export default function UsersPage() {
  const { data: session } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [formData, setFormData] = useState({ name: "", email: "", password: "" });

  useEffect(() => {
    fetchUsers();
  }, []);

  async function fetchUsers() {
    setLoading(true);
    const res = await fetch("/api/users");
    if (res.ok) {
      const data = await res.json();
      setUsers(data);
    }
    setLoading(false);
  }

  async function updateUser(id: string, updates: Partial<User>) {
    const res = await fetch(`/api/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    if (res.ok) {
      const updated = await res.json();
      setUsers((prev) => prev.map((u) => (u.id === id ? updated : u)));
    }
  }

  async function deleteUser(id: string) {
    if (!confirm("Are you sure you want to delete this user? This action cannot be undone.")) return;
    setDeletingId(id);
    const res = await fetch(`/api/users/${id}`, { method: "DELETE" });
    if (res.ok) {
      setUsers((prev) => prev.filter((u) => u.id !== id));
    }
    setDeletingId(null);
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError("");

    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (res.ok) {
        const newUser = await res.json();
        setUsers((prev) => [newUser, ...prev]);
        setFormData({ name: "", email: "", password: "" });
        setShowCreateForm(false);
      } else {
        let message = "Failed to create user";
        try {
          const error = await res.json();
          message = error.error || message;
        } catch {
          message = `Server error (${res.status})`;
        }
        setCreateError(message);
      }
    } catch {
      setCreateError("Network error — please try again");
    } finally {
      setCreating(false);
    }
  }

  if (!session || session.user.role !== "ADMIN") {
    return (
      <div className="flex h-32 items-center justify-center text-muted-foreground">
        Unauthorized
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Users</h1>
          <p className="text-muted-foreground">
            Manage user accounts, roles, and quotas
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="gap-1">
            <UsersIcon className="h-3 w-3" />
            {users.length} user{users.length !== 1 && "s"}
          </Badge>
          <Button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="gap-2"
          >
            <UserPlus className="h-4 w-4" />
            Create User
          </Button>
        </div>
      </div>

      {/* Create User Form */}
      {showCreateForm && (
        <Card>
          <CardContent className="p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Create New User</h2>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  setShowCreateForm(false);
                  setCreateError("");
                  setFormData({ name: "", email: "", password: "" });
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <form onSubmit={createUser} className="space-y-4">
              <div>
                <label className="text-sm font-medium">Name</label>
                <Input
                  placeholder="John Doe"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData((s) => ({ ...s, name: e.target.value }))
                  }
                  disabled={creating}
                />
              </div>

              <div>
                <label className="text-sm font-medium">Email</label>
                <Input
                  type="email"
                  placeholder="john@example.com"
                  value={formData.email}
                  onChange={(e) =>
                    setFormData((s) => ({ ...s, email: e.target.value }))
                  }
                  disabled={creating}
                />
              </div>

              <div>
                <label className="text-sm font-medium">Password (min 12 chars)</label>
                <Input
                  type="password"
                  placeholder="••••••••••••"
                  value={formData.password}
                  onChange={(e) =>
                    setFormData((s) => ({ ...s, password: e.target.value }))
                  }
                  disabled={creating}
                />
              </div>

              {createError && (
                <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  {createError}
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  type="submit"
                  disabled={creating}
                >
                  {creating ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    "Create User"
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setShowCreateForm(false);
                    setCreateError("");
                    setFormData({ name: "", email: "", password: "" });
                  }}
                  disabled={creating}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="flex h-32 items-center justify-center text-muted-foreground">
          Loading users...
        </div>
      ) : users.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-muted-foreground">
          No users found.
        </div>
      ) : (
        <div className="space-y-3">
          {users.map((user) => (
            <Card key={user.id}>
              <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{user.name}</span>
                    <Badge
                      variant={user.role === "ADMIN" ? "default" : "secondary"}
                      className="cursor-pointer gap-1"
                      onClick={() =>
                        updateUser(user.id, {
                          role: user.role === "ADMIN" ? "USER" : "ADMIN",
                        })
                      }
                    >
                      {user.role === "ADMIN" ? (
                        <ShieldCheck className="h-3 w-3" />
                      ) : (
                        <Shield className="h-3 w-3" />
                      )}
                      {user.role}
                    </Badge>
                    {user.isApproved ? (
                      <Badge variant="outline" className="text-green-600">
                        Approved
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-yellow-600">
                        Pending
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">{user.email}</p>
                  <p className="text-xs text-muted-foreground">
                    Joined {formatDate(user.createdAt)}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {!user.isApproved && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => updateUser(user.id, { isApproved: true })}
                    >
                      <UserCheck className="mr-1 h-4 w-4" />
                      Approve
                    </Button>
                  )}

                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min={0}
                      className="h-8 w-20"
                      defaultValue={user.requestQuota}
                      placeholder="Quota"
                      title="Request quota (0 = unlimited)"
                      onBlur={(e) => {
                        const val = parseInt(e.target.value, 10);
                        if (!isNaN(val) && val !== user.requestQuota) {
                          updateUser(user.id, { requestQuota: val });
                        }
                      }}
                    />
                    <span className="text-xs text-muted-foreground">/</span>
                    <Input
                      type="number"
                      min={1}
                      className="h-8 w-16"
                      defaultValue={user.requestQuotaDays}
                      placeholder="Days"
                      title="Quota period in days"
                      onBlur={(e) => {
                        const val = parseInt(e.target.value, 10);
                        if (!isNaN(val) && val > 0 && val !== user.requestQuotaDays) {
                          updateUser(user.id, { requestQuotaDays: val });
                        }
                      }}
                    />
                    <span className="text-xs text-muted-foreground">days</span>
                  </div>

                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={deletingId === user.id}
                    onClick={() => deleteUser(user.id)}
                  >
                    <Trash2 className="mr-1 h-4 w-4" />
                    Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
