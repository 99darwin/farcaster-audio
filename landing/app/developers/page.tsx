import type { Metadata } from "next";
import { DeveloperDashboard } from "@/components/developer/developer-dashboard";

export const metadata: Metadata = {
  title: "Developers | Juke",
  description:
    "Create Juke developer apps and API keys for custom SDK and server integrations.",
};

type DevelopersPageProps = {
  searchParams?: Promise<{ status?: string }>;
};

export default async function DevelopersPage({ searchParams }: DevelopersPageProps) {
  const params = await searchParams;
  const status = process.env.NODE_ENV === "production" ? undefined : params?.status;
  const previewStatus =
    status === "none" ||
    status === "pending" ||
    status === "approved" ||
    status === "suspended"
      ? status
      : null;

  return <DeveloperDashboard initialPreviewStatus={previewStatus} />;
}
