import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/sidebar";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await auth();
  if (!userId) redirect("/login");

  return (
    <div className="flex min-h-screen bg-apex-navy">
      <Sidebar />
      <main className="flex-1 p-6 lg:p-8 overflow-x-hidden overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
