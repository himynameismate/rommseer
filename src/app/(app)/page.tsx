"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ListTodo,
  Clock,
  CheckCircle2,
  Gamepad2,
  Users,
} from "lucide-react";
import { formatDate, getStatusBadgeVariant } from "@/lib/utils";

interface Stats {
  totalRequests: number;
  pendingRequests: number;
  approvedRequests: number;
  availableGames: number;
  totalUsers: number;
  recentRequests: {
    id: number;
    status: string;
    createdAt: string;
    user: { name: string };
    game: { name: string; platform: { name: string } };
  }[];
}

export default function DashboardPage() {
  const { data: session } = useSession();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then(setStats)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  const statCards = [
    {
      title: "Total Requests",
      value: stats?.totalRequests ?? 0,
      icon: ListTodo,
      color: "text-blue-500",
    },
    {
      title: "Pending",
      value: stats?.pendingRequests ?? 0,
      icon: Clock,
      color: "text-yellow-500",
    },
    {
      title: "Approved",
      value: stats?.approvedRequests ?? 0,
      icon: CheckCircle2,
      color: "text-green-500",
    },
    {
      title: "Available Games",
      value: stats?.availableGames ?? 0,
      icon: Gamepad2,
      color: "text-purple-500",
    },
  ];

  if (session?.user?.role === "ADMIN") {
    statCards.push({
      title: "Users",
      value: stats?.totalUsers ?? 0,
      icon: Users,
      color: "text-cyan-500",
    });
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground">
          Welcome back, {session?.user?.name}
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statCards.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.title}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {stat.title}
                </CardTitle>
                <Icon className={`h-4 w-4 ${stat.color}`} />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stat.value}</div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Recent Requests */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Requests</CardTitle>
        </CardHeader>
        <CardContent>
          {!stats?.recentRequests?.length ? (
            <p className="py-8 text-center text-muted-foreground">
              No requests yet. Head to{" "}
              <a href="/discover" className="text-primary hover:underline">
                Discover
              </a>{" "}
              to find games!
            </p>
          ) : (
            <div className="space-y-3">
              {stats.recentRequests.map((request) => (
                <div
                  key={request.id}
                  className="flex items-center justify-between rounded-lg border px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{request.game.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {request.game.platform.name} &middot; Requested by{" "}
                      {request.user.name} &middot;{" "}
                      {formatDate(request.createdAt)}
                    </p>
                  </div>
                  <Badge variant={getStatusBadgeVariant(request.status)}>
                    {request.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
