import type { Metadata } from "next";
import { DeveloperAdminDashboard } from "@/components/developer/developer-admin-dashboard";
import type { DeveloperAccessUser } from "@/lib/developer-api";

export const metadata: Metadata = {
  title: "Developer Admin | Juke",
  description: "Approve and manage Juke developer API access.",
};

type DeveloperAdminPageProps = {
  searchParams?: Promise<{ mock?: string }>;
};

const mockUsers: DeveloperAccessUser[] = [
  {
    fid: 12345,
    username: "builder",
    displayName: "Juke Builder",
    developerAccessStatus: "pending",
    application: {
      projectName: "Listening Bar",
      websiteUrl: "https://example.com",
      useCase: "We want to host Juke spaces inside a community site.",
      status: "pending",
      createdAt: "2026-05-11T12:00:00.000Z",
    },
  },
  {
    fid: 67890,
    username: "studio",
    displayName: "Studio Team",
    developerAccessStatus: "approved",
    application: {
      projectName: "Creator Studio",
      websiteUrl: "https://studio.example.com",
      useCase: "Create scheduled rooms from our backend and embed them in event pages.",
      status: "approved",
      createdAt: "2026-05-10T18:30:00.000Z",
    },
  },
];

export default async function DeveloperAdminPage({
  searchParams,
}: DeveloperAdminPageProps) {
  const params = await searchParams;
  const enableMock = process.env.NODE_ENV !== "production" && params?.mock === "1";

  return <DeveloperAdminDashboard mockUsers={enableMock ? mockUsers : undefined} />;
}
